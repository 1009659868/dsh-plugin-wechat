// dsh-plugin-wechat —— 宿主半：把「微信桥接」暴露成一组同源 HTTP 接口。
//
// 设计边界（照 SurfCore 的规矩）：
//   · 只接受回环 + 同源写请求；写操作必须是 application/json；
//   · 不代登录微信、不打包任何微信运行时，只调用用户自己跑起来的 adapter/bridge；
//   · preset 必须显式存在（桥接侧 fail-closed），本插件不碰 agent 的工具面。
//
// 配置：~/.dsh/wechat/config.json

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-plugin-wechat';
export const inject = ['webServer'];

const API_PREFIX = '/dsh-wechat/api';
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CONFIG_DIR = path.join(HOME, 'wechat');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  bridgeDir: path.join(CONFIG_DIR, 'bridge'),
  adapter: { baseUrl: 'http://127.0.0.1:8823', account: '' },
  allow: { groups: [], private: [] },
  botAliases: [],
};

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      adapter: { ...DEFAULT_CONFIG.adapter, ...(raw.adapter ?? {}) },
      allow: { ...DEFAULT_CONFIG.allow, ...(raw.allow ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLoopbackReq(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sameOrigin(req) {
  const origin = String(req.headers.origin ?? '');
  if (!origin) return true; // 同源 fetch 通常不带 Origin
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function pidOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      if (cols[1] === `127.0.0.1:${port}` || cols[1] === `0.0.0.0:${port}`) return Number(cols[4]) || null;
    }
  } catch { /* 忽略 */ }
  return null;
}

export function apply(ctx) {
  const pidFile = () => path.join(readConfig().bridgeDir, '.panel-pids.json');
  const readPids = () => { try { return JSON.parse(fs.readFileSync(pidFile(), 'utf8')); } catch { return {}; } };
  const writePids = (next) => { try { fs.writeFileSync(pidFile(), JSON.stringify(next, null, 2), 'utf8'); } catch { /* 忽略 */ } };

  async function status() {
    const cfg = readConfig();
    const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
    let bridgeCfg = null;
    try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = null; }
    const base = String(bridgeCfg?.adapter?.baseUrl ?? cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
    let adapter = null;
    if (base) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        adapter = await r.json();
      } catch (error) {
        adapter = { ok: false, error: String(error?.message ?? error) };
      }
    }
    const pids = readPids();
    return {
      ok: true,
      dir: cfg.bridgeDir,
      exists: Boolean(bridgeCfg),
      config: bridgeCfg,
      adapter,
      runtime: {
        adapterPid: pids.adapter ?? null, adapterAlive: pidAlive(pids.adapter),
        bridgePid: pids.bridge ?? null, bridgeAlive: pidAlive(pids.bridge),
      },
    };
  }

  async function accounts() {
    const cfg = readConfig();
    const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
    let bridgeCfg = {};
    try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = {}; }
    const base = String(bridgeCfg?.adapter?.baseUrl ?? cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) return { ok: true, accounts: [], current: cfg.adapter.account ?? '' };
    try {
      const r = await fetch(`${base}/accounts`, { signal: AbortSignal.timeout(10000) });
      const payload = await r.json();
      return { ok: true, current: cfg.adapter.account ?? '', ...payload };
    } catch (error) {
      return { ok: false, accounts: [], current: cfg.adapter.account ?? '', error: `适配层没响应：${String(error?.message ?? error)}` };
    }
  }

  async function start() {
    const cfg = readConfig();
    const dir = cfg.bridgeDir;
    // adapter 可能和 bridge 平级、嵌在 bridge 里、或在仓库的 runtime/ 下：逐个找
    const candidates = [
      path.join(path.dirname(dir), 'wechat-adapter'),
      path.join(dir, 'wechat-adapter'),
      path.join(dir, 'runtime', 'wechat-adapter'),
    ];
    const adapterDir = candidates.find((d) => fs.existsSync(path.join(d, 'adapter.py'))) || candidates[0];
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const { spawn } = await import('node:child_process');
    const pids = readPids();
    const started = [];
    const base = String(cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
    let alive = false;
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); alive = r.ok; } catch { alive = false; }
    if (!alive) {
      const py = path.join(adapterDir, '.venv', 'Scripts', 'python.exe');
      if (!fs.existsSync(py)) return { ok: false, error: `找不到 Python 虚拟环境：${py}` };
      let port = '8823';
      try { port = new URL(base).port || '8823'; } catch { /* 默认 */ }
      const account = cfg.adapter.account ? ['--account', String(cfg.adapter.account)] : [];
      const out = fs.openSync(path.join(dir, 'logs', 'adapter.log'), 'a');
      const child = spawn(py, ['adapter.py', ...account, '--port', port, '--allow-send'], {
        cwd: adapterDir, detached: true, windowsHide: true, stdio: ['ignore', out, out],
      });
      child.unref();
      pids.adapter = child.pid;
      started.push('adapter');
    }
    if (!pidAlive(pids.bridge)) {
      const entry = path.join(dir, 'bridge.mjs');
      if (!fs.existsSync(entry)) return { ok: false, error: `找不到桥接入口：${entry}` };
      const out = fs.openSync(path.join(dir, 'logs', 'bridge.log'), 'a');
      const child = spawn(process.execPath, [entry], {
        cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.unref();
      pids.bridge = child.pid;
      started.push('bridge');
    }
    writePids(pids);
    return { ok: true, started, pids };
  }

  async function stop() {
    const cfg = readConfig();
    const pids = readPids();
    let port = 8823;
    try { port = Number(new URL(String(cfg.adapter.baseUrl)).port) || 8823; } catch { port = 8823; }
    if (!pids.adapter) pids.adapter = pidOnPort(port);
    const killed = [];
    const { spawn } = await import('node:child_process');
    for (const key of ['bridge', 'adapter']) {
      const pid = pids[key];
      if (pid && pidAlive(pid)) {
        try {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
          killed.push(key);
        } catch { /* 忽略 */ }
      }
      delete pids[key];
    }
    writePids(pids);
    return { ok: true, killed };
  }

  const handler = async (req, res) => {
    try {
      if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      const isWrite = req.method !== 'GET';
      if (isWrite && !sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }
      if (isWrite && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
        json(res, 415, { ok: false, error: '写操作必须是 application/json' });
        return;
      }

      if (p === `${API_PREFIX}/status`) { json(res, 200, await status()); return; }
      if (p === `${API_PREFIX}/accounts`) { json(res, 200, await accounts()); return; }
      if (p === `${API_PREFIX}/start`) { json(res, 200, await start()); return; }
      if (p === `${API_PREFIX}/stop`) { json(res, 200, await stop()); return; }

      if (p === `${API_PREFIX}/config` && isWrite) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const cfg = readConfig();
        const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
        let bridgeCfg = {};
        try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = {}; }
        if (body?.allow && typeof body.allow === 'object') {
          bridgeCfg.allow = {
            groups: Array.isArray(body.allow.groups) ? body.allow.groups.map(String) : (bridgeCfg.allow?.groups ?? []),
            private: Array.isArray(body.allow.private) ? body.allow.private.map(String) : (bridgeCfg.allow?.private ?? []),
          };
          cfg.allow = bridgeCfg.allow;
        }
        if (Array.isArray(body?.botAliases)) bridgeCfg.botAliases = body.botAliases.map(String);
        if (typeof body?.adapterAccount === 'string' && body.adapterAccount.trim()) {
          bridgeCfg.adapter = { ...(bridgeCfg.adapter ?? {}), account: body.adapterAccount.trim() };
          cfg.adapter.account = body.adapterAccount.trim();
        }
        if (typeof body?.bridgeDir === 'string' && body.bridgeDir.trim()) cfg.bridgeDir = body.bridgeDir.trim();
        fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
        fs.writeFileSync(bridgeFile, JSON.stringify(bridgeCfg, null, 2), 'utf8');
        writeConfig(cfg);
        json(res, 200, { ok: true, config: bridgeCfg });
        return;
      }

      json(res, 404, { ok: false, error: `未知接口：${p}` });
    } catch (error) {
      try { json(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch { /* 忽略 */ }
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'dsh-plugin-wechat: api',
  );
}

export default { name, inject, apply };
