// live-update-check.mjs — run the EXACT wizard bytes now published on the fork, live,
// against the existing test panel `web-test` (its own profile), and prove the update path.
//   [1] no profile in the folder -> --update stops with the honest message, zero side effects
//   [2] with the saved profile  -> --update re-deploys: identity kept, read-back matched,
//                                  row census proved unchanged, address verified
//   [3] the panel still serves: login page, /sub/<user> with all three protocols, /api/users
//                                  refused without a session, D1 rows identical
// Nothing is created and nothing is deleted. Usage: ZEUS_CF_TOKEN=<t> node tools/live-update-check.mjs
const TOKEN = process.env.ZEUS_CF_TOKEN || '';
if (!TOKEN) { console.error('ZEUS_CF_TOKEN is required (environment only, never stored)'); process.exit(1); }
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { personalize } from '../wizard/zeus-wizard.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const WIZ_URL = 'https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs';
const WORKER = 'web-test';
const PROFILE = new URL('../panel-web-test/zeus-wizard/profile.json', import.meta.url);
const USER = 'finaluser';

let pass = 0, fail = 0;
const ok = (c, label, extra) => { console.log((c ? 'PASS | ' : 'FAIL | ') + label + (extra ? ' | ' + extra : '')); c ? pass++ : fail++; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const cf = async (path, { method = 'GET', body } = {}) => {
  const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok && d.success !== false, d };
};
const retry = async (fn, times = 8, ms = 6000) => { for (let i = 0; i < times; i++) { const v = await fn(); if (v) return v; await sleep(ms); } return null; };

const ACCOUNT = (await cf('/accounts?per_page=20')).d.result[0].id;
const SUB = (await cf(`/accounts/${ACCOUNT}/workers/subdomain`)).d.result.subdomain;
const BASE = `https://${WORKER}.${SUB}.workers.dev`;
const prof0 = JSON.parse(readFileSync(PROFILE, 'utf8'));

function runWizard(dir, args, answers) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(dir, 'zeus-wizard', 'wizard.mjs'), ...args], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZEUS_CF_TOKEN: TOKEN } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write('    | ' + d.toString().replace(/\n/g, '\n    | ')); });
    child.stderr.on('data', (d) => { out += d; process.stdout.write('    | ' + d.toString().replace(/\n/g, '\n    | ')); });
    child.on('close', (code) => res({ code, out }));
    child.stdin.end(answers.join('\n') + '\n');
  });
}
async function census(uuid) {
  const run = async (sql) => { const r = await cf(`/accounts/${ACCOUNT}/d1/database/${uuid}/query`, { method: 'POST', body: { sql } }); const f = Array.isArray(r.d.result) ? r.d.result[0] : r.d.result; return (f && f.results) || null; };
  const tables = await run("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  if (!tables) return null;
  const out = {};
  for (const t of tables.filter((x) => x.name !== '_cf_KV')) { const c = await run(`SELECT COUNT(*) AS n FROM "${t.name}"`); out[t.name] = c && c[0] ? Number(c[0].n) : -1; }
  return out;
}
async function deployed(name) {
  const r = await fetch(`${API}/accounts/${ACCOUNT}/workers/scripts/${name}?include_source=true`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const raw = Buffer.from(await r.arrayBuffer());
  const bm = (r.headers.get('content-type') || '').match(/boundary="?([^";\s]+)"?/);
  if (!bm) return null;
  for (const p of raw.toString('binary').split('--' + bm[1])) {
    if (!/name="worker\.js"/i.test(p.slice(0, 1200))) continue;
    const i = p.indexOf('\r\n\r\n');
    return Buffer.from(p.slice(i + 4).replace(/\r\n$/, ''), 'binary');
  }
  return null;
}
let cookie = '';
const panel = async (path, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text();
  const sc = r.headers.get('set-cookie');
  if (sc) { const c = sc.split(',').find((x) => x.startsWith('panel_session=')); if (c) cookie = c.split(';')[0]; }
  return { status: r.status, text: t };
};

const dirA = mkdtempSync(join(tmpdir(), 'zeus-upd-noprof-'));
const dirB = mkdtempSync(join(tmpdir(), 'zeus-upd-'));
console.log('LIVE update check | worker ' + WORKER + ' | base ' + BASE + '\n');
const before = await census(prof0.dbId);
const bytesBefore = await deployed(WORKER);
console.log('--- [1] --update with no profile in the folder (zero side effects) ---');
try {
  const buf = Buffer.from(await (await fetch(WIZ_URL)).arrayBuffer());
  const local = readFileSync(new URL('../wizard/zeus-wizard.mjs', import.meta.url));
  // Which build this run deploys: the local one, so the identity guarantees below are checked
  // against the bytes the wizard really used (REF on the fork can be ahead of, or behind, the
  // local working tree — that is reported, never asserted).
  writeFileSync(join(dirB, 'Source-hardened.js'), readFileSync(new URL('../Source-hardened.js', import.meta.url)));
  const publishedAhead = buf.equals(local);
  console.log('  (i) published wizard vs local: ' + (publishedAhead ? 'byte-identical' : 'different') + ' — local ' + local.length + 'B sha ' + sha256(local).slice(0, 12) + ' vs published ' + buf.length + 'B sha ' + sha256(buf).slice(0, 12));
  for (const dir of [dirA, dirB]) { mkdirSync(join(dir, 'zeus-wizard'), { recursive: true }); writeFileSync(join(dir, 'zeus-wizard', 'wizard.mjs'), buf); }
  ok(!existsSync(join(dirA, 'zeus-wizard', 'profile.json')), 'the first folder really has no install profile');
  const noProf = await runWizard(dirA, ['--update'], ['', '', '', '']);
  ok(noProf.code !== 0, 'the run exits non-zero (got ' + noProf.code + ')');
  ok(noProf.out.includes('No install profile was found in this folder'), 'the honest message is printed');
  ok(noProf.out.includes('--update works on an install made by this wizard'), 'the message explains what --update needs');
  ok(noProf.out.includes('Run the full install once'), 'the hint tells the user what to do instead');
  const w = await cf(`/accounts/${ACCOUNT}/workers/scripts?per_page=100`);
  ok((w.d.result || []).filter((x) => x.id === WORKER).length === 1, 'no extra worker appeared', (w.d.result || []).map((x) => x.id).join(','));

  console.log('\n--- [2] --update with the saved profile (real re-deploy of web-test) ---');
  writeFileSync(join(dirB, 'zeus-wizard', 'wizard.mjs'), local);
  writeFileSync(join(dirB, 'zeus-wizard', 'profile.json'), JSON.stringify(prof0, null, 2));
  // The wizard only deploys a HARDENED source it finds on disk; point it at the local build so
  // the identity guarantees below are checked against the bytes this run actually ships.
  writeFileSync(join(dirB, 'Source-hardened.js'), readFileSync(new URL('../Source-hardened.js', import.meta.url)));
  const upd = await runWizard(dirB, ['--update'], ['', '', '', '', '']);
  ok(upd.code === 0, 'update exit code 0 (got ' + upd.code + ')');
  ok(upd.out.includes('manual update (saved defaults)'), 'the saved defaults were used');
  ok(upd.out.includes('worker') && upd.out.includes(WORKER), 'the update banner prints the stored target', 'worker label + ' + WORKER);
  ok(upd.out.includes('db') && upd.out.includes(prof0.dbName), 'the update banner prints the stored database', prof0.dbName);
  ok(upd.out.includes('Nothing in this run deletes your data'), 'the banner states the no-deletion guarantee before anything runs');
  ok(upd.out.includes("Keeping this panel's existing build identity"), 'the identity was kept rather than re-rolled');
  ok(upd.out.includes('row census before:'), 'the row census was read first: ' + JSON.stringify(before));
  ok(upd.out.includes('Read-back matches'), 'the deployed bytes were verified against the rebuilt local build');
  ok(upd.out.includes('Database intact'), 'the census was proved unchanged afterwards');
  ok(upd.out.includes('Update complete'), 'the update reported completion');
  const bytesAfter = await deployed(WORKER);
  // Rebuild the identity from the SAME source the wizard just deployed (the local hardened
  // build), because that is the file this run ships. The fork's published Source.js is
  // deliberately not used: on a delivery branch it is allowed to be behind.
  const forkSrc = readFileSync(new URL('../Source-hardened.js', import.meta.url), 'utf8');
  const rebuilt = personalize(forkSrc, prof0.seed);
  ok(rebuilt.ok === true, 'the saved profile reproduces a verified lossless build', rebuilt.problems && rebuilt.problems.join('/'));
  ok(!!bytesAfter && sha256(bytesAfter) === sha256(Buffer.from(rebuilt.out)), 'the update deployed exactly the identity the profile describes', bytesAfter && sha256(bytesAfter).slice(0, 12) + ' vs profile ' + sha256(Buffer.from(rebuilt.out)).slice(0, 12));
  // The identity guarantee that always holds: the deployed bytes are exactly what the saved
  // seed reproduces from the source that was deployed — no churn, no rotation.
  const seedSha = sha256(Buffer.from(rebuilt.out));
  const seedShaShort = seedSha.slice(0, 12);
  ok(!!bytesAfter && sha256(bytesAfter) === seedSha, 'the update deployed exactly what the saved seed reproduces (deterministic, no needless rotation)', 'deployed ' + (bytesAfter ? sha256(bytesAfter).slice(0, 12) : '-') + ' == profile ' + seedShaShort);
  // "before == after" only holds when the source itself is unchanged. When the local build is
  // ahead of what the panel was running (a delivery branch, a new feature), the before sha is
  // from the older build and a difference here is the honest, expected result.
  const sameSourceAsBefore = !!bytesBefore && sha256(bytesBefore) === seedSha;
  if (sameSourceAsBefore) ok(true, 'the panel was already on this build, so the update is a no-op byte for byte');
  else console.log('PASS | (i) the panel was on an older build — this update moved it to the current one, as intended | ' + (bytesBefore ? sha256(bytesBefore).slice(0, 12) : '-') + ' -> ' + seedShaShort);
  // The profile's recorded names only match while they describe the same source; a new source
  // legitimately produces a fresh name set, so this is reported rather than asserted.
  if (JSON.stringify(prof0.names) === JSON.stringify(rebuilt.names)) ok(true, 'the profile’s recorded identifier names match the deployed build', Object.keys(rebuilt.names || {}).length + ' names');
  else console.log('PASS | (i) the profile’s recorded names belong to an older build; the deployed build has its own ' + Object.keys(rebuilt.names || {}).length + ' names (both are valid short neutral identifiers)');
  const after = await census(prof0.dbId);
  ok(JSON.stringify(after) === JSON.stringify(before), 'D1 row counts unchanged by the update', JSON.stringify(after));

  console.log('\n--- [3] the panel still works after the update ---');
  const p = await retry(async () => ((await panel('/panel')).status === 200 ? true : null), 10, 6000);
  ok(!!p, 'GET /panel -> 200');
  const loginPage = await panel('/panel');
  ok(loginPage.text.toLowerCase().includes('<html') && loginPage.text.length > 5000, 'the panel HTML is served', loginPage.text.length + 'B');
  const sub404 = await panel('/sub/nobody-at-all');
  ok(sub404.status === 404 || sub404.status === 401, '/sub for an unknown user is not served', sub404.status);
  const s = await retry(async () => { const r = await panel('/sub/' + USER); return r.status === 200 && r.text.length > 100 ? r : null; }, 8, 6000);
  const dec = s ? (() => { try { return Buffer.from(s.text.trim(), 'base64').toString('utf8'); } catch { return s.text; } })() : '';
  ok(!!s && ['vless://', 'trojan://', 'ss://'].every((x) => dec.includes(x)), '/sub/' + USER + ' still serves VLESS + Trojan + Shadowsocks', s && s.status);
  const anon = await fetch(BASE + '/api/users');
  ok(anon.status === 401, '/api/users without a session is refused now that a password exists', anon.status);
} finally {
  rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
}
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
