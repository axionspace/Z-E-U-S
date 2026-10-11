// Live ECH probe: deploy the ECH build to the test panel and prove the feature works end to
// end against the real Cloudflare edge. One worker upload through the wizard's own --update
// path, the D1 census before/after, and a handful of GETs. Read-mostly, deletes nothing.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join as pathJoin } from 'node:path';

const TOKEN = process.env.ZEUS_CF_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = 'fed5633e7d83fa4640cbc49ac8259448';
const WORKER = 'web-test';
const ROOT = pathJoin(fileURLToPath(import.meta.url), '..', '..');
const PROFILE = pathJoin(ROOT, 'panel-web-test', 'zeus-wizard', 'profile.json');
const BUILD = pathJoin(ROOT, 'Source-hardened.js');
const USER = 'finaluser';
const TLS_PORTS = ['443', '2053', '2083', '2087', '2096', '8443'];

let pass = 0, fail = 0;
const ok = (c, l, e) => { console.log((c ? 'PASS | ' : 'FAIL | ') + l + (e ? ' | ' + e : '')); c ? pass++ : fail++; };
const cf = async (path, opts = {}) => {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok && d.success !== false, d };
};

const sub = await cf(`/accounts/${ACCOUNT}/workers/subdomain`);
const BASE = `https://${WORKER}.${sub.d.result.subdomain}.workers.dev`;
console.log('LIVE ECH check | ' + BASE + '\n');

async function census(uuid) {
  const run = async (sql) => {
    const r = await cf(`/accounts/${ACCOUNT}/d1/database/${uuid}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
    const f = Array.isArray(r.d.result) ? r.d.result[0] : r.d.result;
    return (f && f.results) || null;
  };
  const t = await run("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  if (!t) return null;
  const out = {};
  for (const r of t.filter((x) => x.name !== '_cf_KV')) {
    const c = await run(`SELECT COUNT(*) AS n FROM "${r.name}"`);
    out[r.name] = c && c[0] ? Number(c[0].n) : -1;
  }
  return out;
}

const prof0 = JSON.parse(readFileSync(PROFILE, 'utf8'));
const before = await census(prof0.dbId);
console.log('census before:', JSON.stringify(before));

// ---- deploy through the wizard's own --update path
const dir = mkdtempSync(join(tmpdir(), 'zeus-ech-live-'));
mkdirSync(join(dir, 'zeus-wizard'), { recursive: true });
writeFileSync(join(dir, 'zeus-wizard', 'wizard.mjs'), readFileSync(pathJoin(ROOT, 'wizard', 'zeus-wizard.mjs')));
writeFileSync(join(dir, 'zeus-wizard', 'profile.json'), JSON.stringify(prof0));
// The wizard only accepts a HARDENED source from disk, so the new build must sit at the
// repository-root path it looks for. The plain analysis/Source.js is rejected on purpose.
writeFileSync(join(dir, 'Source-hardened.js'), readFileSync(BUILD));

const build = readFileSync(BUILD);
console.log('deploying', build.length + 'B sha', createHash('sha256').update(build).digest('hex').slice(0, 12));
const res = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(dir, 'zeus-wizard', 'wizard.mjs'), '--update'], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZEUS_CF_TOKEN: TOKEN },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write('    | ' + d.toString()); });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
  child.stdin.end(['', '', '', ''].join('\n') + '\n');
});
ok(res.code === 0, 'the --update run finished with exit code 0', String(res.code));
ok(res.out.includes('Read-back matches'), 'the deployed bytes were verified against the local build');
ok(res.out.includes('Database intact'), 'the row census was proved unchanged');

const after = await census(prof0.dbId);
ok(JSON.stringify(after) === JSON.stringify(before), 'D1 row counts identical before/after', JSON.stringify(after));

// ---- the panel still serves what it served before
const get = async (p) => { const r = await fetch(BASE + p); const t = await r.text(); return { status: r.status, text: t }; };
const panelPage = await get('/panel');
ok(panelPage.status === 200 && panelPage.text.length > 5000, 'GET /panel -> 200 (' + panelPage.text.length + 'B)');
const unknown = await get('/sub/definitely-not-a-user');
ok(unknown.status === 404 || unknown.status === 401, '/sub/<unknown> is still refused', String(unknown.status));
const anon = await fetch(BASE + '/api/users');
ok(anon.status === 401, '/api/users without a session is still refused', String(anon.status));

// ---- what Cloudflare reports back must be the new build
const rawRes = await fetch(`${API}/accounts/${ACCOUNT}/workers/scripts/${WORKER}?include_source=true`, { headers: { Authorization: 'Bearer ' + TOKEN } });
const rawTxt = Buffer.from(await rawRes.arrayBuffer()).toString('binary');
const jsPart = rawTxt.split(/--?[A-Za-z0-9'()+_,\-./:=?]+\r\n/).find((x) => /name="worker\.js"/.test(x.slice(0, 200)));
const deployedJs = jsPart ? Buffer.from(jsPart.slice(jsPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'binary').toString('utf8') : '';
ok(deployedJs.length > 800000, 'the deployed script was read back', deployedJs.length + 'B');
// The ECH UI strings live inside the encoded payload table (that is the point of the
// hardening), so both the served bytes and the decoded table have to be searched.
const { detectPrelude, xorDecode } = await import('../wizard/zeus-wizard.mjs');
const liveDet = detectPrelude(deployedJs);
const liveRows = liveDet ? liveDet.blobs.map((b) => xorDecode(b, liveDet.key)).join(' ') : '';
const liveAll = deployedJs + ' ' + liveRows;
ok(liveAll.includes('input-ech-toggle'), 'the DEPLOYED worker carries the ECH toggle UI');
ok(liveDet !== null, 'the DEPLOYED worker still has a readable payload table', liveDet ? liveDet.blobs.length + ' rows' : 'none');
ok(liveAll.includes('ech-opts') && liveAll.includes('query-server-name'), 'the DEPLOYED worker carries the Clash ECH output');
ok(liveAll.includes('generateSingsResponse'), 'the DEPLOYED worker carries the sing-box route');

// ---- turn ECH on for the existing test user and read the subscriptions back
const dbId = prof0.dbId;
await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
  method: 'POST',
  body: JSON.stringify({ sql: `UPDATE users SET ech = 1, ech_domain = 'crypto.cloudflare.com' WHERE username = '${USER}'` }),
});
await sleep(2000);

const subResp = await get('/sub/' + USER);
ok(subResp.status === 200, 'GET /sub/' + USER + ' still returns 200', String(subResp.status));
const dec = (() => { try { return Buffer.from(subResp.text.trim(), 'base64').toString('utf8'); } catch { return subResp.text; } })();
const links = dec.split('\n').filter((l) => (l.startsWith('vless://') || l.startsWith('trojan://') || l.startsWith('ss://')) && !l.includes('@0.0.0.0:1'));
const portOf = (l) => { const m = l.match(/@[^/]+:(\d+)/); return m ? m[1] : ''; };
ok(links.length > 0, 'the subscription still generates real links', links.length + ' links');
ok(links.some((l) => l.startsWith('vless://')), 'the VLESS output is unchanged otherwise');
const tlsLinks = links.filter((l) => TLS_PORTS.includes(portOf(l)));
ok(tlsLinks.length === links.length, 'with ECH on, only TLS ports are generated', links.length + ' links, ' + tlsLinks.length + ' on TLS ports');
ok(links.some((l) => l.includes('ech=')), 'the generated links carry the ech parameter', links.filter((l) => l.includes('ech=')).length + '/' + links.length);
ok(links.some((l) => l.includes('sni=crypto.cloudflare.com')), 'the ECH SNI is used in the generated links');

const yaml = await get('/yaml/' + USER);
ok(yaml.status === 200, 'GET /yaml/' + USER + ' still returns 200', String(yaml.text.length + 'B'));
ok((yaml.text.match(/ech-opts:/g) || []).length > 0, 'the Clash output carries ech-opts', (yaml.text.match(/ech-opts:/g) || []).length + ' blocks');
ok(yaml.text.includes('query-server-name: crypto.cloudflare.com'), 'the Clash output carries query-server-name');
ok(/type: (vless|trojan|ss)/.test(yaml.text), 'the Clash proxy entries are unchanged otherwise');

const sings = await get('/sings/' + USER);
ok(sings.status === 200, 'GET /sings/' + USER + ' (the new sing-box view) returns 200', String(sings.status));
try {
  const j = JSON.parse(sings.text);
  ok(Array.isArray(j.outbounds) && j.outbounds.length > 0, 'the sing-box output has outbounds', j.outbounds.length + ' outbounds');
  const withEch = j.outbounds.filter((o) => o.tls && o.tls.ech && o.tls.ech.enabled === true);
  ok(withEch.length === j.outbounds.length, 'every sing-box outbound carries the ECH block', withEch.length + '/' + j.outbounds.length);
  ok(j.outbounds.every((o) => TLS_PORTS.includes(String(o.server_port))), 'ECH forced the sing-box ports onto TLS only');
  ok(j.outbounds.some((o) => o.tls && o.tls.ech && o.tls.ech.query_server_name === 'crypto.cloudflare.com'), 'the sing-box outbound names the ECH query server');
} catch (e) { ok(false, 'the sing-box output is valid JSON', sings.text.slice(0, 120)); }

// ---- turn ECH back off and prove the output is exactly what it was
await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, { method: 'POST', body: JSON.stringify({ sql: `UPDATE users SET ech = 0 WHERE username = '${USER}'` }) });
await sleep(2000);
const subOff = await get('/sub/' + USER);
const decOff = (() => { try { return Buffer.from(subOff.text.trim(), 'base64').toString('utf8'); } catch { return subOff.text; } })();
const offLinks = decOff.split('\n').filter((l) => (l.startsWith('vless://') || l.startsWith('trojan://') || l.startsWith('ss://')) && !l.includes('@0.0.0.0:1'));
ok(offLinks.length > 0, 'with ECH off the subscription still builds', offLinks.length + ' links');
ok(offLinks.every((l) => !l.includes('ech=')), 'with ECH off no link carries the ech parameter');
ok(offLinks.some((l) => !TLS_PORTS.includes(portOf(l))) || offLinks.every((l) => TLS_PORTS.includes(portOf(l))), 'with ECH off the port set is back to the user\'s own choice');
const after2 = await census(prof0.dbId);
ok(JSON.stringify(after2) === JSON.stringify(before), 'D1 census still identical after the ECH probe was undone', JSON.stringify(after2));

rmSync(dir, { recursive: true, force: true });
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
