// first-run-probe.mjs — read-only probe that documents the panel's first-run rule on a
// real deployment that has no admin password yet (the user's web-bess), and proves the
// opposite once a password exists (web-test). Nothing is written, created or deleted.
// Usage: ZEUS_CF_TOKEN=<t> node tools/first-run-probe.mjs
const TOKEN = process.env.ZEUS_CF_TOKEN || '';
if (!TOKEN) { console.error('ZEUS_CF_TOKEN is required'); process.exit(1); }
const API = 'https://api.cloudflare.com/client/v4';
let pass = 0, fail = 0;
const ok = (c, label, extra) => { console.log((c ? 'PASS | ' : 'FAIL | ') + label + (extra ? ' | ' + extra : '')); c ? pass++ : fail++; };
const cf = async (p, o = {}) => {
  const init = { method: o.method || 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } };
  if (o.body) init.body = JSON.stringify(o.body);
  const r = await fetch(API + p, init);
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
};
const ACCOUNT = (await cf('/accounts?per_page=20')).d.result[0].id;
const hasPassword = async (dbName) => {
  const l = await cf(`/accounts/${ACCOUNT}/d1/database?name=${encodeURIComponent(dbName)}`);
  const db = (l.d.result || [])[0];
  if (!db) return null;
  const q = await cf(`/accounts/${ACCOUNT}/d1/database/${db.uuid}/query`, { method: 'POST', body: { sql: "SELECT key FROM settings WHERE key = 'panel_password'" } });
  const f = Array.isArray(q.d.result) ? q.d.result[0] : q.d.result;
  return ((f && f.results) || []).length > 0;
};

for (const name of ['web-bess', 'web-test']) {
  const base = `https://${name}.${(await cf(`/accounts/${ACCOUNT}/workers/subdomain`)).d.result.subdomain}.workers.dev`;
  const pw = await hasPassword(name + '-db');
  const r = await fetch(base + '/api/users');
  const t = await r.text();
  let body = null; try { body = JSON.parse(t); } catch {}
  console.log('\n' + name + ': panel_password ' + (pw ? 'SET' : 'not set') + ' → GET /api/users ' + r.status + ' ' + t.slice(0, 80));
  if (pw === false) {
    ok(r.status === 200 && body && Array.isArray(body.users) && body.users.length === 0, `${name}: no password yet, so the API answers openly with an empty list (upstream first-run rule)`, r.status);
  } else {
    ok(r.status === 401 && body && body.error === 'Unauthorized', `${name}: a password exists, so the same request is refused`, r.status + ' ' + t.slice(0, 40));
  }
  const page = await fetch(base + '/panel');
  ok(page.status === 200, `${name}: /panel serves`, page.status);
  const unknown = await fetch(base + '/sub/definitely-not-a-user');
  ok(unknown.status === 404 || unknown.status === 401, `${name}: an unknown subscription is not served`, unknown.status);
}
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
