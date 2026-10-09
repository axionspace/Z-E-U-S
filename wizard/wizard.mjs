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
const line = '─'.repeat(58);
function banner() {
  console.log(`
${line}
   ⚡ Zeus Install Wizard — automated installer for the hardened panel
${line}
   This wizard will:
     1. Generate a pre-configured API-token link (random name) and validate the token
     2. Pick your account and a worker name (random suggestion)
     3. Create a D1 database and bind it
     4. Fetch the hardened source from this repository (zero identifiable keywords)
     5. Re-key and rename it so this install carries its own build fingerprint
     6. Upload the worker, enable the workers.dev address, save the install profile
     7. (Optional) Attach a custom domain
   Later on, "node wizard.mjs --update" re-deploys with those saved defaults.
${line}`);
}
function bannerUpdate(profile) {
  console.log(`
${line}
   ⚡ Zeus Install Wizard — manual update (saved defaults)
${line}
     account : ${profile.accountName || profile.accountId}
     worker  : ${profile.workerName}
     database: ${profile.dbName || '(none)'}${profile.dbId ? ' (' + String(profile.dbId).slice(0, 8) + '…)' : ''}
     address : ${profile.panelUrl || '(unknown)'}
     identity: ${profile.names ? Object.values(profile.names).slice(0, 2).join(', ') + ' …' : 'shared repository build'}
   Nothing is deleted by this run: the D1 database, its rows, the workers.dev
   address and any attached domain are all left exactly as they are.
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

async function ask(rl, q, def = '') {
  const prompt = `  ${q}${def ? ` [${def}]` : ''}: `;
  if (pipedLines) {
    const a = nextPiped();
    if (a === null) {
      if (def) { console.log(prompt + def + '   (default — piped input ran out)'); return def; }
      fail('Piped input ran out and no answer is left for: ' + q);
    }
    console.log(prompt + (a === '' && def ? `${def}   (default)` : a));
    return a || def;
  }
  const a = (await rl.question(prompt)).trim();
  return a || def;
}

async function askSecret(rl, q) {
  const prompt = `  ${q}: `;
  if (pipedLines) {
    let a = nextPiped();
    while (a === '') a = nextPiped(); // an empty token is meaningless; skip empty lines
    if (a === null) fail('Piped input ran out and no value is left for "' + q + '".');
    console.log(prompt + '••••••••   (read from standard input)');
    return a.trim();
  }
  // Hidden input on the same interface: output is temporarily muted so the
  // characters are not echoed back.
  const orig = rl.output;
  const muted = new Writable({
    write(chunk, _enc, cb) {
      if (String(chunk).includes('\n')) orig.write('\n');
      cb();
    },
  });
  let a = '';
  try {
    orig.write(prompt);
    rl.output = muted;
    do { a = (await rl.question('')).trim(); } while (!a);
  } finally { rl.output = orig; }
  return a;
}

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
let activeRl = null; // for a clean readline exit (avoids the Windows assert)
function fail(msg, hint) {
  console.error(`\n  ❌ ${msg}`);
  if (hint) console.error(`     💡 ${hint}`);
  process.exitCode = 1;
  try { process.stdin.pause(); } catch {}
  try { activeRl && activeRl.close(); } catch {}
  throw { __zeusExit: true };
}
function nextStep(title) {
  step++;
  console.log(`\n${line}\n  [${step}/${totalSteps}] ${title}\n${line}`);
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

function newName(rng, body, taken) {
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  for (let tries = 0; tries < 500; tries++) {
    let n = '_';
    const len = 5 + rng.int(4);
    for (let i = 0; i < len; i++) n += abc[rng.int(26)];
    if (taken.has(n)) continue;
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
  if (out.length < 800000) problems.push('personalised build looks truncated: ' + out.length + ' bytes');
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
async function d1Snapshot(accountId, dbId) {
  const q = async (sql) => {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql } });
    if (!r.ok) return null;
    const res = r.data && r.data.result;
    return res && (res.rows || res.results) ? (res.rows || res.results) : null;
  };
  const tables = await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  if (!tables) return null;
  const census = {};
  for (const row of tables) {
    const c = await q('SELECT COUNT(*) AS n FROM "' + String(row.name).replace(/"/g, '') + '"');
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
    if (!/filename="worker\.js"/i.test(p.slice(0, 1500))) continue;
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
    console.log('     (new worker — nothing to preserve)');
  } else {
    warn('Could not read current worker settings (' + settings.errors + ') — uploading with the standard D1 binding.');
  }
  const form = new FormData();
  form.append('metadata', new File([JSON.stringify({ main_module: 'worker.js', compatibility_date: compat, bindings })], 'metadata.json', { type: 'application/json' }));
  form.append('worker.js', new File([bytes], 'worker.js', { type: 'application/javascript+module' }));
  const up = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'PUT', body: form });
  if (!up.ok) fail('Worker upload failed (' + up.errors + ')', up.status === 413 ? 'Script is too large — build a different source version.' : 'Check Workers Scripts/Edit access in the token.');
  ok('Worker uploaded (' + (bytes.length / 1024).toFixed(0) + 'KB, D1: ' + (dbName || 'DB') + ', compat ' + compat + ')');
  const back = await deployedBytes(accountId, workerName);
  if (back.ok && back.bytes) {
    const a = sha256hex(back.bytes), b = sha256hex(bytes);
    if (a === b) ok('Read-back matches: the deployed script is byte-identical to this build (' + back.bytes.length + 'B, sha256 ' + a.slice(0, 12) + '…)');
    else warn('Read-back differs from the local build (deployed ' + a.slice(0, 12) + ' vs local ' + b.slice(0, 12) + ') — re-run the update.');
  } else {
    warn('Could not read the deployed script back for comparison (' + (back.errors || 'HTTP ' + back.status) + ').');
  }
  return up;
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
  nextStep('Validate API token');
  const tokenUrl = makeTokenUrl();
  console.log('  Open this link in your browser — every required permission is pre-configured');
  console.log('  and the token name is already randomized:');
  console.log(`     ${tokenUrl}`);
  console.log('  (Continue to summary → Create Token → copy the created token and paste it here)');
  const envTok = tokenFromEnv();
  if (envTok) {
    TOKEN = envTok;
    console.log('  API token read from the ZEUS_CF_TOKEN environment variable (not stored anywhere).');
  } else {
    TOKEN = await askSecret(rl, 'Enter your Cloudflare API token');
  }
  const verify = await cf('/user/tokens/verify');
  if (!verify.ok) fail('Token is not valid (' + verify.errors + ')', 'Create the token again with the listed permissions.');
  ok('Token is valid' + (verify.data.result?.status ? ` (status: ${verify.data.result.status})` : ''));

  // ---------- [2/10] account
  nextStep('Select account');
  let accounts = await cf('/accounts?per_page=50');
  let accountId, accountName;
  if (!accounts.ok || !accounts.data.result?.length) {
    warn('Could not list accounts with this token (' + (accounts.errors || 'no access') + ')');
    accountId = await ask(rl, 'Enter your Account ID manually (from the overview page of your domain/worker)');
    if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Account ID format is invalid (32 hex characters).');
    accountName = accountId;
  } else if (accounts.data.result.length === 1) {
    accountId = accounts.data.result[0].id;
    accountName = accounts.data.result[0].name;
    ok(`Account: ${accountName}`);
  } else {
    accounts.data.result.forEach((a, i) => console.log(`     ${i + 1}) ${a.name}  (${a.id.slice(0, 8)}...)`));
    const idx = parseInt(await ask(rl, 'Account number', '1'), 10);
    const picked = accounts.data.result[idx - 1];
    if (!picked) fail('Invalid selection.');
    accountId = picked.id; accountName = picked.name;
    ok(`Account: ${accountName}`);
  }

  // ---------- [3/10] worker name
  nextStep('Worker name');
  const suggestedName = profile.workerName || 'web-' + randName(5);
  if (profile.workerName) console.log(`  An install profile exists in this folder — press Enter to reuse "${profile.workerName}", or type another name for a second panel.`);
  else console.log('  Tip: a neutral random name lowers the ban risk — press Enter to accept the random suggestion.');
  const workerName = (await ask(rl, 'Worker name', suggestedName)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('Worker name may only contain lowercase letters, digits and hyphens.');

  // ---------- [4/10] subdomain
  nextStep('workers.dev address');
  let subdomain = '';
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  if (sub.ok && sub.data.result?.subdomain) {
    subdomain = sub.data.result.subdomain;
    ok(`Final address will be: https://${workerName}.${subdomain}.workers.dev`);
  } else {
    warn('Could not fetch the subdomain (' + (sub.errors || '') + ') — continuing anyway.');
  }
  warn('Note: workers.dev is blocked in Iran; attach a custom domain for use inside Iran (final step).');

  // ---------- [5/10] D1
  nextStep('Create D1 database');
  const dbName = workerName + '-db';
  let dbId = '';
  const listDb = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const existing = listDb.ok && (listDb.data.result || []).find((d) => d.name === dbName);
  if (existing) {
    dbId = existing.uuid;
    ok(`Using existing database: ${dbName} (${dbId.slice(0, 8)}...)`);
  } else {
    const created = await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName } });
    if (!created.ok) fail('D1 database creation failed (' + created.errors + ')', 'Make sure the token has D1/Edit access and your account has D1 (the free plan includes it).');
    dbId = created.data.result.uuid;
    ok(`Database created: ${dbName}`);
  }

  // ---------- [6/10] source
  nextStep('Prepare hardened source');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail(`Source still has ${scan.hits} lines with identifiable keywords!`);
  ok(`Source is ready: ${src.path} (${(scan.size / 1024).toFixed(0)}KB, zero identifiable keywords)`);

  // ---------- [7/10] fingerprint
  nextStep('Personalise this build');
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };
  if (!seed) warn('Fingerprint skipped (--no-fingerprint) — the shared repository build is deployed.');

  // ---------- [8/10] upload
  nextStep('Upload worker');
  const exists = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`);
  if (exists.ok) {
    const overwrite = await ask(rl, `Worker "${workerName}" already exists; overwrite it? (y/n)`, 'y');
    if (overwrite.toLowerCase() !== 'y') fail('Cancelled by user.');
    else console.log('     (only the script is replaced — D1 data, the workers.dev address and any attached domain are kept)');
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
  nextStep('Enable public address');
  const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: 'POST', body: { enabled: true, previews_enabled: false },
  });
  if (!en.ok) warn('Subdomain enable failed (' + en.errors + ') — you can enable it from the dashboard.');
  else ok(`Enabled: https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev`);

  // ---------- [10/10] health check + summary
  nextStep('Final check & summary');
  let reachable = false;
  try {
    const probe = await fetch(`https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev/`, { signal: AbortSignal.timeout(12000) });
    reachable = probe.status >= 200 && probe.status < 500;
  } catch { reachable = false; }
  if (reachable) ok('Worker is reachable and responding ✔');
  else warn('Could not reach the workers.dev address from this system — normal inside Iran (workers.dev is filtered); the install itself completed fine.');

  console.log(`
${line}
  🎉 Install complete!

     Panel address (to set the admin password the first time):
       ${panelUrl}

     User subscription pattern:
       https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev/sub/<username>

${line}
  ⚠️  Four important notes:
     1. This deployment has its own build identity${build.names ? ' (' + Object.values(build.names).slice(0, 2).join(', ') + ' …)' : ''} — it is not
        byte-identical to anybody else's install of the same panel.
     2. If you ever use the "Update panel" button inside the panel, the author's own
        build replaces this one — restore it with: node wizard.mjs --update
     3. For use inside Iran, complete the custom-domain step (you can also do it
        right now).
     4. Keep your API token private; this wizard never stores it.
${line}`);

  // ---------- optional custom domain
  const wantDomain = await ask(rl, 'Do you have a custom domain you want to attach? (y/n)', 'n');
  if (wantDomain.toLowerCase() === 'y') {
    // Listing zones needs a token with Zone:Read — the wizard-created token does not include it,
    // so fall back to the manual Zone ID route (attaching itself only needs Workers Scripts access).
    const zones = await cf('/zones?per_page=50');
    let zoneId = '';
    let hostname = '';
    if (zones.ok && zones.data.result?.length) {
      zones.data.result.forEach((z, i) => console.log(`     ${i + 1}) ${z.name}`));
      const zi = parseInt(await ask(rl, 'Domain number', '1'), 10);
      const zone = zones.data.result[zi - 1];
      if (!zone) {
        warn('Invalid selection; skipped.');
      } else {
        zoneId = zone.id;
        hostname = (await ask(rl, `Subdomain to use on ${zone.name} (e.g. panel)`, 'panel')).trim().toLowerCase() + '.' + zone.name;
      }
    } else {
      warn('Could not list zones (' + (zones.errors || 'Zone:Read access required') + ').');
      console.log('  You can still attach it now: open the Cloudflare dashboard, open your domain,');
      console.log('  and copy the "Zone ID" from the right sidebar of the Overview page.');
      zoneId = (await ask(rl, 'Zone ID (press Enter to skip and do it later from the dashboard)', '')).trim();
      if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) {
        warn('Zone ID format is invalid (32 hex characters); skipped.');
        zoneId = '';
      }
      if (zoneId) hostname = (await ask(rl, 'Full hostname for the panel (e.g. panel.mydomain.com)', '')).trim().toLowerCase();
    }
    if (zoneId && hostname) {
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
        warn('Hostname looks invalid; skipped — you can attach it later from the dashboard (Worker → Settings → Domains).');
      } else {
        const domBody = { environment: 'production', hostname, service: workerName, zone_id: zoneId };
        // API docs list PUT for attaching a domain; POST kept as a fallback for robustness.
        let cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'PUT', body: domBody });
        if (!cd.ok && (cd.status === 404 || cd.status === 405)) {
          cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'POST', body: domBody });
        }
        if (!cd.ok) warn('Domain attach failed (' + cd.errors + ') — from the dashboard: Worker → Settings → Domains');
        else {
          ok(`Domain attached: https://${hostname}/panel`);
          console.log('     (DNS record and certificate are created automatically; allow a few minutes)');
          prof.hostname = hostname;
          prof.panelUrl = `https://${hostname}/panel`;
          prof.updatedAt = new Date().toISOString();
          saveProfile(prof, true);
          ok('Profile updated with the domain address: ' + prof.panelUrl);
        }
      }
    }
  }

  cleanup();
  console.log('\nDone. Good luck! 🌐');
}

// Source preparation without any token / Cloudflare network access (for testing)
async function prepareOnlyMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  console.log('Prepare-only mode: source preparation only\n');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  console.log(`  File: ${src.path}`);
  console.log(`  Size: ${(scan.size / 1024).toFixed(0)}KB | identifiable keywords: ${scan.hits}`);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  console.log('  ✅ Preparation successful');
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
  nextStep('Validate API token');
  const envTok = tokenFromEnv();
  if (envTok) {
    TOKEN = envTok;
    console.log('  API token read from the ZEUS_CF_TOKEN environment variable (not stored anywhere).');
  } else {
    TOKEN = await askSecret(rl, 'Enter your Cloudflare API token');
  }
  const verify = await cf('/user/tokens/verify');
  if (!verify.ok) fail('Token is not valid (' + verify.errors + ')', 'Create the token again with the listed permissions.');
  ok('Token is valid');

  // ---------- [2/6] target
  nextStep('Confirm what to update');
  const accountId = (await ask(rl, 'Account ID', profile.accountId)).trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Account ID format is invalid (32 hex characters).');
  const accounts = await cf('/accounts?per_page=50');
  if (accounts.ok && accounts.data.result && accounts.data.result.length && !accounts.data.result.some((a) => a.id === accountId)) {
    warn('This token does not list that account id — continuing anyway.');
  }
  const workerName = (await ask(rl, 'Worker name', profile.workerName)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('Worker name may only contain lowercase letters, digits and hyphens.');
  const current = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`);
  if (current.ok) ok('Existing worker found: ' + workerName);
  else warn('Worker "' + workerName + '" not found (' + current.errors + ') — this update will create it.');

  // ---------- [3/6] database
  nextStep('Re-attach the existing database');
  const dbName = (await ask(rl, 'D1 database name', profile.dbName || workerName + '-db')).trim();
  let dbId = '';
  const listDb = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const found = listDb.ok && (listDb.data.result || []).find((d) => d.name === dbName);
  if (found) dbId = found.uuid;
  else if (profile.dbId) {
    const direct = await cf(`/accounts/${accountId}/d1/database/${profile.dbId}`);
    if (direct.ok) { dbId = profile.dbId; warn('No database named "' + dbName + '" — using the saved database id instead.'); }
  }
  if (!dbId) {
    const make = await ask(rl, `Database "${dbName}" is missing; create it empty? (y/n)`, 'n');
    if (make.toLowerCase() !== 'y') fail('Update stopped: the panel needs a database. Give its exact name, or run the full install.');
    const c = await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName } });
    if (!c.ok) fail('Could not create the database (' + c.errors + ')');
    dbId = c.data.result.uuid;
    ok('Created an empty database: ' + dbName);
  } else {
    ok('Database attached: ' + dbName + ' (' + String(dbId).slice(0, 8) + '…)');
  }
  const before = await d1Snapshot(accountId, dbId);
  if (before) console.log('     row census before: ' + Object.entries(before).map(([k, v]) => k + '=' + v).join(', '));
  else warn('Row census not available with this token (D1 query) — the update never deletes data regardless.');

  // ---------- [4/6] source + identity
  nextStep('Fetch the source and rebuild the identity');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail('Source still has ' + scan.hits + ' lines with identifiable keywords!');
  ok('Source ready: ' + (scan.size / 1024).toFixed(0) + 'KB, zero identifiable keywords');
  let seed = null;
  if (noFingerprint) {
    warn('--no-fingerprint: deploying the shared repository build.');
  } else if (profile.fingerprint && profile.seed) {
    seed = rotate ? newSeed() : profile.seed;
    console.log(rotate ? '  --rotate: this panel gets a brand-new build identity.' : '  Keeping this panel\'s existing build identity.');
  } else {
    const add = await ask(rl, 'This panel has no private build identity yet — add one now? (y/n)', 'y');
    if (add.toLowerCase() === 'y') seed = newSeed();
  }
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };

  // ---------- [5/6] upload
  nextStep('Upload the update');
  await uploadWorker(accountId, workerName, build.path, dbId, dbName);

  // ---------- [6/6] prove the data is intact
  nextStep('Verify nothing was lost');
  const after = await d1Snapshot(accountId, dbId);
  if (before && after) {
    if (sameCensus(before, after)) ok('Database intact: ' + Object.keys(after).length + ' tables with identical row counts');
    else warn('Row census changed (' + JSON.stringify(before) + ' → ' + JSON.stringify(after) + '). This update never deletes anything — check whether the panel itself wrote new rows.');
  } else warn('Could not re-run the row census (needs D1 query access).');
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = (sub.ok && sub.data.result && sub.data.result.subdomain) || profile.subdomain || '';
  const url = profile.hostname ? 'https://' + profile.hostname + '/panel' : `https://${workerName}.${subdomain}.workers.dev/panel`;
  let reachable = false;
  try {
    const p = await fetch(url, { signal: AbortSignal.timeout(12000) });
    reachable = p.status >= 200 && p.status < 500;
  } catch { reachable = false; }
  console.log(`
${line}
  🔄 Update complete — same database, same address, freshly rebuilt bytes:
       ${url}
       ${reachable ? 'responding now ✔' : 'not reachable from this machine (workers.dev is filtered in Iran; the deploy itself succeeded)'}
     ${build.names ? 'Build identity kept for this panel: ' + Object.values(build.names).slice(0, 2).join(', ') + ' …' : 'Shared repository build deployed.'}
${line}`);
  saveProfile({
    ...profile,
    accountId, workerName, dbName, dbId, subdomain, panelUrl: url,
    seed: seed || profile.seed, fingerprint: !!seed,
    names: build.names || null, rows: build.rows || 0,
    source: src.fresh ? 'downloaded' : 'local',
    updatedAt: new Date().toISOString(),
  });
  cleanup();
  console.log('\nDone. Good luck! 🌐');
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
  console.log('  build identity seed: ' + seed + (profile && profile.seed && !rotate ? '   (from the saved profile)' : ''));
  const src = await prepareSource(rl);
  const r = personalize(readFileSync(src.path, 'utf8'), seed);
  if (!r.ok) fail('Personalisation failed: ' + r.problems.join(' / '));
  const out = join(process.cwd(), 'Source-personalized.js');
  writeFileSync(out, r.out);
  const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail('The personalised copy failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  const scan = scanKeywords(out);
  console.log('  rows re-keyed: ' + r.entries + ' | identifiers renamed: ' + Object.keys(r.names).length);
  console.log('  new internal names: ' + Object.values(r.names).slice(0, 5).join(', ') + ' …');
  console.log(`  ${out} (${(scan.size / 1024).toFixed(0)}KB, keyword survivors ${scan.hits}, syntax check passed)`);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  console.log('  ✅ Personalised copy ready');
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
  if (!a) return false;
  try {
    return realpathSync(resolve(a)) !== realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export { detectPrelude, personalize, verifyTransform, checkHardened, scanKeywords, xorDecode, xorEncode, rngFrom, buildPrelude, fingerprint, uploadWorker, deployedBytes, d1Snapshot, sameCensus, loadProfile, saveProfile, makeTokenUrl, KEYWORDS, KW_RE, FORK_SOURCES, PERM_GROUPS, PROFILE_VERSION, COMPAT_DATE };

if (looksImported()) {
  // module import: helpers only, no prompts, no network
} else if (process.argv.includes('--token-link')) {
  console.log('\nCloudflare API token-creation link (permissions pre-set + random name):\n\n  ' + makeTokenUrl() + '\n\nOpen it in a browser → Continue to summary → Create Token → copy the token.\n');
} else if (process.argv.includes('--update')) {
  updateMain().catch(onUnhandled);
} else if (process.argv.includes('--personalize')) {
  personalizeOnlyMain().catch(onUnhandled);
} else if (process.argv.includes('--prepare-only')) {
  prepareOnlyMain().catch(onUnhandled);
} else {
  main().catch(onUnhandled);
}
