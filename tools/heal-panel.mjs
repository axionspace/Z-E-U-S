// heal-panel.mjs — repair one existing panel that answers Cloudflare error 1101.
//
// The state this fixes is the one the live experiments documented: the deployed script is a
// complete, valid module, its D1 binding works, the same bytes run on a sibling worker — and
// yet every route on this one name answers "Worker threw exception". Re-uploading the same
// bytes does not clear it; deleting the worker *script* and deploying those same bytes again
// does. That is exactly the wizard's own self-heal ladder, so this tool does not reimplement
// it — it proves the preconditions, then calls verifyDeployment() from wizard/wizard.mjs.
//
// What is never touched: the D1 database, its tables and every row, the workers.dev address,
// any custom domain. Only the worker script record is recreated, and a row census is taken
// before and after to prove it.
//
// Usage:
//   ZEUS_CF_TOKEN=... node tools/heal-panel.mjs <worker> [--account <id>] [--sub <label>] [--yes]
//
// Without --yes it only diagnoses and prints the plan. The token can also come from the
// wizard's saved account store (~/.zeus-wizard/accounts.json); it is never printed.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deployedBytes, d1Snapshot, sameCensus, verifyDeployment, probeAll, probeBase, loadStore,
} from '../wizard/wizard.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const YES = argv.includes('--yes');
let worker = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--account' || argv[i] === '--sub') { i++; continue; }
  if (!argv[i].startsWith('--')) { worker = argv[i]; break; }
}

if (!worker) {
  console.error('usage: node tools/heal-panel.mjs <worker> [--account <id>] [--sub <label>] [--yes]');
  process.exit(2);
}

// ------------------------------------------------------------------ token + account
const store = loadStore();
const saved = (store.accounts || []).find((a) => a.accountId === flag('--account')) || (store.accounts || [])[0] || null;
const token = (process.env.ZEUS_CF_TOKEN || '').trim() || (saved && saved.token) || '';
const accountId = flag('--account') || (saved && saved.accountId) || '';
if (!token) { console.error('No token: set ZEUS_CF_TOKEN or save an account with the wizard first.'); process.exit(2); }
if (!accountId) { console.error('No account id: pass --account <id>.'); process.exit(2); }
process.env.ZEUS_CF_TOKEN = token;

const cf = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(35000),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data || data.success === false) {
    const errs = ((data && data.errors) || []).map((e) => e.code + ': ' + e.message).join(' | ') || ('HTTP ' + res.status);
    return { ok: false, status: res.status, errors: errs };
  }
  return { ok: true, data };
};

// ------------------------------------------------------------------ preconditions
const settings = await cf(`/accounts/${accountId}/workers/scripts/${worker}/settings`);
if (!settings.ok) { console.error(`Cannot read ${worker} settings (${settings.errors}).`); process.exit(1); }
const cfg = settings.data.result || {};
const d1 = (cfg.bindings || []).find((b) => b && b.type === 'd1' && b.name === 'DB');
if (!d1) { console.error('This worker has no D1 binding named DB — it is not a panel this tool can heal.'); process.exit(1); }
const dbId = d1.id || d1.database_id || '';
const dbInfo = await cf(`/accounts/${accountId}/d1/database/${dbId}`);
const dbName = (dbInfo.ok && dbInfo.data.result && dbInfo.data.result.name) || 'DB';

let subdomain = flag('--sub');
if (!subdomain) {
  const s = await cf(`/accounts/${accountId}/workers/subdomain`);
  subdomain = (s.ok && s.data.result && s.data.result.subdomain) || '';
}
if (!subdomain) { console.error('Cannot determine the workers.dev subdomain — pass --sub <label>.'); process.exit(1); }

const got = await deployedBytes(accountId, worker);
if (!got.ok) { console.error('Cannot download the deployed bytes (' + got.errors + ') — nothing was changed.'); process.exit(1); }
const bytes = got.bytes;
const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const base = probeBase(worker, subdomain);
const probes = await probeAll(base);
const stuck = probes.some((p) => p.code === '1101' || /error code: 1101|Worker threw exception/i.test(p.text || '')) ||
  probes.some((p) => p.status >= 500);
const reachable = probes.some((p) => p.status > 0);

console.log('\n  worker        : ' + worker + '  (account ' + accountId.slice(0, 8) + '…)');
console.log('  address       : ' + base);
console.log('  deployed      : ' + bytes.length + 'B  sha256 ' + sha);
console.log('  compatibility : ' + cfg.compatibility_date + '  flags ' + JSON.stringify(cfg.compatibility_flags || []));
console.log('  database      : ' + dbName + '  (' + String(dbId).slice(0, 8) + '…)  — never touched');
console.log('  routes        : ' + probes.map((p) => p.path + '=' + (p.code ? 'error ' + p.code : p.status)).join('  '));

if (!stuck) {
  console.log('\n  Nothing to heal: the panel is not answering 1101/5xx right now.\n');
  process.exit(0);
}
if (!reachable) {
  console.log('\n  The address does not answer at all from here, so 1101 cannot be proven — refusing to delete anything.\n');
  process.exit(1);
}

const before = await d1Snapshot(accountId, dbId);
console.log('  row census    : ' + (before ? Object.entries(before).map(([k, v]) => k + '=' + v).join(', ') : 'unavailable'));
console.log('\n  plan: recreate the worker script once from these same verified bytes; then re-enable the');
console.log('        workers.dev route and re-check every route and the row census.');
if (!YES) {
  console.log('\n  dry run — nothing was changed. Re-run with --yes to heal.\n');
  process.exit(0);
}

// ------------------------------------------------------------------ heal (the wizard's own ladder)
const buildPath = join(tmpdir(), 'zeus-heal-' + worker + '.mjs');
writeFileSync(buildPath, bytes);
const health = await verifyDeployment({ accountId, workerName: worker, buildPath, dbId, dbName, subdomain });

// ------------------------------------------------------------------ proof
const after = await d1Snapshot(accountId, dbId);
const finalProbes = await probeAll(base);
// 401 is the panel's own answer on an auth-gated API route (and on /panel before login),
// so it is a healthy response, not a failure.
const allOk = finalProbes.every((p) => (p.status >= 200 && p.status < 400) || p.status === 401);
console.log('\n  RESULT');
console.log('  heal reported : ' + (health.ok ? 'ok' : health.state) + (health.healed ? '  (script recreated)' : ''));
console.log('  routes now    : ' + finalProbes.map((p) => p.path + '=' + (p.code ? 'error ' + p.code : p.status)).join('  '));
console.log('  row census    : ' + (after ? Object.entries(after).map(([k, v]) => k + '=' + v).join(', ') : 'unavailable'));
console.log('  data intact   : ' + (sameCensus(before, after) ? 'yes — identical row counts' : 'CHANGED (inspect before continuing)'));
console.log('  deployed sha  : ' + sha + ' (same bytes re-uploaded)');
process.exitCode = health.ok && allOk ? 0 : 1;
