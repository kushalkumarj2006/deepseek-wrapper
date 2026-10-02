'use strict';
require('dotenv').config();

const express     = require('express');
const compression = require('compression');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const { Worker }  = require('worker_threads');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function log(...args)  { if (DEBUG) console.log('[dbg]', ...args); }
function warn(...args) { console.warn('[warn]', ...args); }
function err(...args)  { console.error('[err]', ...args); }

const DS    = 'https://chat.deepseek.com';
const TOKEN = process.env.DS_USER_TOKEN;
const SMID  = process.env.DS_SMID_V2;
if (!TOKEN || !SMID) throw new Error('Set DS_USER_TOKEN and DS_SMID_V2 in .env');

log('TOKEN len =', TOKEN.length, '| starts with =', TOKEN.slice(0, 8));
log('SMID  len =', SMID.length,  '| starts with =', SMID.slice(0, 8));
log('DEBUG =', DEBUG);

const POW_JS   = path.join(__dirname, 'pow.js');
const CHUNK_JS = path.join(__dirname, 'chunk8138.js');
const WASM_BIN = path.join(__dirname, 'sha3.wasm');

for (const p of [POW_JS, CHUNK_JS, WASM_BIN]) {
  if (!fs.existsSync(p)) throw new Error('Missing file: ' + p);
  log('found', path.basename(p), fs.statSync(p).size, 'bytes');
}

const WORKER_BUNDLE = fs.readFileSync(POW_JS, 'utf8');
const CHUNK_BUNDLE  = fs.readFileSync(CHUNK_JS, 'utf8');
const WASM_BYTES    = fs.readFileSync(WASM_BIN);
const DEVICE_ID     = crypto.randomUUID();
log('DEVICE_ID =', DEVICE_ID);

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    log('OPTIONS', req.url, '-> 204');
    return res.status(204).end();
  }
  next();
});

app.use(compression({
  threshold: 200,
  filter: (req, res) => req.path === '/api/chat' ? false : compression.filter(req, res)
}));

app.get('/health', (_, res) => res.send('ok'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 6 }
});

const WORKER_SRC = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const workerCode = workerData.bundle;
const chunkCode  = workerData.chunk;
const wasmBuf    = Buffer.from(workerData.wasm);

const listeners = { message: [], error: [], messageerror: [] };

function resp(buf, type) {
  if (typeof Response === 'function') {
    return new Response(buf, { headers: { 'Content-Type': type } });
  }
  return { ok: true, arrayBuffer: async () =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

const fakeURL = new URL('https://chat.deepseek.com/');

const sandbox = {
  console, TextEncoder, TextDecoder,
  crypto: globalThis.crypto,
  performance: globalThis.performance || { now: () => Date.now() },
  URL, URLSearchParams, Response, Headers, Request, WebAssembly,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  fetch: async (url) => {
    const s = typeof url === 'string' ? url
            : (url && (url.href || url.url)) || String(url);
    if (s.includes('sha3_wasm_bg')) return resp(wasmBuf, 'application/wasm');
    throw new Error('Unexpected fetch in worker: ' + s);
  },
  location: fakeURL,
  document: { currentScript: { src: fakeURL.href } },
  postMessage: m => parentPort.postMessage(m),
  addEventListener:    (t, fn) => { (listeners[t] ||= []).push(fn); },
  removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
  importScripts: (url) => {
    const s = typeof url === 'string' ? url : String(url);
    if (s.includes('8138') || s.includes('static/')) {
      vm.runInContext(chunkCode, sandbox, { filename: 'chunk8138.js' });
      return;
    }
    throw new Error('Unexpected importScripts: ' + s);
  }
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
Object.defineProperty(sandbox, 'onmessage', {
  get: () => listeners.message[0],
  set: fn => { listeners.message = [fn]; },
  configurable: true
});

vm.createContext(sandbox);
try {
  vm.runInContext(workerCode, sandbox, { filename: 'pow.js' });
  parentPort.postMessage({ type: 'init-ok' });
} catch (e) {
  parentPort.postMessage({ type: 'init-error', error: e.stack || e.message });
}

parentPort.on('message', msg => {
  for (const fn of listeners.message.slice()) {
    try { fn({ data: msg }); }
    catch (e) { parentPort.postMessage({ type: 'pow-error', error: e.message }); }
  }
});
`;

const POW_QUEUE_MAX    = 32;
const POW_TASK_TIMEOUT = 30_000;

let powWorker  = spawnPowWorker();
let powCurrent = null;
const powQueue = [];

function spawnPowWorker() {
  const w = new Worker(WORKER_SRC, {
    eval: true,
    workerData: { bundle: WORKER_BUNDLE, chunk: CHUNK_BUNDLE, wasm: WASM_BYTES }
  });
  w.on('message', m => onPowMessage(w, m));
  w.on('error',   e => onPowError(w, e));
  return w;
}
function onPowMessage(w, m) {
  if (m.type === 'init-ok')    { log('pow worker init OK'); return; }
  if (m.type === 'init-error') { err('pow init error:', m.error); return; }
  if (!powCurrent) { log('pow message but no current task:', m.type); return; }
  const c = powCurrent;
  powCurrent = null;
  clearTimeout(c.timer);
  if (m.type === 'pow-answer') {
    log('pow answer:', JSON.stringify(m.answer).slice(0, 120));
    c.res(m.answer);
  } else if (m.type === 'pow-error') {
    err('pow error:', m.error);
    c.rej(new Error(m.error));
  }
  drainPowQueue();
}
function onPowError(w, e) {
  err('pow worker crashed:', e.message);
  if (powCurrent) { clearTimeout(powCurrent.timer); powCurrent.rej(e); powCurrent = null; }
  while (powQueue.length) powQueue.shift().rej(e);
  try { w.terminate(); } catch {}
  powWorker = spawnPowWorker();
}
function drainPowQueue() {
  if (powCurrent || !powQueue.length) return;
  const task = powQueue.shift();
  const timer = setTimeout(() => {
    if (powCurrent && powCurrent.challenge === task.challenge) {
      err('pow timeout — respawning');
      powCurrent = null;
      task.rej(new Error('PoW timeout'));
      try { powWorker.terminate(); } catch {}
      powWorker = spawnPowWorker();
      drainPowQueue();
    }
  }, POW_TASK_TIMEOUT);
  powCurrent = { challenge: task.challenge, res: task.res, rej: task.rej, timer };
  log('pow dispatch, queue remaining =', powQueue.length);
  powWorker.postMessage({ type: 'pow-challenge', challenge: task.challenge });
}
function solvePoW(challenge) {
  return new Promise((res, rej) => {
    if (powQueue.length >= POW_QUEUE_MAX) return rej(new Error('PoW queue full'));
    powQueue.push({ challenge, res, rej });
    drainPowQueue();
  });
}

function dsBaseHeaders(extra = {}) {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Cookie': `smidV2=${SMID}`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-client-version': '2.5.0',
    'x-device-id': DEVICE_ID,
    'x-device-model': '',
    ...extra
  };
}

async function dsJson(p, opts = {}) {
  log('DS →', opts.method || 'GET', p, opts.body ? '(body ' + opts.body.length + 'B)' : '');
  const r = await fetch(DS + p, { ...opts, headers: dsBaseHeaders(opts.headers) });
  const raw = await r.text();
  log('DS ←', r.status, p, 'len=' + raw.length);
  log('DS ← body:', raw.slice(0, 500));
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${raw.slice(0, 200)}`);
  try { return JSON.parse(raw); } catch (e) {
    throw new Error('DS non-JSON response: ' + raw.slice(0, 200));
  }
}

async function powFor(targetPath) {
  log('powFor:', targetPath);
  const j = await dsJson('/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: targetPath })
  });
  const ch = j?.data?.biz_data?.challenge;
  if (!ch) throw new Error('PoW challenge missing. Response: ' + JSON.stringify(j).slice(0, 200));
  log('challenge: diff =', ch.difficulty, '| algo =', ch.algorithm);
  const ans = await solvePoW({
    algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt,
    difficulty: ch.difficulty, signature: ch.signature, expireAt: ch.expire_at
  });
  const header = Buffer.from(JSON.stringify({
    algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt,
    answer: ans.answer, signature: ch.signature, target_path: targetPath
  })).toString('base64');
  log('pow header built, len =', header.length);
  return header;
}

async function uploadFileToDeepSeek(file, thinkingEnabled) {
  log('upload:', file.originalname, file.mimetype, file.size, 'B');
  const powHeader = await powFor('/api/v0/file/upload_file');
  const fd = new FormData();
  fd.append('file',
    new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' }),
    file.originalname);
  const r = await fetch(DS + '/api/v0/file/upload_file', {
    method: 'POST',
    headers: dsBaseHeaders({
      'x-ds-pow-response': powHeader,
      'x-file-size': String(file.size),
      'x-model-type': 'default',
      'x-thinking-enabled': thinkingEnabled ? '1' : '0'
    }),
    body: fd
  });
  const raw = await r.text();
  log('upload ←', r.status, 'len=', raw.length, 'body:', raw.slice(0, 300));
  if (!r.ok) throw new Error(`Upload ${r.status}: ${raw.slice(0, 200)}`);
  let j; try { j = JSON.parse(raw); } catch { throw new Error('Upload non-JSON: ' + raw.slice(0, 200)); }
  const f = j?.data?.biz_data;
  if (!f?.id) throw new Error('Upload: no file id — ' + raw.slice(0, 200));
  log('upload id:', f.id, '| status:', f.status, '| kind:', f.model_kind, '| is_image:', f.is_image);
  return f.id;
}

async function waitForFile(fileId, timeoutMs = 60_000) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const j = await dsJson(
      '/api/v0/file/fetch_files?file_ids=' + encodeURIComponent(fileId),
      { method: 'GET' });
    const f = j?.data?.biz_data?.files?.[0];
    if (!f) throw new Error('File not found: ' + fileId);
    log('poll #' + attempts, 'status =', f.status, '| audit =', f.audit_result);
    if (f.status === 'SUCCESS') {
      if (f.audit_result && f.audit_result !== 'pass') {
        throw new Error('File rejected: audit_result=' + f.audit_result);
      }
      return f;
    }
    if (f.status === 'FAILED' || f.error_code) {
      throw new Error('File processing failed: ' + (f.error_code || f.status));
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error('File processing timeout');
}

async function streamCompletion(body, sseSend) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frags = [];
  const byId  = new Map();
  let newMessageId = null, chatTitle = null, closed = false;
  let rawBytes = 0, blocksSeen = 0, deltasSent = 0;

  // Forward every fragment type except THINK as the visible response.
  // DeepSeek emits RESPONSE for normal chat, SEARCH when search is enabled,
  // and possibly other types in the future. All non-THINK content is answer text.
  function emit(frag) {
    if (!frag.content) return;
    deltasSent++;
    if (frag.type === 'THINK') sseSend({ t: frag.content });
    else                       sseSend({ r: frag.content });
  }
  function lastFrag() { return frags.length ? frags[frags.length - 1] : null; }
  function addFrag(f) {
    const frag = { id: f.id, type: f.type, content: f.content || '' };
    frags.push(frag);
    if (f.id != null) byId.set(f.id, frag);
    log('addFrag id=' + f.id, 'type=' + f.type, 'content=' + JSON.stringify((f.content || '').slice(0, 60)));
    emit(frag);
  }
  function appendToFrag(frag, value) {
    if (!frag || !value) return;
    frag.content += value;
    log('append to frag id=' + frag.id, 'type=' + frag.type, 'delta=' + JSON.stringify(value));
    emit({ type: frag.type, content: value });
  }
  function handlePatch(p, o, v) {
    log('patch p=' + p, 'o=' + o, 'v=' + JSON.stringify(v).slice(0, 80));
    if (p === 'response' && o === 'BATCH' && Array.isArray(v)) {
      for (const s of v) if (s?.p && s?.o) handlePatch(s.p, s.o, s.v);
      return;
    }
    if (p === 'response/fragments' && o === 'APPEND' && Array.isArray(v)) {
      for (const f of v) addFrag(f);
      return;
    }
    if (o === 'APPEND' && typeof p === 'string' && p.indexOf('response/fragments/') === 0) {
      const m = p.match(/^response\/fragments\/(-?\d+)\/content$/);
      if (!m) { log('  patchContent regex miss:', p); return; }
      const key = +m[1];
      const frag = key === -1 ? lastFrag() : byId.get(key);
      if (!frag) { log('  no frag for key', key); return; }
      appendToFrag(frag, v);
      return;
    }
    log('  (unhandled patch)');
  }
  function handleBlock(block) {
    blocksSeen++;
    let ev = '';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line[0] === ':') continue;
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) { log('block has no data lines (event=' + ev + ')'); return; }
    const dataStr = data.join('\n');
    let d; try { d = JSON.parse(dataStr); }
    catch (e) { log('JSON parse fail:', e.message, '| raw:', dataStr.slice(0, 200)); return; }

    if (ev === 'ready') {
      if (d.response_message_id) newMessageId = d.response_message_id;
      log('event=ready, response_message_id=' + d.response_message_id);
      return;
    }
    if (ev === 'title') {
      if (typeof d.content === 'string') chatTitle = d.content;
      log('event=title, content=' + JSON.stringify(chatTitle));
      return;
    }
    if (ev === 'close') { log('event=close'); closed = true; return; }
    if (ev === 'update_session') { return; }

    if (d.v && typeof d.v === 'object' && d.v.response) {
      if (d.v.response.message_id) newMessageId = d.v.response.message_id;
      if (Array.isArray(d.v.response.fragments))
        for (const f of d.v.response.fragments) addFrag(f);
      return;
    }

    if (typeof d.v === 'string' && !d.p) {
      appendToFrag(lastFrag(), d.v);
      return;
    }

    if (d.p && d.o) { handlePatch(d.p, d.o, d.v); return; }

    log('(unrecognized block, no event, no patch)');
  }

  while (!closed) {
    const { value, done } = await reader.read();
    if (done) { log('stream reader: DONE'); break; }
    rawBytes += value.byteLength;
    const chunk = dec.decode(value, { stream: true });
    buf += chunk;
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const sep = buf.slice(idx).match(/^\r?\n\r?\n/)[0];
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + sep.length);
      handleBlock(block);
    }
  }
  log('stream done: rawBytes=' + rawBytes, 'blocks=' + blocksSeen, 'deltasSent=' + deltasSent);
  return { newMessageId, chatTitle };
}

app.post('/api/chat', upload.array('files', 6), async (req, res) => {
  const t0 = Date.now();
  const prompt     = (req.body.prompt || '').toString();
  const thinkingOn = req.body.thinking === '1';
  const searchOn   = req.body.search === '1';
  const files      = req.files || [];

  let sessionId = (req.body.session_id || '').toString().trim();
  let parentId  = req.body.parent_message_id
    ? Number(req.body.parent_message_id)
    : null;
  if (!Number.isFinite(parentId)) parentId = null;

  log('=========== /api/chat ===========');
  log('prompt:', JSON.stringify(prompt));
  log('thinking:', thinkingOn, '| search:', searchOn);
  log('session_id:', sessionId || '(none)');
  log('parent_message_id:', parentId);
  log('files:', files.length, files.map(f => f.originalname).join(', '));

  if (!prompt.trim() && files.length === 0) {
    log('-> 400 empty message');
    return res.status(400).json({ e: 'empty message' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  // Watch the RESPONSE, not the request — req 'close' fires as soon as the
  // multipart body is fully received (which multer does immediately).
  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true;
      log('client disconnected (response closed prematurely)');
    }
  });

  let pending = '', timer = null;
  const flush = () => {
    if (pending && !aborted && !res.writableEnded) {
      res.write('data:' + JSON.stringify({ r: pending }) + '\n\n');
      pending = '';
    }
  };
  const sseSend = (obj) => {
    if (aborted || res.writableEnded) return;
    if (typeof obj.r === 'string') {
      pending += obj.r;
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 60);
      return;
    }
    if (timer) { clearTimeout(timer); timer = null; flush(); }
    log('SSE →', JSON.stringify(obj).slice(0, 200));
    res.write('data:' + JSON.stringify(obj) + '\n\n');
  };

  try {
    let fileIds = [];
    if (files.length) {
      sseSend({ s: 'uploading' });
      for (const f of files) {
        const id = await uploadFileToDeepSeek(f, thinkingOn);
        await waitForFile(id);
        fileIds.push(id);
      }
      log('all uploads done:', fileIds);
    }

    if (!sessionId) {
      log('creating new chat session…');
      const j = await dsJson('/api/v0/chat_session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      sessionId = j?.data?.biz_data?.chat_session?.id;
      if (!sessionId) throw new Error('Session create: no id in response');
      parentId = null;
      log('new session:', sessionId);
      sseSend({ sid: sessionId });
    }

    sseSend({ s: 'thinking' });
    log('getting PoW for completion…');
    const powHeader = await powFor('/api/v0/chat/completion');
    log('PoW solved, header len =', powHeader.length);

    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentId,
      model_type: 'default',
      prompt: prompt || ' ',
      ref_file_ids: fileIds,
      thinking_enabled: thinkingOn,
      search_enabled: searchOn,
      action: null,
      preempt: false
    };
    log('completion body:', JSON.stringify(body));

    const comp = await fetch(DS + '/api/v0/chat/completion', {
      method: 'POST',
      headers: dsBaseHeaders({
        'Content-Type': 'application/json',
        'x-ds-pow-response': powHeader
      }),
      body: JSON.stringify(body)
    });

    log('completion status =', comp.status);
    log('completion content-type =', comp.headers.get('content-type'));

    if (!comp.ok) {
      const errText = (await comp.text()).slice(0, 400);
      err('completion failed', comp.status, errText);
      const evt = { e: `Completion ${comp.status}: ${errText.slice(0, 200)}` };
      if (comp.status >= 400 && comp.status < 500 && comp.status !== 429) evt.reset = 1;
      sseSend(evt);
      if (!aborted) res.end();
      return;
    }

    const { newMessageId, chatTitle } = await streamCompletion(comp.body, sseSend);
    log('stream finished: newMessageId =', newMessageId, '| title =', chatTitle);
    if (chatTitle) sseSend({ title: chatTitle });
    if (newMessageId != null) sseSend({ sid: sessionId, pid: newMessageId });
    sseSend({ done: 1 });
    res.end();
    log('request finished in', Date.now() - t0, 'ms');
  } catch (e) {
    err('chat error:', e.stack || e.message);
    sseSend({ e: e.message });
    if (!aborted) res.end();
  }
});

app.use((err, req, res, next) => {
  if (!err) return next();
  err('middleware error:', err.message);
  if (res.headersSent) return res.end();
  res.status(400).json({ e: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('listening on', port, '| DEBUG =', DEBUG);
});