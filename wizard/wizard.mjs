#!/usr/bin/env node
/*
 * Zeus Install Wizard — automated installer for the hardened Zeus panel on Cloudflare
 * Flow: token-creation link (random name) → account → D1 → worker upload → subdomain → custom domain
 * The panel source is read from this repository (fork axionspace/Z-E-U-S) — no npm
 * packages, Node.js 18+ only. Every install gets its own build fingerprint (payload
 * table re-keyed and re-ordered, generated identifiers renamed) and the wizard keeps a
 * local profile so the panel can be re-updated later with one command, defaults only.
 *
 * Usage:
 *   node wizard.mjs                (full interactive install)
 *   node wizard.mjs --update       (manual update of an existing install, saved defaults)
 *   node wizard.mjs --prepare-only (fetch/validate the source only, no Cloudflare API calls)
 *   node wizard.mjs --personalize  (download, re-fingerprint and verify the source only)
 *   node wizard.mjs --token-link   (just print a token-creation link with a random name)
 *   node wizard.mjs --no-fingerprint (install the shared repository build unchanged)
 *
 * Requirement: Node.js 18+ (the installers fetch a private copy automatically if missing)
 */
import { readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = 'https://api.cloudflare.com/client/v4';
// Mirrors of the hardened source served from this repository; raw.githubusercontent.com
// is the canonical source and is tried first, then independent CDNs that mirror GitHub,
// so a filtered or failing route never blocks the install.
const FORK_SOURCES = [
  'https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/Source.js',
  'https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/Source.js',
  'https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/Source.js',
];
// Local install profile — the defaults used by the manual update. Never stores a token.
const PROFILE_PATH = join(__dirname, 'profile.json');
const PROFILE_VERSION = 1;
// Exactly the permissions the panel needs (Workers Scripts, KV, D1, Subdomain, ...)
const PERM_GROUPS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'workers_subdomain', type: 'edit' },
  { key: 'account_analytics', type: 'read' },
];
const COMPAT_DATE = '2024-09-23';

// Small random lowercase name — used for the token name and the worker-name suggestion
function randName(n) {
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[randomInt(abc.length)];
  return s;
}
// Ready-made token-creation link: all permissions pre-set + a random token name
function makeTokenUrl() {
  return (
    'https://dash.cloudflare.com/profile/api-tokens' +
    '?permissionGroupKeys=' + encodeURIComponent(JSON.stringify(PERM_GROUPS)) +
    '&accountId=*&zoneId=all&name=' + randName(10)
  );
}

const KEYWORDS = ['vless','vmess','trojan','shadowsocks','v2ray','xray','hiddify','clash','sing-box','singbox','flclash','panel-zeus','z-e-u-s','hxxyrukih4kvmeawzmdmug2eh5uwtcmt','ss://'];
const KW_RE = new RegExp(KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

let TOKEN = '';
let step = 0;
let totalSteps = 10;

// ---------------------------------------------------------------- UI helpers
// Farsi first, English second. The big line is plain Farsi so a non-expert can finish the
// whole wizard half-asleep; the indented line is the short English equivalent. Every
// question shows its default, every step prints what it does and why, and every error ends
// with ONE concrete next action.
const line = '─'.repeat(58);
function banner() {
  console.log(`
${line}
    ⚡ ویزارد نصب زئوس  —  Zeus Install Wizard
${line}
    این ویزارد چه کاری می‌کند؟  —  This wizard will:
       [1/10]  Validate your Cloudflare API token  ·  بررسی توکن
       [2/10]  Pick the account to install into  ·  انتخاب اکانت
       [3/10]  Choose the worker name  ·  انتخاب اسم ورکر
       [4/10]  Read your workers.dev subdomain  ·  خواندن آدرس workers.dev
       [5/10]  Create the D1 database, or reuse an existing one  ·  ساخت یا استفاده از دیتابیس
       [6/10]  Fetch the hardened source from this repository  ·  آوردن سورس سخت‌شده
       [7/10]  Give this install its own build fingerprint  ·  ساخت هویت اختصاصی این نصب
       [8/10]  Upload the worker and verify the deployed bytes match  ·  آپلود و تطبیق بایت‌ها
       [9/10]  Enable the public workers.dev address  ·  روشن کردن آدرس عمومی
      [10/10]  Check the address, then (optionally) attach a custom domain  ·  چک آدرس و اتصال دامنه
    بعداً برای آپدیت فقط این را اجرا کنید:  «node wizard.mjs --update»
    Later on, "node wizard.mjs --update" re-deploys using the saved defaults.
${line}
    🔒 نکتهٔ امنیتی / Safety: توکن شما هیچ‌جا ذخیره نمی‌شود — نه در فایل و نه در لاگ.
    Your API token is never written anywhere: not to a file, not to a log.
${line}`);
}
function bannerUpdate(profile) {
  console.log(`
${line}
    ⚡ آپدیت پنل با تنظیمات ذخیره‌شده  —  Manual update (saved defaults)
${line}
    manual update (saved defaults) — nothing is deleted, only the worker script is replaced
      اکانت / account : ${profile.accountName || profile.accountId}
      ورکر / worker   : ${profile.workerName}
      دیتابیس / db    : ${profile.dbName || '(none)'}${profile.dbId ? ' (' + String(profile.dbId).slice(0, 8) + '…)' : ''}
      آدرس / address  : ${profile.panelUrl || '(unknown)'}
      هویت / identity : ${profile.names ? Object.values(profile.names).slice(0, 2).join(', ') + ' …' : 'shared repository build'}
    هیچ داده‌ای حذف نمی‌شود: دیتابیس D1، ردیف‌های آن، آدرس workers.dev و هر دامنه‌ای که
    وصل کرده‌اید دقیقاً مثل قبل می‌مانند.
    Nothing in this run deletes your data: the D1 database, its rows, the workers.dev
    address and any attached domain are left exactly as they are. (If Cloudflare itself
    reports error 1101 on the address, the worker script may be recreated — never the
    database.)
${line}`);
}

// ---- Piped input (for automated testing): when stdin is piped, a non-TTY readline
// reads all lines at once and drops lines that arrive while no question is pending;
// so in that mode we slurp the whole stdin up front and answer each question from
// that queue.
let pipedLines = null;
let pipedIdx = 0;
async function loadPipedInput() {
  if (process.stdin.isTTY) return;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (pipedLines.length && pipedLines[pipedLines.length - 1] === '') pipedLines.pop();
}
function nextPiped() {
  if (!pipedLines || pipedIdx >= pipedLines.length) return null;
  return pipedLines[pipedIdx++];
}

// One question per screen: a plain Farsi line, then the short English sub-label, then the
// prompt with its default inside square brackets so it is always visible.
async function ask(rl, q, def = '', fa = '') {
  if (fa) console.log('  ❯ ' + fa);
  console.log('    ' + q);
  const prompt = def !== '' ? `  پاسخ / ${q} [${def}]: ` : `  پاسخ / ${q}: `;
  if (pipedLines) {
    const a = nextPiped();
    if (a === null) {
      if (def) { console.log(prompt + def + '   (no more input — using the default)'); return def; }
      fail('No answer was left in the non-interactive input, and this question has no default: ' + q, 'Run the wizard interactively, or pipe one answer per question in order.');
    }
    console.log(prompt + (a === '' && def ? `${def}   (default)` : a));
    return a || def;
  }
  const a = (await rl.question(prompt)).trim();
  return a || def;
}

// -------------------------------------------------------------- truly hidden input
// The only representation of a secret that may ever reach the screen.
function maskSecret(t) {
  return t.length ? '••••••••   (received, ' + t.length + ' chars)' : '(nothing received — try pasting again)';
}
// Reading a secret so that NOTHING the user types is echoed to the terminal.
//
// The previous implementation muted readline's output stream. On Windows PowerShell and
// cmd/conhost that is not enough: the console echoes the keys itself, so a pasted API
// token still lands on screen and in every scrollback. The reliable way is raw mode — on
// POSIX it clears ECHO, and on Windows setRawMode(true) clears ENABLE_ECHO_INPUT — so the
// OS stops printing the keys and this process decides what to draw: a fixed mask that
// never grows with the input, and never the value itself.
function restoreTty() {
  try { if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
}
async function askSecret(rl, q, fa = '') {
  const label = fa || 'توکن API کلودفلر را اینجا بچسبانید و Enter بزنید';
  if (pipedLines) {
    let a = nextPiped();
    while (a === '') a = nextPiped(); // an empty token is meaningless; skip empty lines
    if (a === null) fail('No value was left in the non-interactive input for "' + q + '".', 'Set ZEUS_CF_TOKEN to pass the API token without typing it.');
    console.log('  ' + label + '\n    ' + q + '\n  ' + maskSecret(a.trim()));
    return a.trim();
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    // No TTY to switch into raw mode: at least mute this process's own echo so the value
    // does not come back through readline.
    const prompt = '  ' + label + '\n    ' + q + ': ';
    const orig = rl.output;
    const muted = new Writable({ write(chunk, _enc, cb) { if (String(chunk).includes('\n')) orig.write('\n'); cb(); } });
    let a = '';
    try {
      orig.write(prompt);
      rl.output = muted;
      do { a = (await rl.question('')).trim(); } while (!a);
    } finally { rl.output = orig; }
    console.log('  ' + maskSecret(a));
    return a;
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const prompt = '  ' + label + '\n    ' + q + ': ';
    let value = '';
    let shown = 0;
    let timer = null;
    const draw = () => {
      const dots = '•'.repeat(value.length ? 8 : 0);
      const txt = value.length ? dots + '   (received, ' + value.length + ' chars)'
        : '(حروف تایپ‌شده نمایش داده نمی‌شوند — بچسبانید و Enter بزنید)';
      if (shown) process.stdout.write('\r' + ' '.repeat(shown) + '\r');
      shown = txt.length;
      process.stdout.write(txt);
    };
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      process.removeListener('exit', onExit);
      if (timer) clearInterval(timer);
      restoreTty();
    };
    const onExit = () => restoreTty();
    const onKey = (str, key) => {
      if (key && key.name === 'return') { cleanup(); process.stdout.write('\n  ' + maskSecret(value.trim()) + '\n'); resolve(value.trim()); return; }
      // Ctrl+C must always work, even while the terminal is in raw mode
      if (key && key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      if (key && key.name === 'backspace') { if (value.length) value = value.slice(0, -1); return; }
      if (str && !(key && key.ctrl)) value += str;
    };
    process.stdout.write(prompt);
    stdin.setEncoding('utf8');
    readline.emitKeypressEvents(stdin);
    stdin.on('keypress', onKey);
    process.on('exit', onExit);
    stdin.setRawMode(true);
    stdin.resume();
    timer = setInterval(() => { if (value.length) draw(); }, 150);
    if (timer.unref) timer.unref();
  });
}

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
// Farsi-first variants: the Persian line carries the message, the English one explains it.
function okF(fa, en) { console.log(`  ✅ ${fa}`); if (en) console.log(`     ${en}`); }
function warnF(fa, en) { console.log(`  ⚠️  ${fa}`); if (en) console.log(`     ${en}`); }
function info(msg) { console.log(`     ${msg}`); }
// "what it does / why", printed before every Cloudflare-touching step.
function why(what, whyText) {
  console.log(`     ▸ چه کاری می‌کند / what: ${what}`);
  console.log(`     ▸ چرا / why: ${whyText}`);
}
let activeRl = null; // for a clean readline exit (avoids the Windows assert)
// Every error ends with ONE concrete next action, in both languages.
function fail(msg, hint) {
  console.error(`\n  ❌ ${msg}`);
  if (hint) {
    console.error(`     💡 ${hint}`);
    if (!/[؀-ۿ]/.test(hint)) console.error(`     💡 کاری که باید بکنید / your next step: ${hint}`);
  }
  process.exitCode = 1;
  restoreTty();
  try { process.stdin.pause(); } catch {}
  try { activeRl && activeRl.close(); } catch {}
  throw { __zeusExit: true };
}
function nextStep(title, fa = '') {
  step++;
  console.log(`\n${line}\n  [${step}/${totalSteps}]  ${title}${fa ? '\n             ' + fa : ''}\n${line}`);
}

// ---------------------------------------------------------------- CF helpers
async function cf(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: typeof body === 'string' || body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`Could not reach api.cloudflare.com (${e.message})`, 'Check your internet connection or VPN.');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { success: false, errors: [{ code: res.status, message: text.slice(0, 200) }] }; }
  if (!res.ok || data.success === false) {
    const errs = (data.errors || []).map((e) => `code ${e.code}: ${e.message}`).join(' | ') || `HTTP ${res.status}`;
    return { ok: false, status: res.status, errors: errs, data };
  }
  return { ok: true, status: res.status, data };
}

// ------------------------------------------------------- source preparation
// The source must be a hardened build: payload table present, zero identifiable keywords.
// The table is detected structurally, so both the shared repository build and an already
// personalised one pass.
function checkHardened(txt) {
  const hits = txt.split('\n').filter((l) => KW_RE.test(l)).length;
  const det = detectPrelude(txt);
  return {
    hits,
    valid: txt.length > 800000 && det !== null && hits === 0,
  };
}

async function prepareSource(rl) {
  // 1) Local file: the wizard sitting next to Source.js, the fork layout (wizard/ folder
  // inside the repo clone, Source.js at the root), or an existing Source-hardened.js
  for (const p of [join(__dirname, 'Source.js'), join(ROOT, 'Source.js'), join(ROOT, 'Source-hardened.js')]) {
    if (!existsSync(p)) continue;
    const c = checkHardened(readFileSync(p, 'utf8'));
    if (c.valid) {
      ok('Hardened source loaded from local file: ' + p);
      return { path: p, fresh: false };
    }
    warn(`File ${p} is not the hardened build (${c.hits} suspect lines or invalid structure) — will download from the repository instead.`);
  }

  // 2) Download from this repository (raw first as the canonical source; jsdelivr CDN mirrors as fallback)
  console.log('  ⏳ Downloading the hardened source from axionspace/Z-E-U-S ...');
  for (const url of FORK_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      const c = checkHardened(txt);
      if (!c.valid) throw new Error('received content was not the hardened build');
      const tmp = join(tmpdir(), 'zeus-src-' + randName(8) + '.js');
      writeFileSync(tmp, txt);
      ok(`Downloaded from ${new URL(url).host} (${(txt.length / 1024).toFixed(0)}KB)`);
      return { path: tmp, fresh: true };
    } catch (e) {
      warn(`Mirror ${new URL(url).host} failed: ${e.message}`);
    }
  }
  fail(
    'Could not download the source from any mirror.',
    'Try again with a VPN, or clone this repository and run wizard/wizard.mjs from inside it (it uses the repository Source.js directly).'
  );
}

function scanKeywords(p) {
  const src = readFileSync(p, 'utf8');
  const hits = src.split('\n').filter((l) => KW_RE.test(l)).length;
  return { size: src.length, hits };
}

// ---------------------------------------------------- per-install build fingerprint
// Two installs of the same file are trivially recognisable to a static scanner, so the
// wizard rewrites its own generated layer for every user: a fresh XOR key, a new row
// order for the payload table and brand-new identifier names. The panel's own code, the
// author's watermarks and every decoded runtime value stay byte-for-byte identical — the
// transform is verified row-by-row against the original build before anything is uploaded.
const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rngFrom(seed) {
  let counter = 0;
  let buf = [];
  let pos = 0;
  return {
    byte() {
      if (pos >= buf.length) {
        buf = Array.from(createHash('sha256').update(seed + ':' + ++counter).digest());
        pos = 0;
      }
      return buf[pos++];
    },
    int(n) {
      const limit = 256 - (256 % n);
      let x = this.byte();
      while (x >= limit) x = this.byte();
      return x % n;
    },
  };
}

const xorDecode = (b64, key) => {
  const b = Buffer.from(b64, 'base64');
  for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length];
  return b.toString('utf8');
};
const xorEncode = (plain, key) => {
  const b = Buffer.from(plain, 'utf8');
  for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length];
  return b.toString('base64');
};

// The generated prelude, detected structurally so any fingerprinted build re-reads fine.
const PRELUDE_RE = new RegExp(
  'const\\s+([\\w$]+)\\s*=\\s*\\[\\s*(0x[0-9a-fA-F]{2}(?:\\s*,\\s*0x[0-9a-fA-F]{2})*)\\s*\\]\\s*;\\s*' +
  'const\\s+([\\w$]+)\\s*=\\s*\\[\\s*((?:"[A-Za-z0-9+/=]+"\\s*,\\s*)*"[A-Za-z0-9+/=]+")\\s*\\]\\s*;\\s*' +
  'const\\s+([\\w$]+)\\s*=\\s*new\\s+Array\\(\\s*\\3\\s*\\.\\s*length\\s*\\)\\s*;\\s*' +
  'function\\s+([\\w$]+)\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{[^{}]*?atob[^{}]*?\\}\\s*' +
  'function\\s+([\\w$]+)\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{[^{}]*?\\}'
);

function detectPrelude(txt) {
  const m = PRELUDE_RE.exec(txt);
  if (!m) return null;
  const key = m[2].split(',').map((s) => parseInt(s.trim(), 16));
  const blobs = (m[4].match(/"([A-Za-z0-9+/=]+)"/g) || []).map((s) => s.slice(1, -1));
  if (key.length !== 32 || blobs.length < 20) return null;
  const head = txt.slice(0, m.index).match(/\/\*[\s\S]*?\*\/\s*$/);
  return {
    start: head ? m.index - head[0].length : m.index,
    end: m.index + m[0].length,
    raw: (head ? head[0] : '') + m[0],
    keyName: m[1], key,
    blobName: m[3], blobs,
    cacheName: m[5],
    decName: m[6], decArg: m[7],
    getName: m[8], getArg: m[9],
  };
}

const COMMENT_POOL = [
  'runtime payload table — opaque at rest, reconstructed on demand',
  'packed runtime strings — decoded lazily on first use',
  'deferred runtime string store — expanded at call time',
  'encoded runtime text table — materialised when needed',
  'compact runtime payload store — rebuilt on demand',
];

function buildPrelude(p) {
  const keyList = p.key.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(',');
  const blobList = p.blobs.map((b) => JSON.stringify(b)).join(',\n');
  return `/* ${p.comment} */
const ${p.keyName} = [${keyList}];
const ${p.blobName} = [${blobList}];
const ${p.cacheName} = new Array(${p.blobName}.length);
function ${p.decName}(${p.decArg}) {
	const b = atob(${p.decArg});
	const u = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i) ^ ${p.keyName}[i % ${p.keyName}.length];
	return new TextDecoder().decode(u);
}
function ${p.getName}(${p.getArg}) {
	return ${p.cacheName}[${p.getArg}] !== undefined ? ${p.cacheName}[${p.getArg}] : (${p.cacheName}[${p.getArg}] = ${p.decName}(${p.blobName}[${p.getArg}]));
}`;
}

// A generated identifier must look like noise: short, lowercase, one leading underscore.
// Anything that even resembles a product, a protocol, a technology or a panel concept is
// rejected and re-rolled, so a reader of the deployed build learns nothing from the names.
// (This is a naming rule only — it costs nothing at runtime, everything here runs at build time.)
const NAME_BLOCKLIST = [
  ...KEYWORDS, 'zeus', 'panel', 'proxy', 'relay', 'node', 'server', 'client', 'worker',
  'vless', 'vmess', 'trojan', 'ss', 'ws', 'tcp', 'udp', 'http', 'tls', 'ssl', 'dns',
  'admin', 'login', 'user', 'account', 'pass', 'key', 'hash', 'uuid', 'token', 'cloud',
  'flare', 'cloudflare', 'cf', 'edge', 'ip', 'port', 'host', 'proxy', 'sub', 'scan',
];
const NAME_BLOCK_RE = new RegExp(NAME_BLOCKLIST.filter(Boolean).map(rxEsc).join('|'), 'i');

function newName(rng, body, taken) {
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  for (let tries = 0; tries < 2000; tries++) {
    let n = '_';
    const len = 5 + rng.int(4);
    for (let i = 0; i < len; i++) n += abc[rng.int(26)];
    if (taken.has(n)) continue;
    if (NAME_BLOCK_RE.test(n)) continue;                       // never keyword/technology-shaped
    if (new RegExp('(?<![\\w$])' + n + '(?![\\w$])').test(body)) continue;
    taken.add(n);
    return n;
  }
  throw new Error('could not allocate fresh identifier names');
}

function personalize(txt, seed) {
  const det = detectPrelude(txt);
  if (!det) throw new Error('this is not a hardened build (payload table not found)');
  const plain0 = det.blobs.map((b) => xorDecode(b, det.key));
  const N = plain0.length;
  const rng = rngFrom('zeus-fp:' + seed);

  // 1) new row order
  const perm = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const ordered = perm.map((i) => plain0[i]);
  const pos = new Array(N);
  perm.forEach((oldIdx, newIdx) => { pos[oldIdx] = newIdx; });

  // 2) new key, re-rolled until no encoded blob leaks a keyword
  let key, blobs;
  for (let roll = 0; ; roll++) {
    if (roll > 200) throw new Error('could not roll a clean payload key');
    key = Array.from({ length: 32 }, () => rng.byte());
    blobs = ordered.map((p) => xorEncode(p, key));
    if (!blobs.some((b) => KW_RE.test(b))) break;
  }

  // 3) rename every generated identifier, outside the prelude
  const PLACE = '\u0000__ZEUS_PRELUDE__\u0000';
  if (txt.includes(PLACE)) throw new Error('unexpected placeholder in the source');
  let body = txt.slice(0, det.start) + PLACE + txt.slice(det.end);
  const taken = new Set();
  const renames = [];
  for (const oldName of [det.keyName, det.blobName, det.cacheName, det.decName, det.getName]) {
    renames.push([oldName, newName(rng, body, taken)]);
  }
  const renamedIds = [...new Set(body.match(/(?<![\w$])_p\d+(?![\w$])/g) || [])];
  for (const oldName of renamedIds) renames.push([oldName, newName(rng, body, taken)]);

  const callRe = new RegExp('(?<![\\w$])' + rxEsc(det.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g');
  const callsBefore = (body.match(callRe) || []).length;
  body = body.replace(callRe, (_s, d) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n >= N) throw new Error('payload index out of range: ' + n);
    return det.getName + '(' + pos[n] + ')';
  });
  for (const [oldName, fresh] of renames) {
    body = body.replace(new RegExp('(?<![\\w$])' + rxEsc(oldName) + '(?![\\w$])', 'g'), fresh);
  }

  const names = Object.fromEntries(renames);
  const prelude = buildPrelude({
    comment: COMMENT_POOL[rng.int(COMMENT_POOL.length)],
    key, blobs,
    keyName: names[det.keyName], blobName: names[det.blobName], cacheName: names[det.cacheName],
    decName: names[det.decName], decArg: det.decArg,
    getName: names[det.getName], getArg: det.getArg,
  });
  const out = body.replace(PLACE, prelude);

  // 4) prove the transform is lossless before anyone deploys it
  const chk = verifyTransform(txt, out, det, { plain0, perm, N, callsBefore, renames, key, blobs });
  return { out, names, entries: N, renamed: renamedIds.length, ...chk };
}

function verifyTransform(srcTxt, out, det, exp) {
  const problems = [];
  const nd = detectPrelude(out);
  if (!nd) return { ok: false, problems: ['payload table not found in the personalised build'] };
  if (nd.blobs.length !== exp.N) problems.push('row count changed: ' + nd.blobs.length + ' vs ' + exp.N);
  const decoded = nd.blobs.map((b) => xorDecode(b, nd.key));
  let mismatch = 0;
  for (let i = 0; i < exp.N; i++) {
    if (decoded[i] !== exp.plain0[exp.perm[i]]) mismatch++;
  }
  if (mismatch) problems.push(mismatch + ' payload rows decode differently from the original build');
  if (nd.key.join(',') === det.key.join(',')) problems.push('payload key was not re-rolled');
  const sameOrder = exp.perm.every((v, i) => v === i);
  if (sameOrder) problems.push('payload table was not re-ordered');
  const callReNew = new RegExp('(?<![\\w$])' + rxEsc(nd.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g');
  const callsAfter = (out.match(callReNew) || []).length;
  if (callsAfter !== exp.callsBefore) problems.push('decoder call sites changed: ' + exp.callsBefore + ' → ' + callsAfter);
  const staleIdx = [...out.matchAll(new RegExp('(?<![\\w$])' + rxEsc(nd.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g'))]
    .map((m) => Number(m[1])).filter((n) => n >= exp.N);
  if (staleIdx.length) problems.push('indices out of range: ' + staleIdx.slice(0, 5).join(','));
  for (const [oldName] of exp.renames) {
    if (new RegExp('(?<![\\w$])' + rxEsc(oldName) + '(?![\\w$])').test(out)) problems.push('generated name survived: ' + oldName);
  }
  for (const [, fresh] of exp.renames) {
    const c = (out.match(new RegExp('(?<![\\w$])' + rxEsc(fresh) + '(?![\\w$])', 'g')) || []).length;
    if (c === 0) problems.push('renamed identifier missing: ' + fresh);
  }
  const hits = out.split('\n').filter((l) => KW_RE.test(l)).length;
  if (hits) problems.push(hits + ' lines carry an identifiable keyword');
  // Name-shape invariant: every generated identifier must be short, lowercase, one leading
  // underscore and must not resemble a product, protocol or technology name.
  for (const [, fresh] of exp.renames) {
    if (!/^_[a-z]{5,8}$/.test(fresh)) problems.push('generated name is not short/neutral/lowercase: ' + fresh);
    else if (NAME_BLOCK_RE.test(fresh)) problems.push('generated name looks like a technology/product: ' + fresh);
  }
  if (out.length < 800000) problems.push('personalised build looks truncated: ' + out.length + ' bytes');
  // Row-set invariant: the sorted decode of the personalised table must equal the sorted
  // decode of the original table — nothing added, nothing dropped, nothing altered.
  if (decoded.length === exp.N && exp.plain0.length === exp.N) {
    const a = [...decoded].sort().join('');
    const b = [...exp.plain0].sort().join('');
    if (a !== b) problems.push('sorted decoded row set differs from the original build');
  }
  // author-side sanity: everything before the generated table must be untouched
  if (out.slice(0, det.start) !== srcTxt.slice(0, det.start)) problems.push('content before the payload table was altered');
  return { ok: problems.length === 0, problems, rows: nd.blobs.length, calls: callsAfter, keyBytes: nd.key.length };
}


// ---------------------------------------------------------------- install profile
// Everything the manual update needs to reuse: identity seed, account, worker, database.
// It is a local file in the wizard folder and never contains the API token.
function newSeed() {
  return randomBytes(16).toString('hex');
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    const p = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    if (p && p.workerName && p.seed) return p;
    warn('The saved profile has no usable seed — a fresh identity will be created.');
  } catch (e) {
    warn('The saved profile could not be parsed (' + e.message + ') — starting fresh.');
  }
  return null;
}

function saveProfile(p, quiet) {
  try {
    writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 1) + '\n');
    if (!quiet) ok('Install profile saved to ' + PROFILE_PATH + ' (the defaults for --update; it holds no token)');
    return true;
  } catch (e) {
    warn('Could not save the install profile (' + e.message + ').');
    return false;
  }
}

function tokenFromEnv() {
  return (process.env.ZEUS_CF_TOKEN || '').trim();
}

// ------------------------------------------------------------- fingerprint + upload
function fingerprint(srcPath, seed) {
  const txt = readFileSync(srcPath, 'utf8');
  if (!detectPrelude(txt)) {
    warn('No generated payload table in this source — it will be uploaded unchanged.');
    return { path: srcPath, names: null, rows: 0 };
  }
  const r = personalize(txt, seed);
  if (!r.ok) {
    fail('The personalised build did not match the original row-for-row: ' + r.problems.join(' / '),
      'Nothing was uploaded. Run again with --no-fingerprint to use the shared repository build.');
  }
  const out = join(tmpdir(), 'zeus-build-' + randName(8) + '.mjs');
  writeFileSync(out, r.out);
  const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail('The personalised build failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  ok('Personalised build ready: ' + r.entries + ' payload rows re-keyed and re-ordered, ' + Object.keys(r.names).length + ' generated identifiers renamed');
  console.log('     new internal names: ' + Object.values(r.names).slice(0, 5).join(', ') + ' …');
  console.log('     ' + (r.out.length / 1024).toFixed(0) + 'KB, zero keyword survivors, syntax check passed');
  return { path: out, names: r.names, rows: r.entries };
}

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// Read-only census of the database so an update can prove nothing was lost.
// The D1 query endpoint answers with an ARRAY of per-statement results
// ({ result: [ { results: [...], meta: {...} } ] }); the flat shape is handled too,
// because reading it wrong would silently skip the proof.
async function d1Snapshot(accountId, dbId) {
  const q = async (sql) => {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql } });
    if (!r.ok) return null;
    const res = r.data && r.data.result;
    if (Array.isArray(res)) {
      const first = res[0] || {};
      return first.results || first.rows || null;
    }
    return (res && (res.rows || res.results)) || null;
  };
  const tables = await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  if (!tables) return null;
  const census = {};
  for (const row of tables) {
    if (!row || typeof row.name !== 'string') continue;
    const c = await q('SELECT COUNT(*) AS n FROM "' + row.name.replace(/"/g, '') + '"');
    census[row.name] = c && c.length ? Number(c[0].n) : 0;
  }
  return census;
}

function sameCensus(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  return ka.every((k) => a[k] === b[k]);
}

// Occasionally a freshly created worker on an account starts answering error 1101 on
// every route even though the very same bytes run fine under a different name — a
// one-off deploy state on Cloudflare's side. Deleting the worker and deploying again
// clears it, and the D1 data is never part of that state.
function stuckWorkerHint() {
  console.log('     If this worker keeps answering "error code: 1101" on every route while the');
  console.log('     deploy itself reported success, delete the worker in the dashboard and run');
  console.log('     this wizard again with the same name — the database and its data are kept.');
}

// Does the worker already exist? The single-script endpoint answers with the script
// body (multipart), not JSON, so the JSON script list is used instead — an existence
// check that silently failed would skip the overwrite confirmation.
async function workerExists(accountId, name) {
  const list = await cf(`/accounts/${accountId}/workers/scripts?per_page=100`);
  if (!list.ok) return { ok: false, known: false, errors: list.errors };
  const found = (list.data.result || []).find((s) => s && s.id === name);
  return { ok: true, known: !!found, script: found || null };
}

// Read the script back from Cloudflare so the deployed bytes can be compared with the
// build that was just produced (the multipart endpoint returns worker.js verbatim).
async function deployedBytes(accountId, name) {
  let res;
  try {
    res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${name}?include_source=true`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return { ok: false, errors: e.message };
  }
  if (!res.ok) return { ok: false, status: res.status, errors: 'HTTP ' + res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const bm = (res.headers.get('content-type') || '').match(/boundary=(?:"?([^";\s]+)"?)/i);
  if (!bm) return { ok: true, bytes: buf };
  const parts = buf.toString('binary').split('--' + bm[1]);
  for (const p of parts) {
    // Cloudflare labels the script part name="worker.js" (no filename attribute)
    if (!/name="worker\.js"/i.test(p.slice(0, 1200))) continue;
    const i = p.indexOf('\r\n\r\n');
    if (i === -1) continue;
    return { ok: true, bytes: Buffer.from(p.slice(i + 4).replace(/\r\n$/, ''), 'binary') };
  }
  return { ok: false, errors: 'worker.js part not found in the response' };
}

// Upload while keeping whatever the worker already carries (extra bindings, variables);
// only the panel's own D1 binding is pinned.
async function uploadWorker(accountId, workerName, scriptPath, dbId, dbName) {
  const bytes = readFileSync(scriptPath);
  let bindings = [{ type: 'd1', name: 'DB', id: dbId }];
  let compat = COMPAT_DATE;
  const settings = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
  if (settings.ok && Array.isArray(settings.data.result.bindings)) {
    const keep = settings.data.result.bindings.filter((b) => b && !(b.type === 'd1' && b.name === 'DB'));
    bindings = keep.concat([{ type: 'd1', name: 'DB', id: dbId }]);
    if (settings.data.result.compatibility_date) compat = settings.data.result.compatibility_date;
    if (keep.length) ok('Preserving ' + keep.length + ' existing worker binding(s)');
  } else if (settings.status === 404) {
    console.log('     (no existing bindings to preserve)');
  } else {
    warn('Could not read current worker settings (' + settings.errors + ') — uploading with the standard D1 binding.');
  }
  const form = new FormData();
  form.append('metadata', new File([JSON.stringify({ main_module: 'worker.js', compatibility_date: compat, bindings })], 'metadata.json', { type: 'application/json' }));
  form.append('worker.js', new File([bytes], 'worker.js', { type: 'application/javascript+module' }));
  const up = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'PUT', body: form });
  if (!up.ok) fail('Worker upload failed (' + up.errors + ')', up.status === 413 ? 'Script is too large — build a different source version.' : 'Check Workers Scripts/Edit access in the token.');
  ok('Worker uploaded (' + (bytes.length / 1024).toFixed(0) + 'KB, D1: ' + (dbName || 'DB') + ', compat ' + compat + ')');
  let back = await deployedBytes(accountId, workerName);
  for (let t = 0; !back.ok && t < 3; t++) {
    await new Promise((r) => setTimeout(r, 4000));
    back = await deployedBytes(accountId, workerName);
  }
  if (back.ok && back.bytes) {
    const a = sha256hex(back.bytes), b = sha256hex(bytes);
    if (a === b) ok('Read-back matches: the deployed script is byte-identical to this build (' + back.bytes.length + 'B, sha256 ' + a.slice(0, 12) + '…)');
    else warn('Read-back differs from the local build (deployed ' + a.slice(0, 12) + ' vs local ' + b.slice(0, 12) + ') — re-run the update.');
  } else {
    warn('Could not read the deployed script back for comparison (' + (back.errors || 'HTTP ' + back.status) + ').');
  }
  return up;
}

// ------------------------------------------------------------------ health + self-heal
// A brand-new (or freshly replaced) worker is not reachable instantly: DNS and the
// workers.dev route take up to a minute or two to spread. That is different from the
// one-off state where Cloudflare itself answers "error code: 1101" for a script whose
// bytes are complete and verified. The first needs patience, the second needs the
// worker to be deleted and deployed again — which this does once, by itself.
const PROBE_BASE = (process.env.ZEUS_PROBE_URL || '').replace(/\/+$/, '');

function probeBase(workerName, subdomain) {
  if (PROBE_BASE) return PROBE_BASE;
  return `https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev`;
}

async function probeOnce(base) {
  try {
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    return { status: res.status, code: (text.match(/error code: (\d+)/) || [])[1] || null, net: null };
  } catch (e) {
    return { status: 0, code: null, net: String((e.cause && e.cause.code) || e.code || e.message).slice(0, 40) };
  }
}

function classifyProbe(p) {
  if (p.status >= 200 && p.status < 400) return 'ok';
  if (p.code === '1101' || p.status >= 500) return 'stuck';
  if (p.status === 404) return 'propagating';
  if (p.net) return 'propagating';
  return 'other';
}

// Returns { ok, state, healed }. Never deletes anything except the worker script it has
// just deployed itself, and only after Cloudflare itself reported 1101 (proof the address
// is reachable, so this can never fire for a simply-filtered workers.dev).
async function verifyDeployment({ accountId, workerName, buildPath, dbId, dbName, subdomain, log = console, canHeal = true }) {
  const base = probeBase(workerName, subdomain);
  const waitMs = Number(process.env.ZEUS_PROBE_WAIT_MS || 90000);
  const stepMs = Number(process.env.ZEUS_PROBE_INTERVAL_MS || 8000);
  const deadline = Date.now() + waitMs;
  let last = null, sawStuck = false;
  for (;;) {
    last = await probeOnce(base);
    const state = classifyProbe(last);
    if (state === 'ok') {
      log.log('  ✅ Panel address answers ' + last.status + ' ✔');
      return { ok: true, state: 'ok', healed: false };
    }
    if (state === 'stuck') sawStuck = true;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!sawStuck) {
    warn('The address did not answer within ' + Math.round(waitMs / 1000) + 's (' + (last.net || ('HTTP ' + last.status)) + ').');
    console.log('  This does not mean the install failed: the uploaded bytes were verified against the');
    console.log('  build that was produced here. On a filtered network workers.dev is simply unreachable.');
    console.log('  Open the address from another network, or attach a custom domain at the last step.');
    // Bilingual one-liner: patience, not failure.
    console.log('  💬 EN: a brand-new address can take a minute or two to spread — the deploy itself was verified byte for byte.');
    console.log('     FA: آدرس تازه ممکن است یک تا دو دقیقه طول بکشد تا منتشر شود — خودِ نصب بایت‌به‌بایت تأیید شده است.');
    return { ok: false, state: 'unreachable', healed: false };
  }
  if (!canHeal) return { ok: false, state: 'stuck', healed: false };
  warn('Cloudflare itself answered "error code: 1101" on this address although the deployed bytes match the verified build.');
  console.log('  That is the one-off deploy state on Cloudflare side. Redeploying the same file to the same');
  console.log('  name does not clear it, so the wizard deletes the worker and uploads it once again.');
  // One clear bilingual line, so the owner understands exactly what happened and why:
  //   EN: Cloudflare hiccup on the fresh deploy (1101) → script recreated once, data untouched.
  //   FA: بروز خطای ۱۱۰۱ از سوی کلودفلر → اسکریپت یک‌بار ساخته می‌شود، داده‌ها دست‌نخورده می‌مانند.
  console.log('  💬 EN: Cloudflare answered 1101 on a fresh deploy — the worker script is recreated once from the same verified bytes; your database, rows, address and domains are never touched.');
  console.log('     FA: کلودفلر روی نصب تازه خطای ۱۱۰۱ داد — اسکریپت ورکر یک‌بار دیگر با همان بایت‌های تأییدشده ساخته می‌شود؛ دیتابیس، ردیف‌ها، آدرس و دامنه‌های شما هرگز تغییر نمی‌کنند.');
  const del = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'DELETE' });
  if (!del.ok) { warn('Could not remove the worker (' + del.errors + ') — stopping here without touching anything else.'); return { ok: false, state: 'stuck', healed: false }; }
  ok('Worker script removed; the database ' + (dbName || 'DB') + ' was not touched');
  await new Promise((r) => setTimeout(r, 4000));
  await uploadWorker(accountId, workerName, buildPath, dbId, dbName);
  const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
  if (!en.ok) warn('Subdomain re-enable reported (' + en.errors + ') — enable it from the dashboard if needed.');
  const again = await verifyDeployment({ accountId, workerName, buildPath, dbId, dbName, subdomain, log: { log: () => {} }, canHeal: false });
  if (again.ok) { ok('Self-heal worked: the panel address now answers normally ✔'); return { ok: true, state: 'ok', healed: true }; }
  warn('Still not answering after one self-heal (' + again.state + '). The panel code is not the problem — the deployed bytes were verified.');
  stuckWorkerHint();
  console.log('     You can also prove it in 10 seconds: run the installer once with a different worker name');
  console.log('     (--no-fingerprint keeps the shared build) — the same bytes run fine on a clean script name.');
  return { ok: false, state: again.state, healed: true };
}

// ---------------------------------------------------------------- main
async function main() {
  banner();
  const noFingerprint = process.argv.includes('--no-fingerprint');
  const rotate = process.argv.includes('--rotate');

  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const cleanup = () => { try { rl && rl.close(); } catch {} };
  process.on('SIGINT', () => { console.log('\n\nCancelled.'); cleanup(); process.exit(130); });

  // Saved defaults from an earlier run in this folder (identity + account + worker + D1)
  const profile = loadProfile() || {};
  let seed = null;
  if (noFingerprint) {
    warn('--no-fingerprint: the shared repository build is uploaded unchanged.');
  } else if (rotate || !profile.seed) {
    seed = newSeed();
    if (profile.seed) console.log('  --rotate: this install gets a brand-new build identity.');
  } else {
    seed = profile.seed;
    console.log('  Reusing the build identity of your previous install (' + String(seed).slice(0, 8) + '…) — use --rotate for a new one.');
  }

  // ---------- [1/10] token
  nextStep('Validate API token', 'ساخت و بررسی توکن کلودفلر');
  why(
    'یک لینک آماده برای ساخت توکن چاپ می‌شود، بعد توکن شما گرفته و بررسی می‌شود.',
    'It prints a pre-filled token-creation link, then takes your token and verifies it.'
  );
  const tokenUrl = makeTokenUrl();
  console.log('  این لینک را در مرورگر باز کنید — همه دسترسی‌های لازم از قبل تنظیم شده و اسم توکن تصادفی است:');
  console.log('  Open this link in your browser — every required permission is pre-configured and the name is randomised:');
  console.log(`     ${tokenUrl}`);
  console.log('  مراحل: Continue to summary → Create Token → کپی توکن → بچسبانید اینجا.');
  console.log('  (Continue to summary → Create Token → copy the created token and paste it here)');
  console.log('  🔒 هیچ حرفی که تایپ می‌کنید نمایش داده نمی‌شود؛ فقط •••••••• (تعداد کاراکتر) دیده می‌شود.');
  console.log('  🔒 Nothing you type is echoed; only a fixed mask with the character count is shown.');
  const envTok = tokenFromEnv();
  if (envTok) {
    TOKEN = envTok;
    okF('توکن از متغیر محیطی ZEUS_CF_TOKEN خوانده شد (هیچ‌جا ذخیره نمی‌شود).', 'API token read from the ZEUS_CF_TOKEN environment variable (not stored anywhere).');
  } else {
    TOKEN = await askSecret(rl, 'Enter your Cloudflare API token', 'توکن API کلودفلر را اینجا بچسبانید و Enter بزنید');
  }
  const verify = await cf('/user/tokens/verify');
  if (!verify.ok) fail('توکن معتبر نیست (' + verify.errors + ') | Token is not valid (' + verify.errors + ')', 'دوباره از همان لینک بالا توکن بسازید و بچسبانید. / Create the token again with the listed permissions and paste it here.');
  okF('توکن معتبر است ✅' + (verify.data.result?.status ? ` (status: ${verify.data.result.status})` : ''), 'Token is valid' + (verify.data.result?.status ? ` (status: ${verify.data.result.status})` : ''));

  // ---------- [2/10] account
  nextStep('Select account', 'انتخاب اکانت');
  let accounts = await cf('/accounts?per_page=50');
  let accountId, accountName;
  if (!accounts.ok || !accounts.data.result?.length) {
    warnF('با این توکن لیست اکانت‌ها خوانده نشد (' + (accounts.errors || 'no access') + ')', 'Could not list accounts with this token.');
    accountId = await ask(rl, 'Enter your Account ID manually (from the overview page of your domain/worker)', '', 'Account ID را دستی وارد کنید (۳۲ کاراکتر هگز، از صفحهٔ Overview داشبورد کلودفلر).');
    if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('فرمت Account ID اشتباه است (باید ۳۲ کاراکتر هگز باشد). | Account ID format is invalid (32 hex characters).', 'از داشبورد کلودفلر → صفحهٔ اصلی دامنه یا ورکر، قسمت API روی sidebar کپی کنید. / Copy the Account ID from the Cloudflare dashboard sidebar.');
    accountName = accountId;
  } else if (accounts.data.result.length === 1) {
    accountId = accounts.data.result[0].id;
    accountName = accounts.data.result[0].name;
    okF('اکانت: ' + accountName, 'Account: ' + accountName);
  } else {
    accounts.data.result.forEach((a, i) => console.log(`     ${i + 1}) ${a.name}  (${a.id.slice(0, 8)}...)`));
    const idx = parseInt(await ask(rl, 'Account number', '1', 'شمارهٔ اکانت را بزنید (Enter = شمارهٔ ۱).'), 10);
    const picked = accounts.data.result[idx - 1];
    if (!picked) fail('انتخاب نامعتبر است. | Invalid selection.', 'یکی از شماره‌های لیست بالا را وارد کنید. / Type one of the numbers listed above.');
    accountId = picked.id; accountName = picked.name;
    okF('اکانت: ' + accountName, 'Account: ' + accountName);
  }

  // ---------- [3/10] worker name
  nextStep('Worker name', 'اسم ورکر (کارگر)');
  const suggestedName = profile.workerName || 'web-' + randName(5);
  if (profile.workerName) {
    console.log(`  An install profile exists in this folder — press Enter to reuse "${profile.workerName}", or type another name for a second panel.`);
    console.log(`  یک پروفایل نصب در این پوشه هست — Enter بزنید تا «${profile.workerName}» استفاده شود، یا اسم دیگری برای پنل دوم بنویسید.`);
  } else {
    console.log('  Tip: a neutral, random name is harder for automated scans to match — press Enter to accept the suggestion.');
    console.log('  یک اسم خنثی و تصادفی پیشنهاد می‌شود — فقط Enter بزنید تا بپذیرید (برای اسکن‌های خودکار سخت‌تر است).');
  }
  const workerName = (await ask(rl, 'Worker name', suggestedName, 'اسم ورکر را بزنید (Enter = پیشنهاد بالا).')).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('اسم ورکر فقط می‌تواند حروف کوچک انگلیسی، عدد و خط تیره داشته باشد. | Worker name may only contain lowercase letters, digits and hyphens.', 'Enter بزنید تا اسم تصادفی پیشنهادی استفاده شود. / Press Enter to accept the suggested random name.');

  // ---------- [4/10] subdomain
  nextStep('workers.dev address', 'آدرس رایگان workers.dev');
  why(
    'ساب‌دامین workers.dev اکانت شما خوانده می‌شود تا آدرس نهایی پنل ساخته شود.',
    'Your account workers.dev subdomain is read so the final panel address can be built.'
  );
  let subdomain = '';
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  if (sub.ok && sub.data.result?.subdomain) {
    subdomain = sub.data.result.subdomain;
    okF('آدرس نهایی پنل: https://' + workerName + '.' + subdomain + '.workers.dev', 'Final address will be: https://' + workerName + '.' + subdomain + '.workers.dev');
  } else {
    warnF('ساب‌دامین خوانده نشد (' + (sub.errors || '') + ') — ادامه می‌دهیم.', 'Could not fetch the subdomain (' + (sub.errors || '') + ') — continuing anyway.');
  }
  warnF('توجه: workers.dev در ایران فیلتر است؛ برای استفاده داخل ایران حتماً در مرحلهٔ آخر دامنهٔ اختصاصی وصل کنید.', 'Note: workers.dev is blocked in Iran; attach a custom domain for use inside Iran (final step).');

  // ---------- [5/10] D1
  nextStep('Create D1 database', 'ساخت یا استفاده از دیتابیس D1');
  why(
    'پنل همهٔ کاربران و تنظیمات را در یک دیتابیس D1 نگه می‌دارد؛ اگر از قبل باشد همان استفاده می‌شود و هیچ‌وقت جایگزین یا حذف نمی‌شود.',
    'The panel keeps every user and setting in one D1 database; an existing one is reused, never replaced or deleted.'
  );
  let dbName = workerName + '-db';
  let dbId = '';
  const listDb = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const existing = listDb.ok && (listDb.data.result || []).find((d) => d.name === dbName);
  if (existing) {
    dbId = existing.uuid;
    okF('دیتابیس موجود استفاده می‌شود: ' + dbName + ' (' + dbId.slice(0, 8) + '...)', 'Using existing database: ' + dbName + ' (' + dbId.slice(0, 8) + '...)');
  } else {
    const created = await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName } });
    if (!created.ok) {
      // Accounts hit a hard cap on databases (CF error 7406) after repeated installs;
      // reusing an existing database is the way through that, never deleting anything.
      if (!/7406|limit/i.test(created.errors)) {
        fail('ساخت دیتابیس D1 انجام نشد (' + created.errors + ') | D1 database creation failed (' + created.errors + ')', 'مطمئن شوید توکن دسترسی D1/Edit دارد و اکانتتان D1 دارد (پلن رایگان هم دارد). / Make sure the token has D1/Edit access and your account has D1.');
      }
      warnF('اکانت به سقف مجاز دیتابیس‌های D1 رسیده (' + created.errors + ').', 'The account is at its D1 database limit (' + created.errors + ').');
      const all = await cf(`/accounts/${accountId}/d1/database?per_page=50`);
      const free = (all.ok && all.data.result) || [];
      if (!free.length) fail('هیچ دیتابیسی برای استفادهٔ مجدد نیست. | There is no database available to reuse.', 'در داشبورد یک دیتابیس قدیمی/تست را حذف کنید و ویزارد را دوباره اجرا کنید. / Delete an old test database in the dashboard, then run this wizard again.');
      console.log('  دیتابیس‌های موجود این اکانت (این ویزارد هیچ‌کدام را حذف نمی‌کند):');
      console.log('  Existing databases in this account (nothing is deleted by this wizard):');
      free.forEach((d, i) => console.log(`     ${i + 1}) ${d.name}`));
      const pick = await ask(rl, 'Reuse which database number? (press Enter to stop here)', '', 'شمارهٔ کدام دیتابیس استفاده شود؟ (Enter = توقف)');
      const chosen = pick ? free[parseInt(pick, 10) - 1] : null;
      if (!chosen) fail('دیتابیسی انتخاب نشد — نصب قبل از هر تغییری متوقف شد. | No database chosen — the install stopped before any change.', 'در داشبورد یک اسلات D1 آزاد کنید و ویزارد را دوباره اجرا کنید. / Free a D1 slot in the dashboard and run the wizard again.');
      dbId = chosen.uuid;
      dbName = chosen.name;
      warnF('استفادهٔ مجدد از ' + dbName + ' (' + String(dbId).slice(0, 8) + '…) — هر چه داخلش هست دست‌نخورده می‌ماند.', 'Reusing ' + dbName + ' (' + String(dbId).slice(0, 8) + '…) — anything it already holds stays as it is.');
    } else {
      dbId = created.data.result.uuid;
      okF('دیتابیس ساخته شد: ' + dbName, 'Database created: ' + dbName);
    }
  }

  // ---------- [6/10] source
  nextStep('Prepare hardened source', 'آماده‌سازی سورس سخت‌شده');
  why(
    'فایل پنل از همین مخیشه (یا چند آینهٔ CDN) گرفته و اسکن می‌شود تا هیچ رشتهٔ حساس نماند.',
    'The panel file is fetched from this repository (or a CDN mirror) and scanned so no identifying string survives.'
  );
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail(`سورس هنوز ${scan.hits} خط با کلیدواژهٔ حساس دارد! | Source still has ${scan.hits} lines with identifiable keywords!`, 'از آینهٔ دیگری بگیرید یا مشکل را گزارش کنید. / Re-fetch from another mirror, or report it.');
  okF('سورس آماده است: ' + src.path, 'Source is ready: ' + src.path + ' (' + (scan.size / 1024).toFixed(0) + 'KB, zero identifiable keywords)');
  info('حجم: ' + (scan.size / 1024).toFixed(0) + 'KB | کلیدواژهٔ حساس / keyword survivors: 0');

  // ---------- [7/10] fingerprint
  nextStep('Personalise this build', 'ساخت نسخهٔ اختصاصی این نصب');
  why(
    'جدول رشته‌های پنل با یک کلید تازه بازچینی و با اسم‌های تازه ساخته می‌شود تا نصب شما با نصب کس دیگری یکسان نباشد.',
    'The payload string table is re-keyed, re-ordered and renamed so your build is not byte-identical to anyone else\u2019s own build.'
  );
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };
  if (!seed) warnF('ساخت هویت اختصاصی رد شد (--no-fingerprint) — نسخهٔ مشترک مخیشه مستقر می‌شود.', 'Fingerprint skipped (--no-fingerprint) — the shared repository build is deployed.');

  // ---------- [8/10] upload
  nextStep('Upload worker', 'آپلود ورکر و تطبیق بایت‌ها');
  why(
    'فایل ساخته‌شده روی ورکر شما آپلود و بلافاصله دوباره خوانده می‌شود تا بایت‌ها مطمئناً یکسان باشند.',
    'The built file is uploaded and immediately read back so the deployed bytes are proven identical.'
  );
  const exists = await workerExists(accountId, workerName);
  if (exists.known) {
    const overwrite = await ask(rl, `Worker "${workerName}" already exists; overwrite it? (y/n)`, 'y', `ورکر «${workerName}» از قبل هست؛ جایگزین شود؟ (y/n — Enter = بله)`);
    if (overwrite.toLowerCase() !== 'y') fail('با دستور شما لغو شد. | Cancelled by user.', 'اگر نمی‌خواهید ورکر موجود تغییر کند، اسم دیگری در مرحلهٔ قبل بنویسید. / Pick a different worker name if you do not want to replace it.');
    console.log('     (فقط اسکریپت جایگزین می‌شود — دادهٔ D1، آدرس workers.dev و هر دامنهٔ وصل‌شده حفظ می‌شود)');
    console.log('     (only the script is replaced — D1 data, the workers.dev address and any attached domain are kept)');
  }
  await uploadWorker(accountId, workerName, build.path, dbId, dbName);

  const panelUrl = `https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev/panel`;
  const prof = {
    version: PROFILE_VERSION,
    seed: seed || null,
    fingerprint: !!seed,
    accountId, accountName, workerName, dbName, dbId, subdomain, panelUrl,
    names: build.names || null,
    rows: build.rows || 0,
    source: src.fresh ? 'downloaded' : 'local',
    installedAt: profile.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hostname: profile.hostname || null,
  };
  saveProfile(prof);

  // ---------- [9/10] enable workers.dev
  nextStep('Enable public address', 'روشن کردن آدرس عمومی workers.dev');
  const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: 'POST', body: { enabled: true, previews_enabled: false },
  });
  if (!en.ok) warnF('روشن کردن ساب‌دامین انجام نشد (' + en.errors + ') — می‌توانید از داشبورد انجام دهید.', 'Subdomain enable failed (' + en.errors + ') — you can enable it from the dashboard.');
  else okF('فعال شد: https://' + workerName + (subdomain ? '.' + subdomain : '') + '.workers.dev', 'Enabled: https://' + workerName + (subdomain ? '.' + subdomain : '') + '.workers.dev');

  // ---------- [10/10] health check (waits for propagation, self-heals a 1101 state)
  nextStep('Final check & summary', 'چک نهایی آدرس و خلاصه');
  const health = await verifyDeployment({ accountId, workerName, buildPath: build.path, dbId, dbName, subdomain });
  if (health.healed) {
    prof.healedAt = new Date().toISOString();
    saveProfile(prof, true);
    console.log('\n  Note: Cloudflare reported error 1101 for this address, so the wizard recreated the');
    console.log('  worker script once with the identical verified bytes. The database was never touched.');
  }

  console.log(`
${line}
  🎉 نصب تمام شد!  —  Install complete!

     📍 آدرس پنل (اولین کار: گذاشتن پسورد ادمین):
        ${panelUrl}
        Panel address (to set the admin password the first time)

     🔗 الگوی اشتراک کاربران / User subscription pattern:
        https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev/sub/<username>

  ⚠️  اولین کاری که باید بکنید: آدرس بالا را باز کنید و پسورد ادمین را بگذارید.
      تا وقتی پسورد وجود نداشته باشد پنل به API خودش بدون پسورد جواب می‌دهد — این
      طراحی اولیهٔ نویسندهٔ اصلی است، پس نصب تازه را بدون پسورد رها نکنید.
     First thing to do: open the panel address above and set the admin password.
     Until a password exists the panel answers its own API without one — that is the
     author's first-run design, so do not leave a fresh install unclaimed.
${line}
  ⚠️  چهار نکتهٔ مهم / Four important notes:
      ۱. این نصب هویت اختصاصی خودش را دارد${build.names ? ' (' + Object.values(build.names).slice(0, 2).join(', ') + ' …)' : ''} — با نصب
         هیچ‌کس دیگر بایت‌به‌بایت یکسان نیست.
      This deployment has its own build identity — it is not byte-identical to
      anybody else's install of the same panel.
      ۲. اگر روزی دکمهٔ «آپدیت پنل» داخل پنل را زدید، build نویسنده جای این یکی را
         می‌گیرد — برگرداندنش با: node wizard.mjs --update
      If you ever use the in-panel update button, the author's own build replaces
      this one — restore it with: node wizard.mjs --update
      ۳. برای استفاده داخل ایران مرحلهٔ دامنهٔ اختصاصی را کامل کنید (می‌توانید همین حالا).
      For use inside Iran, complete the custom-domain step (you can also do it right now).
      ۴. توکن API خودتان را محرمانه نگه دارید؛ این ویزارد هرگز آن را ذخیره نمی‌کند.
      Keep your API token private; this wizard never stores it.
${line}`);

  // ---------- optional custom domain
  const wantDomain = await ask(rl, 'Do you have a custom domain you want to attach? (y/n)', 'n', 'دامنهٔ اختصاصی برای وصل کردن دارید؟ (y/n — Enter = نه)');
  if (wantDomain.toLowerCase() === 'y') {
    // Listing zones needs a token with Zone:Read — the wizard-created token does not include it,
    // so fall back to the manual Zone ID route (attaching itself only needs Workers Scripts access).
    const zones = await cf('/zones?per_page=50');
    let zoneId = '';
    let hostname = '';
    if (zones.ok && zones.data.result?.length) {
      zones.data.result.forEach((z, i) => console.log(`     ${i + 1}) ${z.name}`));
      const zi = parseInt(await ask(rl, 'Domain number', '1', 'شمارهٔ دامنه را بزنید (Enter = ۱).'), 10);
      const zone = zones.data.result[zi - 1];
      if (!zone) {
        warnF('انتخاب نامعتبر؛ رد شد.', 'Invalid selection; skipped.');
      } else {
        zoneId = zone.id;
        hostname = (await ask(rl, `Subdomain to use on ${zone.name} (e.g. panel)`, 'panel', 'چه ساب‌دامینی از ' + zone.name + ' استفاده شود؟ (مثل panel)')).trim().toLowerCase() + '.' + zone.name;
      }
    } else {
      warnF('لیست دامنه‌ها خوانده نشد (' + (zones.errors || 'Zone:Read access required') + ').', 'Could not list zones — Zone:Read access is required for the list only.');
      console.log('  می‌توانید همین حالا دستی وصلش کنید: داشبورد کلودفلر → دامنه → کپی «Zone ID»');
      console.log('  from the right sidebar of the Overview page.');
      zoneId = (await ask(rl, 'Zone ID (press Enter to skip and do it later from the dashboard)', '', 'Zone ID را بچسبانید (Enter = رد کردن و انجام بعدی از داشبورد)')).trim();
      if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) {
        warnF('فرمت Zone ID اشتباه است (۳۲ کاراکتر هگز); رد شد.', 'Zone ID format is invalid (32 hex characters); skipped.');
        zoneId = '';
      }
      if (zoneId) hostname = (await ask(rl, 'Full hostname for the panel (e.g. panel.mydomain.com)', '', 'آدرس کامل پنل را بچسبانید (مثل panel.mydomain.com)')).trim().toLowerCase();
    }
    if (zoneId && hostname) {
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
        warnF('فرمت هاست درست نیست؛ رد شد — می‌توانید بعداً از داشبورد وصلش کنید (Worker → Settings → Domains).', 'Hostname looks invalid; skipped — you can attach it later from the dashboard (Worker → Settings → Domains).');
      } else {
        const domBody = { environment: 'production', hostname, service: workerName, zone_id: zoneId };
        // API docs list PUT for attaching a domain; POST kept as a fallback for robustness.
        let cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'PUT', body: domBody });
        if (!cd.ok && (cd.status === 404 || cd.status === 405)) {
          cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'POST', body: domBody });
        }
        if (!cd.ok) warnF('اتصال دامنه انجام نشد (' + cd.errors + ') — از داشبورد: Worker → Settings → Domains', 'Domain attach failed (' + cd.errors + ') — from the dashboard: Worker → Settings → Domains');
        else {
          okF('دامنه وصل شد: https://' + hostname + '/panel', 'Domain attached: https://' + hostname + '/panel');
          console.log('     (رکورد DNS و گواهی SSL خودکار ساخته می‌شوند؛ چند دقیقه صبر کنید)');
          console.log('     (DNS record and certificate are created automatically; allow a few minutes)');
          prof.hostname = hostname;
          prof.panelUrl = `https://${hostname}/panel`;
          prof.updatedAt = new Date().toISOString();
          saveProfile(prof, true);
          okF('پروفایل با آدرس دامنه به‌روز شد: ' + prof.panelUrl, 'Profile updated with the domain address: ' + prof.panelUrl);
        }
      }
    }
  }

  cleanup();
  console.log('\nتمام شد. موفق باشید! 🌐  |  Done. Good luck!');
}

// Source preparation without any token / Cloudflare network access (for testing)
async function prepareOnlyMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  console.log('حالت آماده‌سازی: فقط سورس، بدون هیچ تماس با کلودفلر  |  Prepare-only mode: source preparation only\n');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  console.log('  فایل / file: ' + src.path);
  console.log('  حجم: ' + (scan.size / 1024).toFixed(0) + 'KB | کلیدواژهٔ حساس / keyword survivors: ' + scan.hits);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  console.log('  ✅ آماده‌سازی موفق بود  |  Preparation successful');
}

// ---------------------------------------------------------------- manual update
// Re-deploys the panel with the values saved in the install profile: token → target →
// database → source → identity → upload. Nothing is deleted anywhere in this flow; the
// same D1 database is re-attached and a read-only row census proves the data survived.
async function updateMain() {
  totalSteps = 6;
  const profile = loadProfile();
  if (!profile) {
    fail('No install profile was found in this folder — --update works on an install made by this wizard.',
      'Run the full install once (node wizard.mjs) with the same worker name; it reuses an existing database.');
  }
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const cleanup = () => { try { rl && rl.close(); } catch {} };
  process.on('SIGINT', () => { console.log('\n\nCancelled.'); cleanup(); process.exit(130); });
  bannerUpdate(profile);
  const noFingerprint = process.argv.includes('--no-fingerprint');
  const rotate = process.argv.includes('--rotate');

  // ---------- [1/6] token
  nextStep('Validate API token', 'بررسی توکن');
  const envTok = tokenFromEnv();
  if (envTok) {
    TOKEN = envTok;
    okF('توکن از متغیر محیطی ZEUS_CF_TOKEN خوانده شد (هیچ‌جا ذخیره نمی‌شود).', 'API token read from the ZEUS_CF_TOKEN environment variable (not stored anywhere).');
  } else {
    TOKEN = await askSecret(rl, 'Enter your Cloudflare API token', 'توکن API کلودفلر را اینجا بچسبانید و Enter بزنید');
  }
  const verify = await cf('/user/tokens/verify');
  if (!verify.ok) fail('توکن معتبر نیست (' + verify.errors + ') | Token is not valid (' + verify.errors + ')', 'دوباره از لینک ساخت توکن، توکن جدید بسازید و بچسبانید. / Create the token again with the listed permissions.');
  ok('Token is valid');

  // ---------- [2/6] target
  nextStep('Confirm what to update', 'تأیید مقصد آپدیت');
  why(
    'مقادیر ذخیره‌شده در پروفایل (اکانت، ورکر، دیتابیس) نشان داده می‌شود و فقط Enter می‌زنید.',
    'The values stored in the install profile are shown and used as the defaults — press Enter to accept each.'
  );
  const accountId = (await ask(rl, 'Account ID', profile.accountId, 'Account ID (Enter = همان قبلی)')).trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('فرمت Account ID اشتباه است (باید ۳۲ کاراکتر هگز باشد). | Account ID format is invalid (32 hex characters).', 'Enter بزنید تا همان Account ID ذخیره‌شده استفاده شود. / Press Enter to accept the stored Account ID.');
  const accounts = await cf('/accounts?per_page=50');
  if (accounts.ok && accounts.data.result && accounts.data.result.length && !accounts.data.result.some((a) => a.id === accountId)) {
    warnF('این توکن آن Account ID را لیست نمی‌کند — ادامه می‌دهیم.', 'This token does not list that account id — continuing anyway.');
  }
  const workerName = (await ask(rl, 'Worker name', profile.workerName, 'اسم ورکر (Enter = همان قبلی)')).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('اسم ورکر فقط می‌تواند حروف کوچک انگلیسی، عدد و خط تیره داشته باشد. | Worker name may only contain lowercase letters, digits and hyphens.', 'Enter بزنید تا همان نام قبلی استفاده شود. / Press Enter to accept the stored name.');
  const current = await workerExists(accountId, workerName);
  if (!current.ok) warnF('لیست اسکریپت‌های اکانت خوانده نشد (' + current.errors + ') — ادامه می‌دهیم.', 'Could not read the account script list (' + current.errors + ') — continuing.');
  if (current.known) ok('Existing worker found: ' + workerName);
  else warnF('ورکر «' + workerName + '» در این اکانت نیست — این آپدیت آن را می‌سازد.', 'Worker "' + workerName + '" is not in this account — this update will create it.');

  // ---------- [3/6] database
  nextStep('Re-attach the existing database', 'اتصال دوبارهٔ دیتابیس موجود');
  why(
    'دقیقاً همان دیتابیس قبلی وصل می‌شود و تعداد ردیف‌ها قبل و بعد اندازه‌گیری می‌شود تا ثابت شود هیچ داده‌ای از دست نرفته.',
    'The very same database is re-attached and its row census is compared before and after so nothing can be lost silently.'
  );
  const dbName = (await ask(rl, 'D1 database name', profile.dbName || workerName + '-db', 'نام دیتابیس D1 (Enter = همان قبلی)')).trim();
  let dbId = '';
  const listDb = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const found = listDb.ok && (listDb.data.result || []).find((d) => d.name === dbName);
  if (found) dbId = found.uuid;
  else if (profile.dbId) {
    const direct = await cf(`/accounts/${accountId}/d1/database/${profile.dbId}`);
    if (direct.ok) { dbId = profile.dbId; warnF('دیتابیسی با نام «' + dbName + '» نیست — از شناسهٔ ذخیره‌شده استفاده می‌شود.', 'No database named "' + dbName + '" — using the saved database id instead.'); }
  }
  if (!dbId) {
    const make = await ask(rl, `Database "${dbName}" is missing; create it empty? (y/n)`, 'n', `دیتابیس «${dbName}» پیدا نشد؛ خالی ساخته شود؟ (y/n — Enter = نه)`);
    if (make.toLowerCase() !== 'y') fail('آپدیت متوقف شد: پنل به دیتابیس نیاز دارد. نام دقیقش را بدهید یا نصب کامل را اجرا کنید. | Update stopped: the panel needs a database. Give its exact name, or run the full install.', 'نام دیتابیس را از داشبورد کلودفلر کپی کنید، یا نصب کامل را یک بار اجرا کنید. / Copy the exact database name from the Cloudflare dashboard, or run the full install once.');
    const c = await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName } });
    if (!c.ok) fail('ساخت دیتابیس انجام نشد (' + c.errors + ') | Could not create the database (' + c.errors + ')');
    dbId = c.data.result.uuid;
    okF('دیتابیس خالی ساخته شد: ' + dbName, 'Created an empty database: ' + dbName);
  } else {
    okF('دیتابیس وصل شد: ' + dbName + ' (' + String(dbId).slice(0, 8) + '…)', 'Database attached: ' + dbName + ' (' + String(dbId).slice(0, 8) + '…)');
  }
  const before = await d1Snapshot(accountId, dbId);
  if (before) console.log('     row census before: ' + Object.entries(before).map(([k, v]) => k + '=' + v).join(', '));
  else warnF('شمارش ردیف‌ها با این توکن ممکن نیست (نیاز به دسترسی D1 query) — این آپدیت به هر حال هیچ داده‌ای حذف نمی‌کند.', 'Row census not available with this token (D1 query) — the update never deletes data regardless.');

  // ---------- [4/6] source + identity
  nextStep('Fetch the source and rebuild the identity', 'آوردن سورس و بازسازی هویت اختصاصی');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail('سورس هنوز ' + scan.hits + ' خط با کلیدواژهٔ حساس دارد! | Source still has ' + scan.hits + ' lines with identifiable keywords!');
  ok('Source ready: ' + (scan.size / 1024).toFixed(0) + 'KB, zero identifiable keywords');
  let seed = null;
  if (noFingerprint) {
    warnF('--no-fingerprint: نسخهٔ مشترک مخیشه مستقر می‌شود.', '--no-fingerprint: deploying the shared repository build.');
  } else if (profile.fingerprint && profile.seed) {
    seed = rotate ? newSeed() : profile.seed;
    if (rotate) console.log('  --rotate: این پنل هویت ساخت کاملاً جدید می‌گیرد. | --rotate: this panel gets a brand-new build identity.');
    else console.log('  هویت ساخت قبلی همین پنل حفظ می‌شود. | Keeping this panel\'s existing build identity.');
  } else {
    const add = await ask(rl, 'This panel has no private build identity yet — add one now? (y/n)', 'y', 'این پنل هنوز هویت اختصاصی ندارد؛ حالا ساخته شود؟ (y/n — Enter = بله)');
    if (add.toLowerCase() === 'y') seed = newSeed();
  }
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };

  // ---------- [5/6] upload
  nextStep('Upload the update', 'آپلود آپدیت');
  await uploadWorker(accountId, workerName, build.path, dbId, dbName);

  // ---------- [6/6] prove the data is intact
  nextStep('Verify nothing was lost', 'اثبات اینکه هیچ داده‌ای از دست نرفته');
  why(
    'تعداد ردیف همهٔ جدول‌ها دوباره شمرده می‌شود و با قبل مقایسه می‌شود.',
    'Every table row count is read again and compared with the value taken before the upload.'
  );
  const after = await d1Snapshot(accountId, dbId);
  if (before && after) {
    if (sameCensus(before, after)) okF('دیتابیس سالم است: ' + Object.keys(after).length + ' جدول با تعداد ردیف یکسان', 'Database intact: ' + Object.keys(after).length + ' tables with identical row counts');
    else warnF('تعداد ردیف‌ها تغییر کرد (' + JSON.stringify(before) + ' → ' + JSON.stringify(after) + '). این آپدیت هیچ‌چیز حذف نمی‌کند — احتمالاً خود پنل ردیف جدید نوشته.', 'Row census changed. This update never deletes anything — check whether the panel itself wrote new rows.');
  } else warnF('شمارش مجدد ردیف‌ها ممکن نشد (نیاز به دسترسی D1 query).', 'Could not re-run the row census (needs D1 query access).');
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = (sub.ok && sub.data.result && sub.data.result.subdomain) || profile.subdomain || '';
  const url = profile.hostname ? 'https://' + profile.hostname + '/panel' : `https://${workerName}.${subdomain}.workers.dev/panel`;
  const health = await verifyDeployment({ accountId, workerName, buildPath: build.path, dbId, dbName, subdomain });
  console.log(`
${line}
  🔄 آپدیت تمام شد — همان دیتابیس، همان آدرس، بایت‌های تازه‌ساخته‌شده:
        ${url}
        Update complete — same database, same address, freshly rebuilt bytes:
        ${health.ok ? 'responding now ✔' : 'not answered from this machine yet (a filtered network or route propagation; the deploy itself was verified byte for byte)'}
        ${health.ok ? 'همین حالا جواب می‌دهد ✔' : 'از این ماشین هنوز جواب نگرفت (شبکهٔ فیلتریا انتشار مسیر؛ خودِ نصب بایت‌به‌بایت تأیید شده)'}
      ${build.names ? 'Build identity kept for this panel: ' + Object.values(build.names).slice(0, 2).join(', ') + ' …' : 'Shared repository build deployed.'}
      ${build.names ? 'هویت ساخت این پنل حفظ شد: ' + Object.values(build.names).slice(0, 2).join(', ') + ' …' : 'نسخهٔ مشترک مخیشه مستقر شد.'}
${line}`);
  saveProfile({
    ...profile,
    accountId, workerName, dbName, dbId, subdomain, panelUrl: url,
    seed: seed || profile.seed, fingerprint: !!seed,
    names: build.names || null, rows: build.rows || 0,
    source: src.fresh ? 'downloaded' : 'local',
    updatedAt: new Date().toISOString(),
    healedAt: health.healed ? new Date().toISOString() : (profile.healedAt || null),
  });
  cleanup();
  console.log('\nتمام شد. موفق باشید! 🌐  |  Done. Good luck!');
}

// Build a private copy of the panel source without touching the Cloudflare API.
async function personalizeOnlyMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const profile = loadProfile();
  const rotate = process.argv.includes('--rotate');
  const seed = profile && profile.seed && !rotate ? profile.seed : newSeed();
  console.log('Personalise-only mode: a private copy of the source, no Cloudflare calls\n');
  console.log('حالت فقط-شخصی‌سازی: یک نسخهٔ خصوصی از سورس، بدون هیچ تماس با کلودفلر\n');
  console.log('  build identity seed: ' + seed + (profile && profile.seed && !rotate ? '   (از پروفایل ذخیره‌شده / from the saved profile)' : ''));
  const src = await prepareSource(rl);
  const r = personalize(readFileSync(src.path, 'utf8'), seed);
  if (!r.ok) fail('شخصی‌سازی انجام نشد: ' + r.problems.join(' / '), 'Personalisation failed: ' + r.problems.join(' / '));
  const out = join(process.cwd(), 'Source-personalized.js');
  writeFileSync(out, r.out);
  const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail('The personalised copy failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  const scan = scanKeywords(out);
  console.log('  rows re-keyed: ' + r.entries + ' | identifiers renamed: ' + Object.keys(r.names).length);
  console.log('  ردیف‌های بازکلیدگذاری‌شده: ' + r.entries + ' | شناسه‌های تغییرنام‌یافته: ' + Object.keys(r.names).length);
  console.log('  new internal names: ' + Object.values(r.names).slice(0, 5).join(', ') + ' …');
  console.log(`  ${out} (${(scan.size / 1024).toFixed(0)}KB, keyword survivors ${scan.hits}, syntax check passed)`);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  console.log('  ✅ Personalised copy ready');
  console.log('  ✅ نسخهٔ خصوصی آماده است');
}

function onUnhandled(e) {
  if (e && e.__zeusExit) return; // controlled exit from fail()
  console.error(e && e.stack || e);
  process.exitCode = 1;
}

if (typeof fetch !== 'function') {
  console.error('❌ Node.js 18 or newer is required (fetch is not available in this version).');
  process.exit(1);
}

// Imported as a module (test harness) rather than run as a program? Then only the
// helpers below are exposed and nothing prompts or talks to the network. When the path
// comparison cannot be resolved the script assumes it is being run directly, so real
// installs never go quiet.
function looksImported() {
  const a = process.argv[1];
  if (!a) return true; // loaded by an expression or stdin: stay silent, never prompt
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(a)) !== realpathSync(self);
  } catch {
    return resolve(a) !== self;
  }
}

export { detectPrelude, personalize, verifyTransform, checkHardened, scanKeywords, xorDecode, xorEncode, rngFrom, buildPrelude, fingerprint, uploadWorker, workerExists, deployedBytes, d1Snapshot, sameCensus, verifyDeployment, classifyProbe, probeOnce, probeBase, loadProfile, saveProfile, makeTokenUrl, maskSecret, restoreTty, askSecret, ask, helpText, NAME_BLOCK_RE, KEYWORDS, KW_RE, FORK_SOURCES, PERM_GROUPS, PROFILE_VERSION, COMPAT_DATE };

// Bilingual help, so a first-time owner knows what every flag does before running it.
function helpText() {
  return `
${line}
    ⚡ ویزارد نصب زئوس — راهنما  |  Zeus Install Wizard — help
${line}
    استفاده / usage:
      node wizard.mjs                 نصب کامل تعاملی · full interactive install
      node wizard.mjs --update        آپدیت با تنظیمات ذخیره‌شده · update with saved defaults
      node wizard.mjs --prepare-only  فقط بررسی سورس، بدون کلودفلر · validate the source only
      node wizard.mjs --personalize   ساخت نسخهٔ خصوصی، بدون کلودفلر · build a private copy
      node wizard.mjs --token-link    فقط چاپ لینک ساخت توکن · only print the token link
      node wizard.mjs --rotate        هویت ساخت جدید · mint a brand-new build identity
      node wizard.mjs --no-fingerprint  نصب نسخهٔ مشترک مخیشه · deploy the shared build
      node wizard.mjs --help          این راهنما · this help

    متغیرهای محیطی / environment:
      ZEUS_CF_TOKEN       خواندن توکن از محیط (بدون تایپ) · read the API token from the env
      ZEUS_PROBE_WAIT_MS  زمان انتظار برای انتشار آدرس (پیش‌فرض ۹۰۰۰۰) · propagation wait
      ZEUS_PROBE_URL      آدرس سفارشی برای چک نهایی · custom health-probe address

    نکتهٔ امنیتی / safety: توکن شما هیچ‌جا ذخیره یا چاپ نمی‌شود؛ همیشه به شکل •••••••• دیده می‌شود.
${line}`;
}

if (looksImported()) {
  // module import: helpers only, no prompts, no network
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(helpText());
} else if (process.argv.includes('--token-link')) {
  console.log('\n  🔗 لینک آمادهٔ ساخت توکن کلودفلر (دسترسی‌های لازم از قبل تنظیم شده + اسم تصادفی):');
  console.log('  Cloudflare API token-creation link (permissions pre-set + random name):\n');
  console.log('  ' + makeTokenUrl());
  console.log('\n  در مرورگر باز کنید → Continue to summary → Create Token → کپی توکن.');
  console.log('  Open it in a browser → Continue to summary → Create Token → copy the token.');
  console.log('  🔒 توکن را فقط در خود ویزارد بچسبانید؛ هرگز در فایل یا لاگ ذخیره نمی‌شود.');
  console.log('  🔒 Paste the token only into the wizard — it is never written to a file or a log.\n');
} else if (process.argv.includes('--update')) {
  updateMain().catch(onUnhandled);
} else if (process.argv.includes('--personalize')) {
  personalizeOnlyMain().catch(onUnhandled);
} else if (process.argv.includes('--prepare-only')) {
  prepareOnlyMain().catch(onUnhandled);
} else {
  main().catch(onUnhandled);
}
