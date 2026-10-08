#!/usr/bin/env node
/*
 * Zeus Install Wizard — automated installer for the hardened Zeus panel on Cloudflare
 * Flow: token-creation link (random name) → account → D1 → worker upload → subdomain → custom domain
 * The panel source is read from this repository (fork axionspace/Z-E-U-S) — no npm
 * packages, Node.js 18+ only.
 *
 * Usage:
 *   node wizard.mjs                (full interactive install)
 *   node wizard.mjs --prepare-only (fetch/validate the source only, no Cloudflare API calls)
 *   node wizard.mjs --token-link   (just print a token-creation link with a random name)
 *
 * Requirement: Node.js 18+
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomInt } from 'node:crypto';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = 'https://api.cloudflare.com/client/v4';
// Mirrors of the hardened source served from this repository; jsdelivr is usually
// reachable from Iran without a VPN.
const FORK_SOURCES = [
  'https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/Source.js',
];
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
const totalSteps = 9;

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
     5. Upload the worker and enable the workers.dev address
     6. (Optional) Attach a custom domain
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
// The source must be the hardened build: _ZK table present, zero identifiable keywords
function checkHardened(txt) {
  const hits = txt.split('\n').filter((l) => KW_RE.test(l)).length;
  return {
    hits,
    valid: txt.length > 800000 && txt.includes('const _ZK') && txt.includes('function _G') && hits === 0,
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

  // 2) Download from this repository (several mirrors; jsdelivr usually works from Iran without a VPN)
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

// ---------------------------------------------------------------- main
async function main() {
  banner();
  const prepareOnly = process.argv.includes('--prepare-only');

  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const cleanup = () => { try { rl && rl.close(); } catch {} };
  process.on('SIGINT', () => { console.log('\n\nCancelled.'); cleanup(); process.exit(130); });

  // ---------- [1/9] token
  nextStep('Validate API token');
  const tokenUrl = makeTokenUrl();
  console.log('  Open this link in your browser — every required permission is pre-configured');
  console.log('  and the token name is already randomized:');
  console.log(`     ${tokenUrl}`);
  console.log('  (Continue to summary → Create Token → copy the created token and paste it here)');
  TOKEN = await askSecret(rl, 'Enter your Cloudflare API token');
  const verify = await cf('/user/tokens/verify');
  if (!verify.ok) fail('Token is not valid (' + verify.errors + ')', 'Create the token again with the listed permissions.');
  ok('Token is valid' + (verify.data.result?.status ? ` (status: ${verify.data.result.status})` : ''));

  // ---------- [2/9] account
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

  // ---------- [3/9] worker name
  nextStep('Worker name');
  const suggestedName = 'web-' + randName(5);
  console.log('  Tip: a neutral random name lowers the ban risk — press Enter to accept the random suggestion.');
  const workerName = (await ask(rl, 'Worker name', suggestedName)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('Worker name may only contain lowercase letters, digits and hyphens.');

  // ---------- [4/9] subdomain
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

  // ---------- [5/9] D1
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

  // ---------- [6/9] source
  nextStep('Prepare hardened source');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail(`Source still has ${scan.hits} lines with identifiable keywords!`);
  ok(`Source is ready: ${src.path} (${(scan.size / 1024).toFixed(0)}KB, zero identifiable keywords)`);

  // ---------- [7/9] upload
  nextStep('Upload worker');
  const exists = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`);
  if (exists.ok) {
    const overwrite = await ask(rl, `Worker "${workerName}" already exists; overwrite it? (y/n)`, 'y');
    if (overwrite.toLowerCase() !== 'y') fail('Cancelled by user.');
  }
  const form = new FormData();
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: COMPAT_DATE,
    bindings: [{ type: 'd1', name: 'DB', id: dbId }],
  };
  form.append('metadata', new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }));
  form.append('worker.js', new File([readFileSync(src.path)], 'worker.js', { type: 'application/javascript+module' }));
  const up = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'PUT', body: form });
  if (!up.ok) fail('Worker upload failed (' + up.errors + ')', up.status === 413 ? 'Script is too large — build a different source version.' : 'Check Workers Scripts/Edit access in the token.');
  ok(`Worker uploaded (${(scan.size / 1024).toFixed(0)}KB, D1 binding: ${dbName})`);

  // ---------- [8/9] enable workers.dev
  nextStep('Enable public address');
  const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: 'POST', body: { enabled: true, previews_enabled: false },
  });
  if (!en.ok) warn('Subdomain enable failed (' + en.errors + ') — you can enable it from the dashboard.');
  else ok(`Enabled: https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev`);

  // ---------- [9/9] health check + summary
  nextStep('Final check & summary');
  const panelUrl = `https://${workerName}${subdomain ? '.' + subdomain : ''}.workers.dev/panel`;
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
  ⚠️  Three important notes:
     1. If you ever use the "Update panel" button inside the panel, the author's own
        build replaces the hardened one — to restore it, run this wizard again.
     2. For use inside Iran, complete the custom-domain step (you can also do it
        right now).
     3. Keep your API token private; this wizard never stores it.
${line}`);

  // ---------- optional custom domain
  const wantDomain = await ask(rl, 'Do you have a custom domain you want to attach? (y/n)', 'n');
  if (wantDomain.toLowerCase() === 'y') {
    const zones = await cf('/zones?per_page=50');
    if (!zones.ok || !zones.data.result?.length) {
      warn('Could not list zones (' + (zones.errors || 'Zone:Read access required') + '). You can do this later from the dashboard.');
    } else {
      zones.data.result.forEach((z, i) => console.log(`     ${i + 1}) ${z.name}`));
      const zi = parseInt(await ask(rl, 'Domain number', '1'), 10);
      const zone = zones.data.result[zi - 1];
      if (!zone) warn('Invalid selection; skipped.');
      else {
        const hostname = (await ask(rl, `Subdomain to use on ${zone.name} (e.g. panel)`, 'panel')) + '.' + zone.name;
        const cd = await cf(`/accounts/${accountId}/workers/domains`, {
          method: 'POST',
          body: { environment: 'production', hostname, service: workerName, zone_id: zone.id },
        });
        if (!cd.ok) warn('Domain attach failed (' + cd.errors + ') — from the dashboard: Workers → Settings → Domains');
        else {
          ok(`Domain attached: https://${hostname}/panel`);
          console.log(`     (DNS record and certificate are created automatically; allow a few minutes)`);
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

function onUnhandled(e) {
  if (e && e.__zeusExit) return; // controlled exit from fail()
  console.error(e && e.stack || e);
  process.exitCode = 1;
}

if (typeof fetch !== 'function') {
  console.error('❌ Node.js 18 or newer is required (fetch is not available in this version).');
  process.exit(1);
}

if (process.argv.includes('--token-link')) {
  console.log('\nCloudflare API token-creation link (permissions pre-set + random name):\n\n  ' + makeTokenUrl() + '\n\nOpen it in a browser → Continue to summary → Create Token → copy the token.\n');
} else if (process.argv.includes('--prepare-only')) {
  prepareOnlyMain().catch(onUnhandled);
} else {
  main().catch(onUnhandled);
}
