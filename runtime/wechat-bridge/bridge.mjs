// SurfCore 微信桥接（M6）：微信 → DSH 会话 → 微信回复。
//
//   微信 ──UIA/DB──> wechat-adapter(:8823) ──HTTP──> 本进程 ──JSON-RPC──> DSH 会话(wechat-chat preset)
//
// 用法：
//   node bridge.mjs             # 真跑（会真的把回复发到微信）
//   node bridge.mjs --dry-run   # 只打印将要投喂的 prompt，不建会话、不发送
//
// 设计要点：
//   · 复用 SurfCore 的 dsh-client / dsh-port（MIT），不自己造 RPC；
//   · preset 必须显式存在（fail-closed）：拿不到就拒绝建会话，绝不回退 standard；
//   · 白名单为空 = 谁都不回（与 QQ 版语义一致）；
//   · 回复走后台上行通道（不抢焦点），发送失败只记日志，不重试轰炸。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './lib/dsh-client.js';
import { discoverDshBaseUrl } from './lib/dsh-port.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'config.json');
const STATE_FILE = path.join(HERE, 'state.json');
const dryRun = process.argv.includes('--dry-run');

// ---------------- 单实例锁（防止面板/脚本重复拉起，两个桥接抢同一个游标）----------------
const LOCK_PORT = 47822;
let lockServer = null;
function acquireLock() {
  return new Promise((resolve) => {
    lockServer = net.createServer();
    lockServer.once('error', () => resolve(false));
    lockServer.listen(LOCK_PORT, '127.0.0.1', () => resolve(true));
  });
}

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  // 首次运行没有 config.json：用默认值并落盘，用户的配置在面板里改
  cfg = {
    adapter: { baseUrl: 'http://127.0.0.1:8823', account: '', port: 8823, token: '' },
    dsh: { baseUrl: '', authToken: '', agentPreset: 'wechat-chat', workspaceTitle: '微信聊天', sessionCwd: '' },
    allow: { groups: [], private: [] },
    botAliases: [],
    pollMs: 3000,
    replyTimeoutMs: 120000,
    maxReplyChars: 600,
    voice: { enabled: true, provider: 'minimax', apiKey: '', model: 'speech-02-hd', voiceId: 'female-tianmei', baseUrl: 'https://api.minimaxi.com', maxChars: 60, minIntervalMs: 90000, cooldownMs: 300000, hotkey: 'ctrl+tab' },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
cfg.adapter ??= { baseUrl: 'http://127.0.0.1:8823' };
cfg.allow ??= { groups: [], private: [] };
cfg.botAliases ??= [];
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}
const state = loadState();
state.cursors ??= {};
state.sessions ??= {};

// ---------------- 记忆（会衰减；人格统一由 dsh-agent-md 注入，桥接不再管）----------------
const MEMORY_FILE = path.join(HERE, 'memory.json');
const MEMORY_HALF_LIFE_DAYS = 14;

function readMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch { return { chats: {} }; }
}

/** 按半衰期打分，取相关性最高（最近/最常被强化）的若干条。 */
function memoryBlock(chatKey, limit = 10) {
  const mem = readMemory();
  const rows = Array.isArray(mem?.chats?.[chatKey]) ? mem.chats[chatKey] : [];
  const now = Date.now();
  return rows
    .map((r) => ({
      text: String(r.text ?? '').slice(0, 200),
      score: Number(r.score ?? 1) * Math.pow(0.5, (now - Number(r.ts ?? now)) / (MEMORY_HALF_LIFE_DAYS * 86400000)),
    }))
    .filter((r) => r.text && r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => `- ${r.text}`);
}

function remember(chatKey, lines) {
  if (!lines?.length) return 0;
  const mem = readMemory();
  mem.chats ??= {};
  const arr = Array.isArray(mem.chats[chatKey]) ? mem.chats[chatKey] : [];
  const now = Date.now();
  let added = 0;
  for (const raw of lines) {
    const text = String(raw ?? '').trim().slice(0, 200);
    if (!text) continue;
    if (arr.some((r) => String(r.text ?? '').trim() === text)) continue;
    arr.push({ text, ts: now, score: 1 });
    added += 1;
  }
  mem.chats[chatKey] = arr.slice(-200);
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf8');
  return added;
}

/** 模型用 `[记忆] 内容` 的行来记账；这些行不会发到微信。 */
const MEMES_FILE = path.join(HERE, 'memes.md');
const MEMES_LEARNED = path.join(HERE, 'memes.learned.json');
const MEMES_LIMIT = 4000;

/** 梗词典：静态清单 + 群里学到的（模型用 `[梗] 名字=意思` 记账）。 */
function memesBlock() {
  let text = '';
  try { text = fs.readFileSync(MEMES_FILE, 'utf8').trim(); } catch { text = ''; }
  let learned = [];
  try { learned = JSON.parse(fs.readFileSync(MEMES_LEARNED, 'utf8')); } catch { learned = []; }
  const lines = (Array.isArray(learned) ? learned : []).slice(-30).map((m) => `- ${m.term}：${m.meaning}`);
  const parts = [];
  if (text) parts.push(text.slice(0, MEMES_LIMIT));
  if (lines.length) parts.push('## 群里学到的\n' + lines.join('\n'));
  return parts.join('\n');
}

function learnMeme(entry) {
  const raw = String(entry ?? '').trim();
  const m = raw.match(/^(.{1,30}?)\s*[=:：]\s*(.+)$/);
  if (!m) return 0;
  const term = m[1].trim();
  const meaning = m[2].trim().slice(0, 120);
  if (!term || !meaning) return 0;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(MEMES_LEARNED, 'utf8')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  if (arr.some((x) => x.term === term)) return 0;
  arr.push({ term, meaning, ts: Date.now() });
  fs.writeFileSync(MEMES_LEARNED, JSON.stringify(arr.slice(-200), null, 2), 'utf8');
  return 1;
}

function splitMemoryLines(text) {
  const keep = [];
  const mem = [];
  const memes = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*[\[【]记忆[\]】]\s*(.+)$/);
    const g = line.match(/^\s*[\[【]梗[\]】]\s*(.+)$/);
    if (m) mem.push(m[1]);
    else if (g) memes.push(g[1]);
    else keep.push(line);
  }
  return { text: keep.join('\n').trim(), mem, memes };
}

// ---------------- 微信适配层 ----------------
// ---------------- 表情包（动态读 dsh-meme 的 index.db；node:sqlite 内置）----------------
import { DatabaseSync } from 'node:sqlite';

const STICKERS_FILE = path.join(HERE, 'stickers.json');
const dbCache = new Map();
let stickerRows = [];
let stickerScanAt = 0;

function candidatePackRoots() {
  const roots = [path.join(os.homedir(), '.dsh', 'meme-packs')];
  const profiles = path.join(os.homedir(), '.dsh', 'profiles');
  try {
    for (const name of fs.readdirSync(profiles)) {
      roots.push(path.join(profiles, name, 'node_modules', 'dsh-meme', 'memes'));
    }
  } catch { /* 没有 profiles 目录就算了 */ }
  return roots;
}

function readPackDb(dbPath) {
  const stat = fs.statSync(dbPath);
  const hit = dbCache.get(dbPath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.rows;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const packDir = path.dirname(dbPath);
  const rows = db.prepare('SELECT path, tag, caption, keywords, file_name FROM memes').all()
    .map((r) => ({
      tag: String(r.tag ?? ''),
      caption: String(r.caption || r.file_name || r.path || ''),
      keywords: String(r.keywords ?? ''),
      path: path.isAbsolute(r.path) ? r.path : path.join(packDir, r.path),
    }))
    .filter((r) => { try { return fs.existsSync(r.path); } catch { return false; } });
  db.close();
  dbCache.set(dbPath, { mtimeMs: stat.mtimeMs, rows });
  return rows;
}

/** 每 5 秒最多扫一次目录；只有 index.db 的 mtime 变了才重读。 */
function loadStickers(force = false) {
  const now = Date.now();
  if (!force && now - stickerScanAt < 5000) return stickerRows;
  stickerScanAt = now;
  const rows = [];
  for (const root of candidatePackRoots()) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { dirs = []; }
    for (const dir of dirs) {
      const dbPath = path.join(root, dir, 'index.db');
      if (!fs.existsSync(dbPath)) continue;
      try { rows.push(...readPackDb(dbPath)); } catch { /* 库坏了就跳过 */ }
    }
  }
  stickerRows = rows;
  return rows;
}

function stickerBlock() {
  const list = loadStickers();
  if (!list.length) return '';
  return list.map((s) => `- ${s.tag}｜${s.caption}`).join('\n');
}

function pickSticker(desc) {
  const list = loadStickers();
  const d = String(desc ?? '').trim();
  if (!d || !list.length) return null;
  const low = d.toLowerCase();
  return list.find((s) => s.caption === d)
    ?? list.find((s) => s.caption.includes(d) || d.includes(s.caption))
    ?? list.find((s) => s.tag.toLowerCase() === low)
    ?? list.find((s) => low.includes(s.tag.toLowerCase()) || s.tag.toLowerCase().includes(low))
    ?? list.find((s) => s.keywords.toLowerCase().includes(low))
    ?? null;
}

/** `[表情: 描述]` 单独成行，剥离出来，不发给微信。 */
function splitStickers(text) {
  const keep = [];
  const picks = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*[\[【]表情\s*[:：]\s*(.+?)[\]】]\s*$/);
    if (m) picks.push(m[1].trim());
    else keep.push(line);
  }
  return { text: keep.join('\n').trim(), picks };
}

const adapterBase = cfg.adapter.baseUrl.replace(/\/+$/, '');
// 远端 adapter（虚拟机）需要令牌；本机回环时留空即可
const adapterHeaders = cfg.adapter.token ? { authorization: `Bearer ${cfg.adapter.token}` } : {};
// ---------------- 语音发送（策略学鲸鲸，TTS 走云端 edge-tts）----------------
const VOICE = {
  enabled: cfg.voice?.enabled !== false,
  voice: cfg.voice?.voice ?? 'zh-CN-XiaoyiNeural',
  maxChars: Number(cfg.voice?.maxChars ?? 60),
  minIntervalMs: Number(cfg.voice?.minIntervalMs ?? 90000),
  cooldownMs: Number(cfg.voice?.cooldownMs ?? 300000),
  provider: cfg.voice?.provider ?? 'minimax',
  apiKey: cfg.voice?.apiKey ?? '',
  model: cfg.voice?.model ?? 'speech-02-hd',
  voiceId: cfg.voice?.voiceId ?? 'male-qn-qingse',
  baseUrl: cfg.voice?.baseUrl ?? 'https://api.minimaxi.com',
  hotkey: cfg.voice?.hotkey ?? 'ctrl+tab',
};
const VOICE_REQ = /(?:发|来|回)(?:我)?(?:一?[条个段句])?(?:语音|音频)|用语音(?:回|说)|语音(?:回我|回复|说一句)/;
const VOICE_NEG = /不要|别|不用|不想|不能|怎么|如何|别人说|关闭|取消|[「『"“][^」』"”]*[」』"”]/;
const voiceState = { lastAt: 0, failures: 0, cooldownUntil: 0 };

function wantsVoice(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 500) return false;
  if (VOICE_NEG.test(t)) return false;
  return VOICE_REQ.test(t);
}

function splitVoiceLine(text) {
  const keep = [];
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*[\[【]语音\s*[:：]\s*(.+?)[\]】]\s*$/);
    if (m) lines.push(m[1].trim());
    else keep.push(line);
  }
  return { text: keep.join('\n').trim(), lines };
}

function voiceAllowedNow() {
  const now = Date.now();
  if (now < voiceState.cooldownUntil) return false;
  return now - voiceState.lastAt >= VOICE.minIntervalMs;
}

async function sendVoice(text, chatNick) {
  const content = String(text ?? '').trim().slice(0, VOICE.maxChars);
  if (!content || !VOICE.enabled) return { ok: false, reason: 'disabled' };
  if (!voiceAllowedNow()) return { ok: false, reason: 'throttled' };
  try {
    const ttsRes = await fetch(`${adapterBase}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adapterHeaders },
      body: JSON.stringify({
        text: content,
        provider: VOICE.provider,
        voice: VOICE.voice,
        apiKey: VOICE.apiKey,
        model: VOICE.model,
        voiceId: VOICE.voiceId,
        baseUrl: VOICE.baseUrl,
      }),
    });
    const tts = await ttsRes.json();
    if (!tts?.ok) throw new Error(tts?.error ?? 'tts failed');
    const sendRes = await fetch(`${adapterBase}/send-voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adapterHeaders },
      body: JSON.stringify({ chat: chatNick, path: tts.path, hotkey: VOICE.hotkey }),
    });
    const sent = await sendRes.json();
    voiceState.lastAt = Date.now();
    if (!sent?.ok) throw new Error('send-file failed');
    voiceState.failures = 0;
    log(`[voice] ${chatNick}: ${content.slice(0, 24)}… (${tts.bytes}B cached=${tts.cached}) -> ok`);
    return { ok: true };
  } catch (error) {
    voiceState.failures += 1;
    if (voiceState.failures >= 2) {
      voiceState.cooldownUntil = Date.now() + VOICE.cooldownMs;
      log(`[voice] 连续失败 ${voiceState.failures} 次，冷却 ${Math.round(VOICE.cooldownMs / 60000)} 分钟`);
    }
    log('[voice] 失败：', error?.message ?? error);
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

async function adapterGet(p) {
  const res = await fetch(`${adapterBase}${p}`, { signal: AbortSignal.timeout(20000), headers: adapterHeaders });
  if (!res.ok) throw new Error(`adapter ${p} HTTP ${res.status}`);
  return res.json();
}
async function adapterSend(chat, text) {
  const res = await fetch(`${adapterBase}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adapterHeaders },
    body: JSON.stringify({ chat, text }),
    signal: AbortSignal.timeout(120000),
  });
  return res.json();
}

// ---------------- DSH ----------------
let api = null;
let apiBase = '';
let selfAccount = '';

async function connectDsh() {
  const base = (cfg.dsh.baseUrl || (await discoverDshBaseUrl()) || '').replace(/\/+$/, '');
  if (!base) throw new Error('找不到正在运行的 DSH；请在 config.json 里填 dsh.baseUrl');
  apiBase = base;
  api = new NodeApiClient(base, 30000, { token: cfg.dsh.authToken || discoverDshLaunchToken() || '', tokenExplicit: false });
  const { presets } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
  const ids = (presets ?? []).map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean);
  if (!ids.includes(cfg.dsh.agentPreset)) {
    throw new Error(`preset "${cfg.dsh.agentPreset}" 不在 DSH 可用清单里（${ids.join(', ') || '空'}）—— 拒绝启动（fail-closed）`);
  }
  log(`[dsh] ${base} preset=${cfg.dsh.agentPreset} 可用`);
}

/**
 * DSH 桌面端每次重启都会换端口（实测 60931 → 53003）。
 * 桥接只在启动时发现一次端口的话，DSH 一重启所有 prompt 都会静默失败。
 * 这里在「连接类错误」时重新发现端口并重试一次。
 */
async function withApi(fn) {
  if (!api) await connectDsh();
  try {
    return await fn(api);
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/fetch failed|ECONNREFUSED|ECONNRESET|401|404|invalid session|not-found|timed? ?out/i.test(msg)) {
      log('[dsh] 调用失败，重新发现 DSH 端口后重试：', msg);
      api = null;
      await connectDsh();
      return fn(api);
    }
    throw error;
  }
}

async function ensureWorkspace() {
  if (state.workspaceId) return state.workspaceId;
  const dir = cfg.dsh.sessionCwd || path.join(HERE, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await withApi((a) => a.workspace.create({ path: dir })), 'workspace.create');
  const id = ws.workspace.workspaceId;
  if (ws.created && cfg.dsh.workspaceTitle) {
    try { await withApi((a) => a.workspace.rename({ workspaceId: id, title: cfg.dsh.workspaceTitle })); } catch { /* 非致命 */ }
  }
  state.workspaceId = id;
  saveState(state);
  return id;
}

async function ensureSession(chatKey) {
  const existing = state.sessions[chatKey];
  if (existing) {
    // 进程重启/DSH 重连后必须重新 follow，否则收不到 turn/end —— 表现是「prompt 发出去但永远没回复」。
    try { api.events.follow(existing); } catch { /* 事件流会自己重连 */ }
    return existing;
  }
  const workspaceId = await ensureWorkspace();
  let value;
  try {
    value = unwrap(await withApi((a) => a.sessions.create({ workspaceId, agentPreset: cfg.dsh.agentPreset })), 'session.create');
  } catch (error) {
    // 旧会话/旧 workspace 在 DSH 重启后可能已不存在：清掉映射重试一次
    delete state.workspaceId;
    delete state.sessions[chatKey];
    saveState(state);
    const wsId = await ensureWorkspace();
    value = unwrap(await withApi((a) => a.sessions.create({ workspaceId: wsId, agentPreset: cfg.dsh.agentPreset })), 'session.create(retry)');
  }
  const sessionId = value.sessionId;
  try { api.events.follow(sessionId); } catch { /* 事件流断了会重连 */ }
  state.sessions[chatKey] = sessionId;
  saveState(state);
  log(`[session] ${chatKey} -> ${sessionId}`);
  return sessionId;
}

// ---------------- 事件流 / 回合收集 ----------------
const waiters = new Map(); // sessionId -> { collector, resolve, timer }

function onSessionEvent(sessionId, event) {
  const w = waiters.get(sessionId);
  if (!w) return;
  const ended = w.collector.push(event);
  if (ended) w.done({ ok: true, text: String(ended.text ?? '').trim() });
}

async function pumpEvents() {
  for (;;) {
    try {
      if (!api) await connectDsh();
      const stream = api.events.mux({});
      for await (const envelope of stream) {
        const frame = envelope?.payload;
        if (frame?.type === 'session/event') onSessionEvent(frame.sessionId, frame.event);
      }
    } catch (error) {
      log('[events] 断开，3s 后重连：', error?.message ?? error);
      api = null; // 断流往往意味着宿主重启换了端口
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function ask(sessionId, promptText) {
  return new Promise((resolve) => {
    const collector = createTurnCollector({ tolerantStart: true });
    const done = (result) => {
      clearTimeout(timer);
      waiters.delete(sessionId);
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), cfg.replyTimeoutMs ?? 120000);
    waiters.set(sessionId, { collector, done });
    withApi((a) => a.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    })).catch((error) => done({ ok: false, error: String(error?.message ?? error) }));
  });
}

// ---------------- 业务 ----------------
function allowed(chat) {
  const key = chat.nick || chat.username;
  const list = chat.kind === 'group' ? (cfg.allow?.groups ?? []) : (cfg.allow?.private ?? []);
  return list.some((x) => x === key || x === chat.username);
}

/** 群里是否在叫我：`@别名` 或正文里直接出现别名（不要求 @）。 */
const ALIASES = cfg.botAliases ?? ['鲸鲸'];
function mentionsMe(text) {
  const t = String(text ?? '');
  return ALIASES.some((a) => a && (t.includes(`@${a}`) || t.includes(a)));
}

function buildPrompt(chat, focus, recent, voiceWanted = false) {
  const label = chat.kind === 'group' ? `群「${chat.nick}」` : `和「${chat.nick}」的私聊`;
  const lines = recent.map((m) => {
    const who = m.from_name || m.from || '某人';
    const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
    const mark = m.__focus ? '★ ' : '  ';
    return `${mark}${who}：${text}`;
  });
  const head = chat.kind === 'group'
    ? `【微信群】${label} 最近的对话（★ 是叫你/提到你的那几条）：`
    : `【微信新消息】${label} 有 ${focus.length} 条新消息：`;
  const memory = memoryBlock(chat.username);
  const memes = memesBlock();
  return [
    memes ? '【群里的梗】\n' + memes + '\n' : '',
    stickerBlock() ? '【表情包】（想发就另起一行写 `[表情: 描述]`，描述必须抄下面原文，一条最多一张）\n' + stickerBlock() + '\n' : '',
    memory.length ? '【你记得的事】\n' + memory.join('\n') + '\n' : '',
    head,
    ...lines,
    '',
    '请只回应 ★ 标记的消息（私聊就是全部）。只输出要发到微信里的话本身：不要加引号、不要加“回复：”前缀、不要描述你的动作。',
    '如果这轮出现了值得长期记住的事（对方的名字/偏好/约定/重要事实），在回复末尾另起一行写 `[记忆] 内容`（一行一条）。这些行不会发到微信。',
    '你有语音能力：对方明确要求语音时，桥接会把你的回复合成语音发出去。不要说自己不能发语音、也不要说"发不了"。',
    voiceWanted ? '对方这轮要语音：你的回复会被直接读出来，写成口语化的一两句，不要 Markdown、不要列表。' : '',
    '群聊里遇到不认识的梗，可以写 `[梗] 梗名=什么意思` 来记住它（同样不会发出去）。认出来的梗顺着接就好，别解释梗本身。',
    chat.kind === 'group' ? '如果 ★ 的消息只是随口一提、不需要你说话，就只输出 [SILENT]。' : '',
  ].filter(Boolean).join('\n');
}

function cleanReply(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^(回复|回答)[:：]\s*/i, '');
  t = t.replace(/^["“](.*)["”]$/s, '$1');
  // 微信输入框是单行语义：换行会被 Qt 当成 Enter（可能提前发送），必须压成一行
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
  const max = cfg.maxReplyChars ?? 600;
  if (t.length > max) t = `${t.slice(0, max)}…`;
  return t.trim();
}

let running = true;

async function tick() {
  const health = await adapterGet('/health');
  selfAccount = health.account || '';
  const { sessions = [] } = await adapterGet('/sessions?limit=50');

  for (const chat of sessions) {
    if (!chat?.username) continue;
    if (!allowed(chat)) continue;
    const after = state.cursors[chat.username] ?? 0;
    const { messages = [] } = await adapterGet(
      `/messages?chat=${encodeURIComponent(chat.username)}&limit=20&after=${after}`,
    );
    if (!messages.length) continue;

    const fresh = messages.filter((m) => m.type === 'text' && m.from && m.from !== selfAccount && String(m.text ?? '').trim());
    const maxSeq = Math.max(...messages.map((m) => Number(m.seq) || 0));
    if (!fresh.length) {
      state.cursors[chat.username] = maxSeq;
      saveState(state);
      continue;
    }

    // 群聊：只回应 @ 我的消息；没被叫到就只推进游标
    let focus = fresh;
    let recent = fresh;
    if (chat.kind === 'group') {
      focus = fresh.filter((m) => mentionsMe(m.text));
      if (!focus.length) {
        state.cursors[chat.username] = maxSeq;
        saveState(state);
        continue;
      }
      const ctx = await adapterGet(`/messages?chat=${encodeURIComponent(chat.username)}&limit=12`);
      const focusSet = new Set(focus.map((m) => m.seq));
      recent = (ctx.messages ?? []).filter((m) => m.type === 'text')
        .map((m) => ({ ...m, __focus: focusSet.has(m.seq) }));
      if (!recent.length) recent = focus.map((m) => ({ ...m, __focus: true }));
    } else {
      recent = fresh.map((m) => ({ ...m, __focus: true }));
    }

    const voiceAsked = focus.some((m) => wantsVoice(m.text ?? m.content));
    const prompt = buildPrompt(chat, focus, recent, voiceAsked);
    if (dryRun) {
      log(`[dry-run] ${chat.nick}（${fresh.length} 条）\n${prompt}\n`);
      state.cursors[chat.username] = maxSeq;
      continue;
    }

    const sessionId = await ensureSession(chat.username);
    log(`[prompt] ${chat.nick} <- ${focus.length} 条…`);
    const res = await ask(sessionId, prompt);
    if (!res.ok) {
      log(`[warn] ${chat.nick} 没拿到回复（${res.error}）；游标不推进，下一轮重试`);
      // 超时通常意味着这条 session 在 DSH 侧已失效（宿主重启过）：丢掉映射，下轮重建
      if (/timeout/i.test(res.error)) {
        delete state.sessions[chat.username];
        saveState(state);
        log(`[session] ${chat.username} 映射已清除，下一轮重建`);
      }
      continue;
    }
    const { text: rawReply, mem, memes } = splitMemoryLines(res.text);
    if (mem.length) {
      const added = remember(chat.username, mem);
      log(`[memory] ${chat.nick} 记下 ${added} 条（共写入 ${mem.length} 行）`);
    }
    if (memes.length) {
      let added = 0;
      for (const entry of memes) added += learnMeme(entry);
      log(`[memes] 新学 ${added} 个梗（共 ${memes.length} 行）`);
    }
    const { text: noVoice, lines: voiceLines } = splitVoiceLine(rawReply);
    const { text: noStickers, picks } = splitStickers(noVoice);
    const reply = cleanReply(noStickers);
    const silent = !reply || /^\[?SILENT\]?$/i.test(reply);
    log(`[voice?] asked=${voiceAsked} lines=${voiceLines.length} last=${JSON.stringify(String(focus[focus.length - 1]?.text ?? '').slice(0, 40))}`);
    const voiceOnly = voiceAsked && !voiceLines.length && !silent;
    const voiceText = voiceLines[0] ?? (voiceAsked && !silent ? reply : '');
    if (silent && !picks.length && !voiceText) {
      log(`[skip] ${chat.nick} 模型选择沉默`);
      state.cursors[chat.username] = maxSeq;
      saveState(state);
      continue;
    }
    if (!silent && !voiceOnly) {
      const result = await adapterSend(chat.nick, reply);
      const detail = JSON.stringify(result?.detail ?? {}).slice(0, 220);
      log(`[send] ${chat.nick}: ${reply.slice(0, 60)}${reply.length > 60 ? '…' : ''} -> ok=${result.ok} ${result.ok ? '' : detail}`);
    }
    if (voiceText) {
      const vr = await sendVoice(voiceText, chat.nick);
      if (!vr.ok && voiceOnly && reply) {
        const result = await adapterSend(chat.nick, reply);
        log(`[voice] 回落文字 -> ok=${result.ok}`);
      }
    }
    for (const desc of picks.slice(0, 2)) {
      const hit = pickSticker(desc);
      if (!hit) { log(`[sticker] 没找到：${desc}`); continue; }
      try {
        const r = await fetch(`${adapterBase}/send-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adapterHeaders },
          body: JSON.stringify({ chat: chat.nick, path: hit.path }),
        });
        const data = await r.json();
        log(`[sticker] ${chat.nick}: ${hit.caption.slice(0, 40)} -> ok=${data.ok} ${data.ok ? '' : JSON.stringify(data).slice(0, 160)}`);
      } catch (error) {
        log('[sticker] 发送失败：', error?.message ?? error);
      }
    }
    state.cursors[chat.username] = maxSeq;
    saveState(state);
  }
}

async function main() {
  if (!(await acquireLock())) {
    log(`[boot] 已有桥接实例在跑（锁端口 ${LOCK_PORT}），本进程退出`);
    return;
  }
  log(`[boot] ${dryRun ? 'DRY-RUN' : 'LIVE'}  adapter=${adapterBase} poll=${cfg.pollMs}ms`);
  log(`[stickers] ${loadStickers(true).length} 张（index.db 动态读取）`);
  await connectDsh();
  if (!dryRun) void pumpEvents();
  for (;;) {
    if (!running) break;
    try {
      await tick();
    } catch (error) {
      log('[tick] 失败：', error?.message ?? error);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs ?? 3000));
  }
}

process.on('SIGINT', () => { running = false; log('[exit] 收到 Ctrl+C'); process.exit(0); });
await main();
