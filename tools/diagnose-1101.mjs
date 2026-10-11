// diagnose-1101.mjs — why is a freshly installed panel answering Cloudflare error 1101?
// Gathers everything the API can say about one worker without touching its data:
// identity, bindings, the exact deployed bytes (size, completeness, whether it is a
// personalised build), the D1 it points at and whether that database exists/has tables,
// plus a route-by-route probe. Then classifies the failure.
// Usage: ZEUS_CF_TOKEN=<token> node tools/diagnose-1101.mjs [worker-name]
const T = process.env.ZEUS_CF_TOKEN;
const SUB = process.env.ZEUS_SUB || 'axionum';
if (!T) { console.error('ZEUS_CF_TOKEN required'); process.exit(1); }
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { detectPrelude, xorDecode, personalize } from '../wizard/zeus-wizard.mjs';

const A = 'fed5633e7d83fa4640cbc49ac8259448';
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: 'Bearer ' + T };
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const j = async (p, o = {}) => { const r = await fetch(API + p, { ...o, headers: { ...H, ...((o && o.headers) || {}) } }); let d = null; try { d = await r.json(); } catch {} return { s: r.status, d }; };

const { s: ls, d: list } = await j(`/accounts/${A}/workers/scripts`);
if (ls !== 200) { console.error('cannot list scripts', ls, JSON.stringify(d && d.errors)); process.exit(1); }
const workers = (list.result || []).slice().sort((a, b) => String(b.modified_on).localeCompare(String(a.modified_on)));
console.log('workers in account:', workers.map((w) => w.id).join(', '));
const name = process.argv[2] || workers.find((w) => w.id !== 'web-panel').id || workers[0].id;
const w = workers.find((x) => x.id === name);
console.log('\ndiagnosing:', name, '| created', w.created_on, '| modified', w.modified_on);

const st = await j(`/accounts/${A}/workers/scripts/${name}/settings`);
const res = st.d.result || {};
console.log('compatibility_date:', res.compatibility_date, '| flags:', JSON.stringify(res.compatibility_flags || []));
console.log('bindings          :', JSON.stringify((res.bindings || []).map((b) => b.type + ':' + b.name + (b.id ? '(' + String(b.id).slice(0, 8) + '…)' : ''))));
console.log('usage_model       :', res.usage_model, '| tail_consumers:', (res.tail_consumers || []).length);

const d1 = (res.bindings || []).find((b) => b.type === 'd1');
if (d1) {
  const dl = await j(`/accounts/${A}/d1/database/${d1.id}`);
  const db = dl.d.result;
  console.log('D1 "' + d1.name + '"        :', db ? (db.name + ' | rows_read=' + (db.read_size_bytes || '?') + 'B | created ' + db.created_on) : 'LOOKUP FAILED ' + JSON.stringify(dl.d.errors));
  const q = await j(`/accounts/${A}/d1/database/${d1.id}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }) });
  const first = Array.isArray(q.d.result) ? q.d.result[0] : (q.d.result || {});
  console.log('D1 tables           :', q.s === 200 ? JSON.stringify((first.results || []).map((r) => r.name)) : 'query failed ' + JSON.stringify(q.d.errors).slice(0, 120));
} else console.log('D1 binding          : NONE — the panel cannot work without it');

const raw = await fetch(`${API}/accounts/${A}/workers/scripts/${name}?include_source=true`, { headers: H });
const buf = Buffer.from(await raw.arrayBuffer());
const bm = (raw.headers.get('content-type') || '').match(/boundary=(?:"?([^";\s]+)"?)/i);
let bytes = null;
for (const p of buf.toString('binary').split('--' + bm[1])) {
  if (!/name="worker\.js"/i.test(p.slice(0, 1200))) continue;
  const i = p.indexOf('\r\n\r\n');
  bytes = Buffer.from(p.slice(i + 4).replace(/\r\n$/, ''), 'binary');
}
const txt = bytes.toString('utf8');
const det = detectPrelude(txt);
console.log('\ndeployed script       :', bytes.length + 'B', '| sha256 ' + sha(bytes), '| has "export default":', /export\s+default/.test(txt));
console.log('last 60 chars         :', JSON.stringify(txt.slice(-60)));
console.log('payload table         :', det ? det.blobs.length + ' rows, names ' + det.keyName + '/' + det.getName : 'NOT FOUND');
if (det) {
  const rows = det.blobs.map((b) => xorDecode(b, det.key));
  console.log('rows decode cleanly   :', rows.every((r) => typeof r === 'string' && r.length > 0), '| keyword-bearing rows:', rows.filter((r) => /vless|trojan|shadowsocks/i.test(r)).length);
}
// is this a personalised derivative of the current fork build?
try {
  const canon = readFileSync(new URL('../Source-hardened.js', import.meta.url), 'utf8');
  const cdet = detectPrelude(canon);
  const cset = cdet.blobs.map((b) => xorDecode(b, cdet.key)).sort().join('\u0001');
  const lset = det ? det.blobs.map((b) => xorDecode(b, det.key)).sort().join('\u0001') : '';
  console.log('same panel as fork?   :', lset === cset ? 'YES — identical payload values' : 'NO — different payload values (!)');
  // can we reproduce it? try the identity of the production profile plus a couple of known seeds
  const cands = [];
  try { cands.push(['panel-live profile', JSON.parse(readFileSync(new URL('../panel-live/zeus-wizard/profile.json', import.meta.url), 'utf8')).seed]); } catch {}
  for (const [label, seed] of cands) {
    if (!seed) continue;
    const same = personalize(canon, seed).out === txt;
    console.log('reproducible from ' + label + ':', same ? 'YES (byte-identical)' : 'no');
  }
} catch (e) { console.log('local comparison skipped:', e.message); }

console.log('\nroutes:');
const bad = [];
for (const path of ['/', '/panel', '/sw.js', '/manifest.json', '/icon.svg', '/api/does-not-exist']) {
  try {
    const r = await fetch(`https://${name}.${SUB}.workers.dev${path}`, { signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    const code = (t.match(/error code: (\d+)/) || [])[1];
    console.log('  ', path.padEnd(20), r.status, code ? 'error code ' + code : '(' + t.length + 'B html/body)');
    if (r.status >= 500) bad.push(path + '=' + r.status + (code ? '/' + code : ''));
  } catch (e) { console.log('  ', path.padEnd(20), 'fetch failed:', e.message); bad.push(path + '=ERR'); }
}

const complete = bytes.length > 800000 && /export\s+default/.test(txt);
console.log('\nclassification:');
if (bad.length === 6) console.log(complete ? '  All routes fail 1101 while the deployed script is a COMPLETE, valid module with a working D1 binding -> the one-off poisoned deploy state on Cloudflare side; delete the worker and deploy the same bytes again.' : '  All routes fail 1101 and the script looks incomplete -> the uploaded bytes are damaged; re-run the installer.');
else if (!bad.length) console.log('  No 5xx right now — the panel answers every route.');
else console.log('  Only some routes fail -> a runtime error inside those handlers, not the whole script; needs the stack (probe worker).');
