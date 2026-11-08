// dsh-plugin-wechat —— 宿主半：把「微信桥接」暴露成一组同源 HTTP 接口。
//
// 设计边界（照 SurfCore 的规矩）：
//   · 只接受回环 + 同源写请求；写操作必须是 application/json；
//   · 不代登录微信、不打包任何微信运行时，只调用用户自己跑起来的 adapter/bridge；
//   · preset 必须显式存在（桥接侧 fail-closed），本插件不碰 agent 的工具面。
//
// 配置：~/.dsh/wechat/config.json

import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-wechat';
export const inject = ['webServer'];

const API_PREFIX = '/dsh-wechat/api';
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CONFIG_DIR = path.join(HOME, 'wechat');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// 插件自带运行时：<插件根>/runtime/wechat-bridge
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_BRIDGE = path.join(PLUGIN_ROOT, 'runtime', 'wechat-bridge');

const DEFAULT_CONFIG = {
  bridgeDir: RUNTIME_BRIDGE,
  // local：微信和适配层都在本机；vm：微信+适配层在 Hyper-V 虚拟机里
  mode: 'local',
  vm: { name: 'dsh-wechat', provider: 'hyperv', port: 8823, stopOnSwitchBack: false },
  adapter: { baseUrl: 'http://127.0.0.1:8823', account: '', host: '127.0.0.1', token: '' },
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

  // ── 虚拟机（Hyper-V）：微信+适配层搬进去，主机只留桥接 ──
  function psJson(script, timeout = 60000) {
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (error) { resolve({ ok: false, error: String(stderr || error.message).trim().slice(0, 400) }); return; }
        try { resolve({ ok: true, data: JSON.parse(String(stdout).trim()) }); } catch { resolve({ ok: false, error: String(stdout).trim().slice(0, 400) }); }
      });
    });
  }

  function vmName() { return String(readConfig().vm?.name || '').trim(); }
  function sqlName() { return vmName().replace(/'/g, "''"); }

  async function vmStatus() {
    const cfg = readConfig();
    const name = vmName();
    if (!name) return { ok: false, mode: cfg.mode, error: '没有配置虚拟机名称' };
    const script = `$ErrorActionPreference='Stop'; $vm = Get-VM -Name '${sqlName()}'; $ip = (Get-VMNetworkAdapter -VMName '${sqlName()}').IPAddresses | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | Select-Object -First 1; [pscustomobject]@{ state = [string]$vm.State; ip = $ip } | ConvertTo-Json -Compress`;
    const r = await psJson(script);
    if (!r.ok) {
      const hint = /权限|denied|authorization/i.test(r.error)
        ? '需要管理员权限：把当前账号加入「Hyper-V Administrators」组（需重新登录），或用管理员身份运行 DSH'
        : '';
      return { ok: false, mode: cfg.mode, name, error: r.error, hint };
    }
    return { ok: true, mode: cfg.mode, name, stopOnSwitchBack: cfg.vm?.stopOnSwitchBack === true, status: r.data };
  }

  async function applyRemoteAdapter(baseUrl, tokenOverride) {
    const cfg = readConfig();
    const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
    let bridgeCfg = {};
    try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = {}; }
    bridgeCfg.adapter = { ...(bridgeCfg.adapter ?? {}), baseUrl, token: tokenOverride ?? (cfg.adapter.token || '') };
    fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
    fs.writeFileSync(bridgeFile, JSON.stringify(bridgeCfg, null, 2), 'utf8');
  }

  async function vmStart() {
    const cfg = readConfig();
    const name = vmName();
    if (!name) return { ok: false, error: '没有配置虚拟机名称' };
    const cur = await vmStatus();
    if (!cur.ok) return cur;
    if (String(cur.status?.state ?? '') !== 'Running') {
      const r = await psJson(`Start-VM -Name '${sqlName()}'; 'started'`);
      if (!r.ok) return { ok: false, error: r.error };
    }
    const port = Number(cfg.vm?.port || cfg.adapter.port || 8823);
    let ip = '';
    for (let i = 0; i < 40; i += 1) {
      const s = await vmStatus();
      ip = String(s?.status?.ip ?? '');
      if (s?.status?.state === 'Running' && ip) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!ip) return { ok: false, error: '虚拟机起来了，但 2 分钟内没拿到 IP（检查集成服务与网络）' };
    await applyRemoteAdapter(`http://${ip}:${port}`);
    return { ok: true, ip, baseUrl: `http://${ip}:${port}` };
  }

  async function vmStop(force = false) {
    const r = await psJson(`Stop-VM -Name '${sqlName()}'${force ? ' -TurnOff' : ''}; 'stopped'`);
    return r;
  }

  /** 停掉本机适配层（只杀 adapter，不动桥接）；切模式时用。 */
  async function stopLocalAdapter() {
    const cfg = readConfig();
    const pids = readPids();
    const port = Number(cfg.adapter.port || 8823);
    if (!pids.adapter) pids.adapter = pidOnPort(port);
    const killed = [];
    if (pids.adapter && pidAlive(pids.adapter)) {
      const { spawn } = await import('node:child_process');
      spawn('taskkill', ['/PID', String(pids.adapter), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      killed.push(pids.adapter);
    }
    delete pids.adapter;
    writePids(pids);
    return killed;
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
    let remote = null;
    if (cfg.mode === 'vm') {
      remote = await vmStart();
      if (!remote.ok) return { ok: false, mode: 'vm', error: remote.error, hint: remote.hint };
      started.push('vm');
    }
    let base = String(cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
    if (remote?.baseUrl) base = remote.baseUrl;
    let alive = false;
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); alive = r.ok; } catch { alive = false; }
    if (!remote && !alive) {
      const py = path.join(adapterDir, '.venv', 'Scripts', 'python.exe');
      if (!fs.existsSync(py)) return { ok: false, error: `找不到 Python 虚拟环境：${py}` };
      let port = '8823';
      try { port = new URL(base).port || '8823'; } catch { /* 默认 */ }
      const account = cfg.adapter.account ? ['--account', String(cfg.adapter.account)] : [];
      const host = String(cfg.adapter.host || '127.0.0.1');
      const token = String(cfg.adapter.token || '');
      const out = fs.openSync(path.join(dir, 'logs', 'adapter.log'), 'a');
      const child = spawn(py, ['adapter.py', ...account, '--host', host, '--port', port, '--token', token, '--allow-send'], {
        cwd: adapterDir, detached: true, windowsHide: true, stdio: ['ignore', out, out],
      });
      child.unref();
      pids.adapter = child.pid;
      started.push('adapter');
    }
    if (!pidAlive(pids.bridge)) {
      // 本机模式：把桥接指回回环，避免上次远端测试残留的 IP/token 让桥接连不上
      if (!remote) {
        const port = Number(cfg.adapter.port || 8823);
        await applyRemoteAdapter(`http://127.0.0.1:${port}`, '');
      }
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

  const memoryFile = () => path.join(readConfig().bridgeDir, 'memory.json');

  function readMemoryData() {
    try { return JSON.parse(fs.readFileSync(memoryFile(), 'utf8')); } catch { return { chats: {} }; }
  }
  function writeMemoryData(data) {
    const file = memoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }
  function memorySummary(limit = 50) {
    const data = readMemoryData();
    const now = Date.now();
    const chats = Object.entries(data?.chats ?? {}).map(([key, rows]) => {
      const list = Array.isArray(rows) ? rows : [];
      const items = list
        .map((r) => ({
          text: String(r?.text ?? ''),
          ts: Number(r?.ts ?? 0),
          score: Number(r?.score ?? 1) * Math.pow(0.5, (now - Number(r?.ts ?? now)) / (14 * 86400000)),
        }))
        .filter((r) => r.text)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({ ...r, score: Number(r.score.toFixed(3)), days: Math.floor((now - r.ts) / 86400000) }));
      return { key, count: list.length, items };
    }).sort((a, b) => b.count - a.count);
    return { ok: true, chats };
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
      if (p === `${API_PREFIX}/vm/status` && req.method === 'GET') { json(res, 200, await vmStatus()); return; }
      if (p === `${API_PREFIX}/vm/start` && isWrite) { json(res, 200, await vmStart()); return; }
      if (p === `${API_PREFIX}/vm/stop` && isWrite) {
        const body = JSON.parse((await readBody(req)) || '{}');
        json(res, 200, await vmStop(Boolean(body.force)));
        return;
      }

      if (p === `${API_PREFIX}/config` && isWrite) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const cfg = readConfig();
        const prevMode = cfg.mode;
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
        if (body?.mode === 'local' || body?.mode === 'vm') cfg.mode = body.mode;
        if (typeof body?.vmName === 'string' && body.vmName.trim()) cfg.vm = { ...(cfg.vm ?? {}), name: body.vmName.trim() };
        if (typeof body?.adapterHost === 'string') cfg.adapter.host = body.adapterHost.trim();
        if (typeof body?.adapterToken === 'string') cfg.adapter.token = body.adapterToken.trim();
        if (typeof body?.vmStopOnSwitchBack === 'boolean') {
          cfg.vm = { ...(cfg.vm ?? {}), stopOnSwitchBack: body.vmStopOnSwitchBack };
        }
        if (body?.voice && typeof body.voice === 'object') {
          bridgeCfg.voice = { ...(bridgeCfg.voice ?? {}), ...body.voice };
        }
        if (typeof body?.bridgeDir === 'string' && body.bridgeDir.trim()) cfg.bridgeDir = body.bridgeDir.trim();
        fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
        fs.writeFileSync(bridgeFile, JSON.stringify(bridgeCfg, null, 2), 'utf8');
        writeConfig(cfg);
        if (cfg.mode !== prevMode) {
          const stopped = await stopLocalAdapter();
          let vmStopped = null;
          if (prevMode === 'vm' && cfg.mode === 'local' && cfg.vm?.stopOnSwitchBack) {
            vmStopped = await vmStop(false);
          }
          json(res, 200, { ok: true, config: bridgeCfg, mode: cfg.mode, stopped, vmStopped });
          return;
        }
        json(res, 200, { ok: true, config: bridgeCfg });
        return;
      }

      if (p === `${API_PREFIX}/voice-clone` && isWrite) {
        const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}');
        const cfg = readConfig();
        const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
        let bridgeCfg = {};
        try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = {}; }
        const base = String(bridgeCfg?.adapter?.baseUrl ?? cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
        const voice = bridgeCfg?.voice ?? {};
        const raw = String(body?.dataBase64 ?? '');
        if (!raw) { json(res, 400, { ok: false, error: '缺少音频数据' }); return; }
        const tmp = path.join(os.tmpdir(), `wx-clone-${Date.now()}${path.extname(String(body?.fileName ?? '.mp3')) || '.mp3'}`);
        fs.writeFileSync(tmp, Buffer.from(raw, 'base64'));
        try {
          const r = await fetch(`${base}/voice-clone`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path: tmp,
              voiceId: String(body?.voiceId ?? ''),
              apiKey: String(voice.apiKey ?? ''),
              baseUrl: String(voice.baseUrl ?? 'https://api.minimaxi.com'),
            }),
          });
          const payload = await r.json();
          if (payload?.ok && payload.voice_id) {
            bridgeCfg.voice = { ...voice, voiceId: payload.voice_id };
            fs.writeFileSync(bridgeFile, JSON.stringify(bridgeCfg, null, 2), 'utf8');
          }
          json(res, 200, payload);
        } catch (error) {
          json(res, 200, { ok: false, error: `克隆失败：${String(error?.message ?? error)}` });
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        }
        return;
      }

      if (p === `${API_PREFIX}/voice-options` && req.method === 'GET') {
        const cfg = readConfig();
        const bridgeFile = path.join(cfg.bridgeDir, 'config.json');
        let bridgeCfg = {};
        try { bridgeCfg = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { bridgeCfg = {}; }
        const base = String(bridgeCfg?.adapter?.baseUrl ?? cfg.adapter.baseUrl ?? '').replace(/\/+$/, '');
        try {
          const r = await fetch(`${base}/voice-options`, { signal: AbortSignal.timeout(8000) });
          json(res, 200, await r.json());
        } catch (error) {
          json(res, 200, { ok: false, error: `适配层没响应：${String(error?.message ?? error)}` });
        }
        return;
      }

      if (p === `${API_PREFIX}/memory` && req.method === 'GET') {
        json(res, 200, memorySummary());
        return;
      }
      if (p === `${API_PREFIX}/memory/delete` && isWrite) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const data = readMemoryData();
        const key = String(body.chat ?? '');
        const rows = Array.isArray(data?.chats?.[key]) ? data.chats[key] : [];
        if (body.all === true) delete data.chats[key];
        else data.chats[key] = rows.filter((r) => String(r?.text ?? '') !== String(body.text ?? ''));
        writeMemoryData(data);
        json(res, 200, { ok: true, ...memorySummary() });
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
