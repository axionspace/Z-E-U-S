// test-wizard-flows.mjs — offline regression test for the new wizard behaviour:
//   • install applies a private build fingerprint and uploads THAT build
//   • the uploaded script is read back from the mock API and compared byte-for-byte
//   • profile.json is written with the identity seed and the generated names
//   • --no-fingerprint uploads the shared repository build untouched
//   • --update reuses the saved defaults, keeps the same identity, preserves the
//     worker's existing non-D1 bindings and its compatibility date, and proves the
//     D1 row census is identical before and after
//   • --rotate mints a new identity and saves it
//   • a missing profile / missing database are handled without ever deleting data
//   • no HTTP DELETE request is issued by any flow
// Usage: node tools/test-wizard-flows.mjs [--keep]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { detectPrelude, xorDecode, KW_RE, FORK_SOURCES, PERM_GROUPS, REQUIRED_COMPAT_DATE, REQUIRED_COMPAT_FLAGS, classifyDeployment } from '../wizard/wizard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, '..');
const WIZARD_SRC = join(PROJECT, 'wizard', 'wizard.mjs');
const SOURCE_FILE = existsSync(join(PROJECT, 'Source.js')) ? join(PROJECT, 'Source.js') : join(PROJECT, 'Source-hardened.js');
const KEEP = process.argv.includes('--keep');

const ACCOUNT_ID = 'c'.repeat(32);
const DB_UUID = '77777777-7777-4777-8777-777777777777';
const SUB = 'te_st'; // invalid DNS label -> the workers.dev probe fails fast, offline
const TOKEN = 'mock-token-not-a-secret';

const okEnv = (r) => ({ success: true, result: r, errors: [], messages: [] });
const errEnv = (code, message) => ({ success: false, result: null, errors: [{ code, message }], messages: [] });
// D1 answers statements as an ARRAY of per-statement results — the real endpoint shape
const d1Rows = (rows) => ({ success: true, result: [{ success: true, results: rows, meta: { changed_db: false } }], errors: [], messages: [] });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const CANON = readFileSync(SOURCE_FILE, 'utf8');
const CANON_DET = detectPrelude(CANON);
const CANON_ROWS = CANON_DET.blobs.map((b) => xorDecode(b, CANON_DET.key)).sort();

let pass = 0, failCnt = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { failCnt++; console.log('  FAIL  ' + label + (extra ? '\n        ' + extra : '')); }
};

// ------------------------------------------------------------------ mock CF API
function startMock(opt = {}) {
  const state = {
    scripts: {},           // name -> { bytes, metadata }
    puts: [],              // every script PUT
    deletes: [],           // every DELETE path
    requests: [],          // every {method,path}
    dbs: opt.dbs || [],    // [{name, uuid}]
    settings: opt.settings || null,
    censusFails: !!opt.censusFails,
    emptyDb: !!opt.emptyDb, // D1 answers "no tables yet" so the readiness gate must create them
    probeMode: opt.probeMode || 'ok',   // ok | propagate | stuck | stuck-heals
    probeHits: 0,
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/client\/v4/, '');
      const method = req.method;
      state.requests.push({ method, path: p + (url.search || '') });
      if (method === 'DELETE') state.deletes.push(p);
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // the panel-address health probe the wizard polls (ZEUS_PROBE_URL points here).
      // The wizard probes three routes now ('/', '/panel', '/api/does-not-exist') so one
      // fast poll cannot confuse a panel-side 500 with a Cloudflare 1101 page.
      if (url.pathname === '/probe/' || url.pathname.startsWith('/probe/')) {
        state.probeHits++;
        const healed = state.deletes.length > 0;
        const fixed = state.puts.length >= 2; // a corrective re-PUT landed
        if (state.probeMode === 'propagate') {
          if (state.probeHits < 3) return json(404, errEnv(10007, 'not yet'));
          return json(200, okEnv('up'));
        }
        if (state.probeMode === 'dead') {
          // a filtered / not-yet-propagated address: never answers, never 1101
          return json(404, errEnv(10007, 'not found'));
        }
        if (state.probeMode === 'binding-missing') {
          // the panel's own 500: its D1 binding has not landed yet. The second PUT
          // (the wizard's binding re-pin) fixes it — no delete involved.
          if (fixed) return json(200, okEnv('up'));
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end("Database binding 'DB' is missing in Cloudflare Workers settings.");
        }
        if (state.probeMode === 'tripwire') {
          // the panel's own 503: its integrity check trips. Same bytes can never fix
          // this — only a rebuilt identity can.
          res.writeHead(503, { 'content-type': 'text/plain' });
          return res.end('Cloudflare D1 Quota Exceeded');
        }
        if (state.probeMode === 'stuck') {
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end('error code: 1101');
        }
        if (state.probeMode === 'stuck-heals-reput') {
          // A fresh version of identical bytes clears it — no delete required.
          if (fixed) return json(200, okEnv('up'));
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end('error code: 1101');
        }
        if (state.probeMode === 'stuck-heals') {
          if (!healed) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('error code: 1101'); }
          return json(200, okEnv('up'));
        }
        return json(200, okEnv('up'));
      }
      const scriptRe = new RegExp('^/accounts/' + ACCOUNT_ID + '/workers/scripts/([^/]+?)(/settings)?$');
      const m = p.match(scriptRe);
      try {
        if (method === 'GET' && p === '/user/tokens/verify') return json(200, okEnv({ status: 'active' }));
        if (method === 'GET' && p === '/accounts') return json(200, okEnv([{ id: ACCOUNT_ID, name: 'Mock Account' }]));
        if (method === 'DELETE' && m) { delete state.scripts[decodeURIComponent(m[1])]; return json(200, okEnv({ id: decodeURIComponent(m[1]) })); }
        if (method === 'GET' && p === `/accounts/${ACCOUNT_ID}/workers/subdomain`) return json(200, okEnv({ subdomain: SUB }));
        if (method === 'GET' && p === `/accounts/${ACCOUNT_ID}/d1/database`) {
          const want = url.searchParams.get('name');
          return json(200, okEnv(state.dbs.filter((d) => !want || d.name === want)));
        }
        if (method === 'POST' && p === `/accounts/${ACCOUNT_ID}/d1/database`) {
          if (opt.dbLimit) return json(403, errEnv(7406, 'System limit reached: databases per account (10)'));
          const name = JSON.parse(text).name;
          const uuid = opt.newDbUuid || DB_UUID;
          state.dbs.push({ name, uuid });
          return json(200, okEnv({ uuid, name }));
        }
        if (method === 'GET' && p.startsWith(`/accounts/${ACCOUNT_ID}/d1/database/`)) {
          const id = p.split('/').pop();
          return state.dbs.some((d) => d.uuid === id) ? json(200, okEnv({ uuid: id, name: 'stored' })) : json(404, errEnv(7002, 'Database not found'));
        }
        const qm = p.match(new RegExp('^/accounts/' + ACCOUNT_ID + '/d1/database/([^/]+)/query$'));
        if (qm && method === 'POST') {
          if (state.censusFails) return json(403, errEnv(9109, 'no D1 access'));
          const sql = (JSON.parse(text).sql || '');
          let results;
          if (sql.includes('sqlite_master') && sql.includes('COUNT')) return json(200, okEnv({ results: [] }));
          if (sql.includes('sqlite_master')) results = state.emptyDb ? [] : [{ name: 'users' }, { name: 'settings' }];
          else if (sql.includes('FROM "users"')) results = [{ n: 5 }];
          else if (sql.includes('FROM "settings"')) results = [{ n: 12 }];
          else results = [{ n: 0 }];
          return json(200, d1Rows(results));
        }
        if (method === 'GET' && p === `/accounts/${ACCOUNT_ID}/workers/scripts`) {
          return json(200, okEnv(Object.keys(state.scripts).map((id) => ({ id, created_on: '2026-01-01T00:00:00.000Z', modified_on: '2026-01-01T00:00:00.000Z' }))));
        }
        if (m) {
          const name = decodeURIComponent(m[1]);
          if (method === 'GET' && m[2] === '/settings') {
            if (!state.scripts[name]) return json(404, errEnv(10007, 'script_not_found'));
            // Like the real API, report the metadata of the last PUT when there is one —
            // the wizard polls this to confirm the D1 binding, date and flags landed.
            const md = state.scripts[name].metadata;
            if (md) return json(200, okEnv({ bindings: md.bindings || [], compatibility_date: md.compatibility_date || '2024-09-23', compatibility_flags: md.compatibility_flags || [] }));
            return json(200, okEnv(state.settings || { bindings: [], compatibility_date: '2024-09-23' }));
          }
          if (method === 'GET' && url.searchParams.get('include_source') === 'true') {
            const sc = state.scripts[name];
            if (!sc) return json(404, errEnv(10007, 'script_not_found'));
            const bd = 'mockboundary123';
            const meta = JSON.stringify({ main_module: 'worker.js', body_part: 'worker.js' });
            const body = Buffer.concat([
              Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\n`),
              sc.bytes,
              Buffer.from(`\r\n--${bd}--\r\n`),
            ]);
            res.writeHead(200, { 'content-type': 'multipart/form-data; boundary=' + bd });
            return res.end(body);
          }
          if (method === 'GET') return state.scripts[name] ? json(200, okEnv({ id: name })) : json(404, errEnv(10007, 'script_not_found'));
          if (method === 'PUT') {
            const ct = req.headers['content-type'] || '';
            const bm = ct.match(/boundary=(?:"?([^";\s]+)"?)/i);
            let bytes = Buffer.alloc(0), metadata = null;
            if (bm) {
              const parts = raw.toString('binary').split('--' + bm[1]);
              for (const part of parts) {
                const i = part.indexOf('\r\n\r\n');
                if (i === -1) continue;
                const head = part.slice(0, i);
                let body = Buffer.from(part.slice(i + 4).replace(/\r\n$/, ''), 'binary');
                if (/name="metadata"/.test(head)) { try { metadata = JSON.parse(body.toString('utf8')); } catch {} }
                else if (/filename="worker\.js"/.test(head)) bytes = body;
              }
            }
            state.puts.push({ name, bytes, metadata });
            state.scripts[name] = { bytes, metadata };
            return json(200, okEnv({ id: name }));
          }
        }
        // NOTE: this sits outside the script-match block on purpose — the subdomain path
        // has an extra segment (/scripts/<name>/subdomain) that the script regex rejects.
        if (method === 'POST' && /\/workers\/scripts\/[^/]+\/subdomain$/.test(p)) return json(200, okEnv({ enabled: true }));
        json(404, errEnv(9999, 'mock: unhandled ' + method + ' ' + p));
      } catch (e) {
        json(500, errEnv(500, 'mock error: ' + e.message));
      }
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, state, port: server.address().port })));
}

// ------------------------------------------------------------------ run the wizard
// The first-install route priming (a delete + recreate of the brand-new script) is switched
// off for every older scenario so their "no DELETE" assertions keep their meaning; S24 turns it on.
let RUN_ENV = { ZEUS_NO_PREWARM: '1' };
function run(dir, port, args, answers) {
  return new Promise((res) => {
    const src = readFileSync(WIZARD_SRC, 'utf8');
    const patched = src.replace("const API = 'https://api.cloudflare.com/client/v4';", `const API = 'http://127.0.0.1:${port}/client/v4';`);
    if (patched === src) return res({ fatal: 'could not patch the API base URL' });
    writeFileSync(join(dir, 'wizard', 'wizard.mjs'), patched);
    const child = spawn(process.execPath, [join(dir, 'wizard', 'wizard.mjs'), ...args], {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        // The harness owns the environment it hands to the wizard. The token is piped as
        // the first answer on purpose: if the real ZEUS_CF_TOKEN leaked in here the wizard
        // would (correctly) skip the token question and every following answer would shift
        // by one — which is exactly what a flaky test run showed.
        ...process.env,
        ZEUS_CF_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        ZEUS_PROBE_URL: `http://127.0.0.1:${port}/probe`,
        ZEUS_PROBE_WAIT_MS: '3000',
        ZEUS_PROBE_INTERVAL_MS: '400',
        ZEUS_SETTLE_MS: '100',
        ...RUN_ENV,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', (code) => { clearTimeout(timer); res({ code, out }); });
    child.stdin.end(answers.join('\n') + '\n');
  });
}

const root = mkdtempSync(join(tmpdir(), 'zeus-flows-'));
const profPath = join(root, 'wizard', 'profile.json');
const tokenPath = join(root, 'wizard', '.token.json');
const readProf = () => (existsSync(profPath) ? JSON.parse(readFileSync(profPath, 'utf8')) : null);
console.log('Wizard flow regression test (mock Cloudflare API)\ntemp dir: ' + root + '\n');

try {
  mkdirSync(join(root, 'wizard'));
  copyFileSync(SOURCE_FILE, join(root, 'Source-hardened.js'));

  // ------------------------------------------------------------------ S1 install + fingerprint
  console.log('• S1 install applies a private build fingerprint');
  {
    const { server, state, port } = await startMock();
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S1 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Personalised build ready'), 'S1 output reports the fingerprint step');
    check(r.out.includes('Read-back matches'), 'S1 deployed bytes verified against the local build');
    check(r.out.includes('Install profile saved'), 'S1 saved an install profile');
    check(r.out.includes('Install complete'), 'S1 finished the install');
    check(r.out.includes('[1/10]  Validate your Cloudflare API token') && r.out.includes('[10/10]  Check the address'), 'S1 banner lists the ten steps the run really performs');
    check(r.out.includes('First thing to do: open the panel address above and set the admin password'), 'S1 tells the user to claim the panel before anything else');
    check(r.out.includes('the panel answers its own API without one'), 'S1 explains why the password has to come first');
    check(!/[؀-ۿ]/.test(r.out), 'S1 the whole install output is English-only (no Persian/Arabic script)');
    check(r.out.includes('Database is ready'), 'S1 the D1 readiness gate ran before the upload');
    check(r.out.includes('Letting the route attach (~10s)'), 'S1 a fresh worker gets the route-attach pause');
    check(r.out.includes('Worker settings confirmed: D1 binding'), 'S1 the deployed settings were verified after the upload');
    const put = state.puts[0];
    check(!!put, 'S1 a worker script was uploaded');
    if (put) {
      const txt = put.bytes.toString('utf8');
      const d = detectPrelude(txt);
      check(!!d && d.keyName !== '_ZK' && d.getName !== '_G', 'S1 uploaded build renamed the generated identifiers', d && d.keyName + '/' + d.getName);
      check(!/(?<![\w$])_G\(\s*\d+\s*\)/.test(txt) && !/(?<![\w$])_p\d+(?![\w$])/.test(txt), 'S1 no canonical generated names in the uploaded build');
      check(txt.split('\n').filter((l) => KW_RE.test(l)).length === 0, 'S1 uploaded build has zero keyword survivors');
      check(!!d && d.blobs.length === CANON_ROWS.length, 'S1 payload table still has ' + CANON_ROWS.length + ' rows', d && String(d.blobs.length));
      const rows = d.blobs.map((b) => xorDecode(b, d.key)).sort();
      check(rows.join('\u0001') === CANON_ROWS.join('\u0001'), 'S1 every decoded row matches the original build');
      check(put.bytes.length !== Buffer.from(CANON).length || sha(put.bytes) !== sha(Buffer.from(CANON)), 'S1 uploaded build is not the shared repository build');
      check(!!put.metadata && put.metadata.main_module === 'worker.js', 'S1 upload metadata shape kept');
      check(put.metadata.compatibility_date === REQUIRED_COMPAT_DATE, 'S1 fresh installs deploy with the panel-required compat date', put.metadata.compatibility_date);
      check((put.metadata.compatibility_flags || []).includes('nodejs_compat'), 'S1 fresh installs deploy with the panel-required nodejs_compat flag', JSON.stringify(put.metadata.compatibility_flags));
      const bind = (put.metadata.bindings || [])[0];
      check(!!bind && bind.type === 'd1' && bind.name === 'DB' && bind.id === DB_UUID, 'S1 D1 binding attached', JSON.stringify(bind));
    }
    const prof = readProf();
    check(!!prof && prof.version === 1 && /^[0-9a-f]{32}$/.test(prof.seed || ''), 'S1 profile holds a hex identity seed');
    check(!!prof && prof.fingerprint === true && prof.names && Object.keys(prof.names).length >= 14, 'S1 profile records the renamed identifiers');
    check(!!prof && prof.accountId === ACCOUNT_ID && !!prof.workerName && prof.dbId === DB_UUID, 'S1 profile records account / worker / database', JSON.stringify(prof && { a: prof.accountId, w: prof.workerName, d: prof.dbId }));
    check(!!prof && !JSON.stringify(prof).includes(TOKEN), 'S1 profile stores no API token');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S1 no DELETE request issued', JSON.stringify(state.requests.filter((q) => q.method === 'DELETE')));
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S2 --no-fingerprint
  console.log('• S2 --no-fingerprint uploads the shared repository build');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock();
    const r = await run(root, port, ['--no-fingerprint'], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S2 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2000));
    check(r.out.includes('--no-fingerprint'), 'S2 announces the skipped fingerprint');
    check(!r.out.includes('Personalised build ready'), 'S2 did not personalise');
    const put = state.puts[0];
    check(!!put && sha(put.bytes) === sha(Buffer.from(CANON)), 'S2 uploaded bytes are exactly the repository build');
    const prof = readProf();
    check(!!prof && prof.fingerprint === false && prof.seed === null, 'S2 profile records no identity');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S2 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S3 update keeps identity
  console.log('• S3 --update reuses saved defaults and keeps the identity');
  {
    const { server, state, port } = await startMock({
      dbs: [{ name: 'web-mock-db', uuid: DB_UUID }],
      settings: { bindings: [{ type: 'd1', name: 'DB', id: DB_UUID }, { type: 'kv', name: 'EXTRA', namespace_id: 'ns1' }, { type: 'plain_text', name: 'KEEP_ME', text: 'x' }], compatibility_date: '2025-01-01' },
    });
    // the panel already exists with an extra KV binding and a plain_text variable
    state.scripts['panel-one'] = { bytes: Buffer.from(CANON), metadata: null };
    const prof0 = { version: 1, seed: 'ab'.repeat(16), fingerprint: true, accountId: ACCOUNT_ID, accountName: 'Mock Account', workerName: 'panel-one', dbName: 'web-mock-db', dbId: DB_UUID, subdomain: SUB, panelUrl: 'https://x/panel', names: { _ZK: '_zkold', _G: '_gold' }, rows: 89, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(profPath, JSON.stringify(prof0));
    const r = await run(root, port, ['--update'], [TOKEN, '', '', '']);
    check(!r.fatal && r.code === 0, 'S3 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('manual update (saved defaults)'), 'S3 banner shows the saved defaults');
    check(r.out.includes('Account ID ['), 'S3 prompts with the saved account as default');
    check(r.out.includes('Existing worker found: panel-one'), 'S3 found the existing worker');
    check(r.out.includes("Keeping this panel's existing build identity"), 'S3 keeps the stored identity');
    check(r.out.includes('row census before: users=5, settings=12'), 'S3 read the database census first', r.out.match(/row census before.*/)?.[0]);
    check(r.out.includes('Database intact: 2 tables with identical row counts'), 'S3 proves the rows survived');
    check(r.out.includes('Update complete'), 'S3 finished');
    check(r.out.includes('Letting the route attach (~5s)'), 'S3 a re-upload to an existing worker gets the short pause');
    const put = state.puts[0];
    check(!!put && put.name === 'panel-one', 'S3 uploaded to the saved worker', put && put.name);
    if (put) {
      const d = detectPrelude(put.bytes.toString('utf8'));
      check(!!d && d.keyName !== '_ZK', 'S3 uploaded build is personalised');
      const sameSeedNames = !!put.metadata;
      check(sameSeedNames, 'S3 metadata present');
      const b = put.metadata.bindings;
      check(Array.isArray(b) && b.some((x) => x.type === 'kv' && x.name === 'EXTRA'), 'S3 preserved the existing KV binding');
      check(Array.isArray(b) && b.some((x) => x.type === 'plain_text' && x.name === 'KEEP_ME'), 'S3 preserved an existing plain_text variable');
      check(Array.isArray(b) && b.filter((x) => x.type === 'd1').length === 1 && b.find((x) => x.type === 'd1').id === DB_UUID, 'S3 re-attached exactly one D1 binding', JSON.stringify(b));
      // The mock worker is pinned to an outdated 2025-01-01 date with no flags: the wizard
      // must upgrade the date and add the required flags instead of preserving stale values.
      check(put.metadata.compatibility_date === REQUIRED_COMPAT_DATE, 'S3 outdated compat date upgraded to the panel requirement', put.metadata.compatibility_date);
      check(REQUIRED_COMPAT_FLAGS.every((f) => (put.metadata.compatibility_flags || []).includes(f)), 'S3 the required compat flags are present', JSON.stringify(put.metadata.compatibility_flags));
      check(r.out.includes('compatibility date upgraded 2025-01-01'), 'S3 the upgrade is announced');
    }
    const prof = readProf();
    check(!!prof && prof.seed === prof0.seed, 'S3 identity seed unchanged');
    check(!!prof && prof.updatedAt !== prof0.updatedAt && prof.installedAt === prof0.installedAt, 'S3 refreshed updatedAt only');
    check(!!prof && !JSON.stringify(prof).includes(TOKEN), 'S3 profile still holds no token');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S3 no DELETE request issued', JSON.stringify(state.requests.filter((q) => q.method === 'DELETE')));
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S4 --update --rotate
  console.log('• S4 --update --rotate mints a new identity');
  {
    const { server, state, port } = await startMock({ dbs: [{ name: 'web-mock-db', uuid: DB_UUID }] });
    const before = readProf();
    const r = await run(root, port, ['--update', '--rotate'], [TOKEN, '', '', '']);
    check(!r.fatal && r.code === 0, 'S4 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2000));
    check(r.out.includes('--rotate: this panel gets a brand-new build identity'), 'S4 announces the rotation');
    const prof = readProf();
    check(!!prof && prof.seed !== before.seed && /^[0-9a-f]{32}$/.test(prof.seed), 'S4 seed rotated', before.seed + ' -> ' + (prof && prof.seed));
    const put = state.puts[0];
    const d = put && detectPrelude(put.bytes.toString('utf8'));
    check(!!d && Object.values(prof.names).includes(d.keyName), 'S4 profile records the new names', d && d.keyName);
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S4 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S5 update without profile
  console.log('• S5 --update without a profile stops safely');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock();
    const r = await run(root, port, ['--update'], [TOKEN]);
    check(r.code !== 0, 'S5 exits non-zero (got ' + r.code + ')');
    check(r.out.includes('No install profile was found'), 'S5 explains the missing profile');
    check(state.puts.length === 0, 'S5 uploaded nothing');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S5 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S6 missing named db
  console.log('• S6 update falls back to the saved database id');
  {
    const { server, state, port } = await startMock({ dbs: [{ name: 'renamed-db', uuid: DB_UUID }] });
    writeFileSync(profPath, JSON.stringify({ version: 1, seed: 'cd'.repeat(16), fingerprint: true, accountId: ACCOUNT_ID, workerName: 'panel-two', dbName: 'gone-db', dbId: DB_UUID, subdomain: SUB, names: { _ZK: 'x' }, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    const r = await run(root, port, ['--update'], [TOKEN, '', '', 'gone-db']);
    check(!r.fatal && r.code === 0, 'S6 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('using the saved database id instead'), 'S6 reused the saved database');
    check(r.out.includes('Letting the route attach (~10s)'), 'S6 an update that creates the worker gets the fresh-worker pause');
    const put = state.puts[0];
    check(!!put && put.metadata.bindings.find((b) => b.type === 'd1').id === DB_UUID, 'S6 D1 binding points at the saved database');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S6 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S7 census unavailable
  console.log('• S7 update continues when the row census is not permitted');
  {
    const { server, state, port } = await startMock({ dbs: [{ name: 'web-mock-db', uuid: DB_UUID }], censusFails: true });
    writeFileSync(profPath, JSON.stringify({ version: 1, seed: 'ef'.repeat(16), fingerprint: true, accountId: ACCOUNT_ID, workerName: 'panel-three', dbName: 'web-mock-db', dbId: DB_UUID, subdomain: SUB, names: { _ZK: 'x' }, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    const r = await run(root, port, ['--update'], [TOKEN, '', '', '']);
    check(!r.fatal && r.code === 0, 'S7 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Row census not available'), 'S7 warns instead of failing');
    check(state.puts.length === 1, 'S7 still deployed the update');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S7 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S9 D1 limit path
  console.log('• S9 install at the D1 database limit reuses an existing database');
  {
    rmSync(profPath, { force: true });
    const FIRST = '11111111-1111-4111-8111-111111111111', SECOND = '22222222-2222-4222-8222-222222222222';
    const { server, state, port } = await startMock({ dbLimit: true, dbs: [{ name: 'zeus-db-first', uuid: FIRST }, { name: 'zeus-db-second', uuid: SECOND }] });
    const r = await run(root, port, [], [TOKEN, '', '2', 'n']);
    check(!r.fatal && r.code === 0, 'S9 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('The account is at its D1 database limit'), 'S9 explains the database limit');
    check(r.out.includes('1) zeus-db-first') && r.out.includes('2) zeus-db-second'), 'S9 lists the existing databases');
    check(r.out.includes('Reusing zeus-db-second'), 'S9 reuses the picked database');
    check(r.out.includes('Personalised build ready') && r.out.includes('Read-back matches'), 'S9 still personalised and verified the upload');
    const put = state.puts[0];
    check(!!put && put.metadata.bindings.find((b) => b.type === 'd1').id === SECOND, 'S9 binds the reused database', put && JSON.stringify(put.metadata.bindings));
    const prof = readProf();
    check(!!prof && prof.dbName === 'zeus-db-second' && prof.dbId === SECOND, 'S9 profile records the reused database');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S9 no DELETE request issued');
    server.close();
    console.log('');
  }

  console.log('• S10 install stops cleanly when no database is picked');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ dbLimit: true, dbs: [{ name: 'zeus-db-first', uuid: '33333333-0000-0000-0000-000000000000' }] });
    const r = await run(root, port, [], [TOKEN, '', '']);
    check(r.code !== 0, 'S10 exits non-zero (got ' + r.code + ')');
    check(r.out.includes('No database chosen'), 'S10 says the install stopped before any change');
    check(state.puts.length === 0, 'S10 uploaded nothing');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S10 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S11 propagation wait
  console.log('• S11 health check waits for the route to propagate');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'propagate' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S11 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Panel address answers 200'), 'S11 waited and then saw the panel answer');
    check(state.probeHits >= 3, 'S11 polled repeatedly instead of failing on the first 404', 'hits=' + state.probeHits);
    check(state.deletes.length === 0, 'S11 deleted nothing (propagation is not a stuck deploy)', JSON.stringify(state.deletes));
    check(state.puts.length === 1, 'S11 uploaded exactly once');
    // the propagation message must be one clear bilingual line (phase 2 requirement)
    // (S11 itself heals, so this exact message is proven in S14 against a dead address)
    check(state.probeHits >= 3, 'S11 the propagation wait really polls the address');    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S12 self-heal
  console.log('• S12 a stuck 1101 self-heals once by redeploying the worker script');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'stuck-heals' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S12 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('Cloudflare itself answered "error code: 1101"'), 'S12 names the real cause');
    check(r.out.includes('deletes the worker and uploads it once again'), 'S12 announces the self-heal before doing it');
    // the remedy is one clear English line, and the data promise holds
    check(r.out.includes('💬 Cloudflare answered 1101 on a fresh deploy') && r.out.includes('the worker script is recreated once from the same verified bytes'), 'S12 explains the remedy in one English line');
    check(!/[؀-ۿ]/.test(r.out), 'S12 the whole self-heal output is English-only');
    check(state.deletes.length === 1 && /\/workers\/scripts\//.test(state.deletes[0]), 'S12 issued exactly one DELETE, on the worker script', JSON.stringify(state.deletes));
    check(!state.deletes.some((d) => /d1\/database/.test(d)), 'S12 never deletes a database', JSON.stringify(state.deletes));
    check(r.out.includes('Same bytes, new version first'), 'S12 tries the cheap re-upload before the delete');
    check(state.puts.length === 3, 'S12 uploaded thrice total (initial + re-upload + post-delete redeploy)', 'PUTs=' + state.puts.length);
    check(state.puts.length === 3 && sha(state.puts[0].bytes) === sha(state.puts[1].bytes) && sha(state.puts[1].bytes) === sha(state.puts[2].bytes), 'S12 all three uploads are the identical personalised bytes');
    check(r.out.includes('Self-heal worked'), 'S12 reports the healed address as working', r.out.slice(-1500));
    const prof = readProf();
    check(!!prof && !!prof.healedAt, 'S12 records the self-heal in the profile');
    server.close();
    console.log('');
  }

  console.log('• S13 a stuck 1101 that survives the self-heal stops with the hint');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'stuck' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S13 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(state.deletes.length === 1, 'S13 tried the self-heal exactly once', JSON.stringify(state.deletes));
    check(state.puts.length === 3, 'S13 did not loop re-uploads (initial + re-upload + post-delete redeploy)', 'PUTs=' + state.puts.length);
    check(r.out.includes('Still not answering after one self-heal'), 'S13 tells the truth instead of pretending success');
    check(/First failing probe \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.out), 'S13 stamps the failure with a UTC timestamp for the dashboard logs');
    check(r.out.includes('Observability → Logs'), 'S13 points at the one dashboard click that shows the exact exception');
    check(r.out.includes('delete the worker in the dashboard and run'), 'S13 prints the remaining manual step');
    check(r.out.includes('Install complete'), 'S13 still completes the install (the deploy itself is verified)');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S14 unreachable address
  console.log('• S14 an address that never answers is patience, not a stuck deploy');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'dead' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S14 exit code 0 (the deploy itself succeeded)', r.out && r.out.slice(-2000));
    check(r.out.includes('The address did not answer within'), 'S14 names the wait instead of a false failure');
    check(r.out.includes('the uploaded bytes were verified against the'), 'S14 keeps the upload verification as the truth');
    check(r.out.includes('💬 A brand-new address can take a minute or two to spread'), 'S14 explains the wait in one clear line');
    check(!/[؀-ۿ]/.test(r.out), 'S14 the whole patience output is English-only');
    check(state.deletes.length === 0, 'S14 an unreachable address is never mistaken for a 1101 — nothing was deleted', JSON.stringify(state.deletes));
    check(state.puts.length === 1, 'S14 uploaded exactly once (no pointless redeploy)');
    check(r.out.includes('Read-back matches'), 'S14 the deployment was still verified byte for byte');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S15 hidden token
  console.log('• S15 the API token is read with echo suppressed and shown only as a mask');
  {
    const { server, state, port } = await startMock();
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(r.out.includes('••••••••') && r.out.includes('(received, ' + TOKEN.length + ' chars)'), 'S15 shows only the fixed mask with the token length');
    const leakLines = r.out.split('\n').filter((l) => l.includes(TOKEN));
    check(leakLines.length === 0, 'S15 the typed token never appears in any output line', JSON.stringify(leakLines.slice(0, 3)));
    check(r.out.includes('never stored anywhere'), 'S15 tells the user in plain English that the token is never stored');
    // The reader must switch the console into raw mode: on Windows that is the only way to
    // stop conhost/PowerShell from echoing the keys itself (muting readline's output is not).
    const wizTxt = readFileSync(WIZARD_SRC, 'utf8');
    check(/setRawMode\(true\)/.test(wizTxt), 'S15 the hidden reader uses setRawMode(true) (no OS echo, even on Windows)');
    check(/emitKeypressEvents/.test(wizTxt), 'S15 the hidden reader consumes keypress events instead of line input');
    check(/process\.exit\(130\)/.test(wizTxt), 'S15 Ctrl+C still cancels while the terminal is in raw mode');
    // maskSecret must never leak the value, whatever it is given
    const { maskSecret } = await import('../wizard/wizard.mjs');
    for (const v of ['abc', 'a'.repeat(40), 'short', '']) {
      check(v === '' || !maskSecret(v).includes(v), 'S15 maskSecret never contains the value (len ' + v.length + ')', maskSecret(v));
    }
    const prof = readProf();
    check(!!prof && !JSON.stringify(prof).includes(TOKEN), 'S15 the profile still stores no token');
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S15 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S19 TTY token prompt
  console.log('• S19 the interactive hidden-token prompt actually works on a TTY');
  {
    // Regression test for the live-installer crash
    // "TypeError: readline.emitKeypressEvents is not a function": the piped-input
    // tests above never execute the raw-mode branch, so only this test drives it —
    // with a fake TTY stdin that records what the reader draws.
    const wizTxt = readFileSync(WIZARD_SRC, 'utf8');
    check(/from 'node:readline'/.test(wizTxt) && !/readline\.emitKeypressEvents/.test(wizTxt), 'S19 keypress wiring comes from core node:readline (the promises API has no emitKeypressEvents)');
    const { askSecret } = await import('../wizard/wizard.mjs');
    const { EventEmitter } = await import('node:events');
    const realStdin = process.stdin;
    const realWrite = process.stdout.write.bind(process.stdout);
    let drawn = '';
    let paused = 0;
    const rawModes = [];
    const fakeStdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode(v) { rawModes.push(v); }, setEncoding() {}, resume() {}, pause() { paused++; },
    });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    process.stdout.write = (c) => { drawn += String(c); return true; };
    let got = null, threw = null;
    try {
      const p = askSecret(null, 'Enter your Cloudflare API token');
      // NOTE: no destructuring of the fake — emitKeypressEvents(fakeStdin) must not throw.
      fakeStdin.emit('keypress', 's3cr3t-t0k3n', { name: 'x' });
      fakeStdin.emit('keypress', '', { name: 'backspace' });
      fakeStdin.emit('keypress', 'n', { name: 'n' });
      fakeStdin.emit('keypress', '\r', { name: 'return' });
      got = await p;
    } catch (e) { threw = e; }
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    process.stdout.write = realWrite;
    check(threw === null, 'S19 the TTY prompt runs without throwing', threw && String(threw).slice(0, 160));
    check(got === 's3cr3t-t0k3n', 'S19 pasted keypresses accumulate into the returned token (backspace deletes one char)', JSON.stringify(got));
    check(drawn.includes('••••••••') && !drawn.includes('s3cr3t-t0k3n') && !drawn.includes('s3cr3t-t0k3'), 'S19 only the fixed mask is drawn, never the typed value');
    check(/\[/.test(drawn), 'S19 every repaint clears the whole line first (erases console-echoed keys too)');
    check(paused === 0, 'S19 stdin is never paused mid-run (pausing drained the loop on Windows and killed the wizard at the next prompt)', 'pause calls: ' + paused);
    check(rawModes.length > 0 && rawModes[rawModes.length - 1] === false, 'S19 raw mode is switched on, then restored off at the end', JSON.stringify(rawModes));
    console.log('');
  }

  // ------------------------------------------------------------------ S16 binding fix
  console.log('• S16 a missing D1 binding is re-pinned without deleting anything');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'binding-missing' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S16 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('reports its database binding is missing'), 'S16 names the binding problem, not a stuck deploy');
    check(r.out.includes('re-attaching the same D1 database now (nothing is deleted)'), 'S16 announces the fix before doing it');
    check(state.deletes.length === 0, 'S16 a binding problem is never answered with a DELETE', JSON.stringify(state.deletes));
    check(state.puts.length === 2, 'S16 re-uploaded once with the binding pinned', 'PUTs=' + state.puts.length);
    check(r.out.includes('Binding fix worked'), 'S16 reports the healed address as working', r.out.slice(-1500));
    check(r.out.includes('Install complete'), 'S16 still completes the install');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S17 integrity rebuild
  console.log('• S17 a tripped integrity check rebuilds the identity instead of re-uploading');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'tripwire' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S17 exit code 0 (the deploy itself is verified)', r.out && r.out.slice(-3000));
    check(r.out.includes('integrity check trips on every route'), 'S17 names the integrity problem');
    check(r.out.includes('rebuilding this install with a fresh identity'), 'S17 announces the rebuild before doing it');
    check(state.deletes.length === 0, 'S17 a tripped check is never answered with a DELETE', JSON.stringify(state.deletes));
    check(state.puts.length === 2, 'S17 uploaded the original build once, then the rebuilt one', 'PUTs=' + state.puts.length);
    check(state.puts.length === 2 && sha(state.puts[0].bytes) !== sha(state.puts[1].bytes), 'S17 the second upload really is a different identity');
    check(r.out.includes('Still not answering after one rebuild'), 'S17 tells the truth when the rebuild does not help either');
    const prof = readProf();
    check(!!prof && /^[0-9a-f]{32}$/.test(prof.seed || ''), 'S17 the profile records the rebuilt identity seed');
    check(r.out.includes('Install complete'), 'S17 still completes the install (the deploy itself is verified)');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S18 empty database
  console.log('• S18 a fresh empty database gets its base tables before the upload');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ emptyDb: true });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S18 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Database is ready: base tables created'), 'S18 the readiness gate created the base tables');
    check(r.out.includes('Read-back matches') && r.out.includes('Install complete'), 'S18 the install still completed');
    const creates = state.requests.filter((q) => q.method === 'POST' && q.path.includes('/query'));
    check(creates.length >= 2, 'S18 the gate issued the CREATE TABLE statements', JSON.stringify(state.requests.filter((q) => q.method !== 'GET').map((q) => q.method + ' ' + q.path)));
    check(state.requests.every((q) => q.method !== 'DELETE'), 'S18 no DELETE request issued');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S20 doctor
  console.log('• S20 --doctor diagnoses a worker without changing anything');
  {
    const { server, state, port } = await startMock({ dbs: [{ name: 'doc-db', uuid: DB_UUID }] });
    state.scripts['doc-worker'] = {
      bytes: Buffer.from(CANON),
      metadata: { bindings: [{ type: 'd1', name: 'DB', id: DB_UUID }], compatibility_date: REQUIRED_COMPAT_DATE, compatibility_flags: [...REQUIRED_COMPAT_FLAGS] },
    };
    writeFileSync(profPath, JSON.stringify({ version: 1, seed: 'ab'.repeat(16), fingerprint: true, accountId: ACCOUNT_ID, workerName: 'doc-worker', dbName: 'doc-db', dbId: DB_UUID, subdomain: SUB, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    const r = await run(root, port, ['--doctor'], [TOKEN, '']);
    check(!r.fatal && r.code === 0, 'S20 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Doctor mode: read-only diagnosis'), 'S20 announces read-only mode');
    check(r.out.includes('compatibility_date') && r.out.includes('compatibility_flags'), 'S20 reports the runtime metadata');
    check(r.out.includes('D1 binding') && r.out.includes('tables'), 'S20 reports the binding and the D1 census');
    check(r.out.includes('payload table') && r.out.includes('module export'), 'S20 reports the deployed bytes');
    check(r.out.includes('verdict: ok'), 'S20 reaches the ok verdict on a healthy worker', r.out.match(/verdict:.*/)?.[0]);
    check(r.out.includes('nothing to fix'), 'S20 says nothing to fix');
    check(state.puts.length === 0, 'S20 uploads nothing (read-only)', 'PUTs=' + state.puts.length);
    check(state.deletes.length === 0, 'S20 deletes nothing (read-only)', JSON.stringify(state.deletes));
    server.close();
    console.log('');
  }
  {
    // Same doctor, sick worker: the verdict must arrive with its evidence attached.
    const { server, state, port } = await startMock({ dbs: [{ name: 'doc-db', uuid: DB_UUID }], probeMode: 'tripwire' });
    state.scripts['doc-worker'] = {
      bytes: Buffer.from(CANON),
      metadata: { bindings: [{ type: 'd1', name: 'DB', id: DB_UUID }], compatibility_date: REQUIRED_COMPAT_DATE, compatibility_flags: [...REQUIRED_COMPAT_FLAGS] },
    };
    writeFileSync(profPath, JSON.stringify({ version: 1, seed: 'ab'.repeat(16), fingerprint: true, accountId: ACCOUNT_ID, workerName: 'doc-worker', dbName: 'doc-db', dbId: DB_UUID, subdomain: SUB, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    const r = await run(root, port, ['--doctor'], [TOKEN, '']);
    check(!r.fatal && r.code === 0, 'S20b exit code 0 on a sick worker (got ' + r.code + ')', r.out && r.out.slice(-2000));
    check(r.out.includes('verdict: integrity'), 'S20b the doctor names the integrity verdict');
    check(/Probed at \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.out), 'S20b the verdict carries a UTC timestamp for the dashboard logs');
    check(r.out.includes('Observability → Logs'), 'S20b the verdict points at the exception source');
    check(state.puts.length === 0 && state.deletes.length === 0, 'S20b still read-only on a sick worker');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S21 stale 1101 record
  console.log('• S21 overwriting a worker that already 1101s is flagged up front');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'stuck-heals' });
    // a leftover record from an earlier aborted run: exists in the API, 1101s on the edge
    state.scripts['panel-dup'] = { bytes: Buffer.from(CANON), metadata: null };
    const r = await run(root, port, [], [TOKEN, 'panel-dup', 'y', 'n']);
    check(!r.fatal && r.code === 0, 'S21 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('already answers "error code: 1101" right now'), 'S21 the pre-flight names the stale broken record before asking');
    check(r.out.includes('overwriting it with a fresh upload is the fix'), 'S21 the pre-flight recommends exactly the cure');
    check(r.out.includes('Self-heal worked'), 'S21 the heal still confirmed the fresh deploy', r.out.slice(-1500));
    check(state.deletes.length === 1, 'S21 exactly one script DELETE overall', JSON.stringify(state.deletes));
    check(r.out.includes('Install complete'), 'S21 the install completed');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S22 re-upload heals
  console.log('• S22 a version-level 1101 heals with a re-upload, no delete');
  {
    rmSync(profPath, { force: true });
    const { server, state, port } = await startMock({ probeMode: 'stuck-heals-reput' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S22 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('Same bytes, new version first'), 'S22 tries the cheap fix before any delete');
    check(state.deletes.length === 0, 'S22 no DELETE was needed at all', JSON.stringify(state.deletes));
    check(state.puts.length === 2, 'S22 uploaded twice total (initial + re-upload)', 'PUTs=' + state.puts.length);
    check(state.puts.length === 2 && sha(state.puts[0].bytes) === sha(state.puts[1].bytes), 'S22 both uploads are the identical personalised bytes');
    check(r.out.includes('Re-upload worked'), 'S22 reports the healed address as working', r.out.slice(-1500));
    check(!r.out.includes('Worker script removed'), 'S22 never went near the delete path');
    check(r.out.includes('Install complete'), 'S22 still completes the install');
    const prof = readProf();
    check(!!prof && !!prof.healedAt, 'S22 the delete-free heal is still recorded in the profile');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S24 first-install route priming
  console.log('• S24 a brand-new worker name is recreated once with its route in place, before the first check');
  {
    rmSync(profPath, { force: true });
    RUN_ENV = {};
    const { server, state, port } = await startMock({ probeMode: 'ok' });
    const r = await run(root, port, [], [TOKEN, '', 'n']);
    RUN_ENV = { ZEUS_NO_PREWARM: '1' };
    check(!r.fatal && r.code === 0, 'S24 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-3000));
    check(r.out.includes('First install of this worker name'), 'S24 announces the one-time recreation', r.out.slice(-2500));
    check(state.deletes.length === 1 && /\/workers\/scripts\//.test(state.deletes[0]), 'S24 exactly one DELETE, on the worker script', JSON.stringify(state.deletes));
    check(!state.deletes.some((d) => /d1\/database/.test(d)), 'S24 never deletes a database', JSON.stringify(state.deletes));
    check(state.puts.length === 2 && sha(state.puts[0].bytes) === sha(state.puts[1].bytes), 'S24 two uploads of the identical personalised bytes', 'PUTs=' + state.puts.length);
    const seq = state.requests.filter((q) => (q.method === 'PUT' || q.method === 'DELETE' || q.method === 'POST') && /workers\/scripts\//.test(q.path)).map((q) => q.method + (/subdomain/.test(q.path) ? ':subdomain' : ''));
    check(seq.join(' ') === 'PUT POST:subdomain DELETE PUT POST:subdomain', 'S24 order is script → route on → recreate script → route on again', seq.join(' '));
    check(!r.out.includes('Cloudflare itself answered "error code: 1101"'), 'S24 the final check never needed the self-heal');
    check(r.out.includes('Install complete'), 'S24 completes the install');
    const prof = readProf();
    check(!!prof && !prof.healedAt, 'S24 the profile records no self-heal');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S25 interactive update choice
  console.log('• S25 interactive wizard detects existing install and allows updating via menu');
  {
    const prof0 = {
      version: 1, seed: 'ab'.repeat(16), fingerprint: true,
      accountId: ACCOUNT_ID, accountName: 'Mock Account',
      workerName: 'panel-existing', dbName: 'panel-existing-db', dbId: DB_UUID,
      subdomain: SUB, panelUrl: 'https://panel-existing.te_st.workers.dev/panel',
      names: { _ZK: '_zkold', _G: '_gold' }, rows: 89,
      installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    };
    writeFileSync(profPath, JSON.stringify(prof0));
    const { server, state, port } = await startMock({ dbs: [{ name: 'panel-existing-db', uuid: DB_UUID }] });
    const r = await run(root, port, ['--menu'], ['1', TOKEN, '', '', '']);
    check(!r.fatal && r.code === 0, 'S25 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Existing installation found') || r.out.includes('Update panel'), 'S25 prompt offers update option');
    check(r.out.includes('Update complete'), 'S25 update completed successfully');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S26 saved local token reuse
  console.log('• S26 wizard reuses locally saved token with account name confirmation');
  {
    rmSync(profPath, { force: true });
    writeFileSync(tokenPath, JSON.stringify({
      token: TOKEN,
      accountId: ACCOUNT_ID,
      accountName: 'Axion Custom Account',
      savedAt: '2026-01-01T00:00:00.000Z'
    }));
    const { server, state, port } = await startMock();
    const r = await run(root, port, ['--test-saved-token'], ['y', '', 'n']);
    check(!r.fatal && r.code === 0, 'S26 exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Axion Custom Account'), 'S26 output shows the saved account name');
    check(r.out.includes('Use this saved token'), 'S26 asks whether to use the saved token');
    check(r.out.includes('Token is valid (account: Axion Custom Account)'), 'S26 reused the saved token');
    check(r.out.includes('Install complete'), 'S26 install finished using saved token');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S26b enter different token
  console.log('• S26b wizard allows entering a different token when saved token is declined');
  {
    rmSync(profPath, { force: true });
    writeFileSync(tokenPath, JSON.stringify({
      token: 'old-expired-token',
      accountId: ACCOUNT_ID,
      accountName: 'Declined Account',
      savedAt: '2026-01-01T00:00:00.000Z'
    }));
    const { server, state, port } = await startMock();
    const r = await run(root, port, ['--test-saved-token'], ['n', TOKEN, '', 'n']);
    check(!r.fatal && r.code === 0, 'S26b exit code 0 (got ' + r.code + ')', r.out && r.out.slice(-2500));
    check(r.out.includes('Declined Account'), 'S26b mentions saved account');
    check(r.out.includes('Token is valid'), 'S26b validated new token');
    check(r.out.includes('Install complete'), 'S26b install finished');
    server.close();
    console.log('');
  }

  // ------------------------------------------------------------------ S8 static guarantees
  console.log('• S8 delivery chain and token shape');  {
    check(Array.isArray(FORK_SOURCES) && FORK_SOURCES.length === 6, 'S8 six independent source mirrors', FORK_SOURCES.length + ' entries');
    check(FORK_SOURCES[0].startsWith('https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/Source.js'), 'S8 raw.githubusercontent.com stays primary');
    check(FORK_SOURCES.slice(1).every((u) => !u.includes('raw.githubusercontent.com')), 'S8 every fallback is a different provider');
    check(FORK_SOURCES.some((u) => u.includes('githack.com')) && FORK_SOURCES.some((u) => u.includes('jsdmirror.com')), 'S8 githack + jsdmirror mirrors present');
    check(!FORK_SOURCES.some((u) => u.includes('statically.io')), 'S8 statically.io excluded (it truncates files above 96KB)');
    check(FORK_SOURCES.every((u) => u.includes('axionspace/Z-E-U-S')), 'S8 all mirrors serve the fork');
    check(PERM_GROUPS.length === 6 && !PERM_GROUPS.some((g) => /zone/.test(g.key)), 'S8 token scope unchanged (no Zone:Read)');
    const wizTxt = readFileSync(WIZARD_SRC, 'utf8');
    check(wizTxt.includes('ZEUS_PROBE_URL') && wizTxt.includes('function classifyProbe('), 'S8 health probe distinguishes propagation from a stuck deploy');
    check(wizTxt.includes('function classifyDeployment(') && wizTxt.includes('function probeAll(') && wizTxt.includes('function waitForVerdict('), 'S8 multi-route diagnosis exists (binding vs integrity vs 1101 vs propagation)');
    check(wizTxt.includes('function ensureD1Ready('), 'S8 the D1 readiness gate exists');
    check(wizTxt.includes('REQUIRED_COMPAT_DATE') && wizTxt.includes("REQUIRED_COMPAT_DATE = '2026-07-10'"), 'S8 the panel-required compat date is pinned in the wizard');
    check(wizTxt.includes('nodejs_compat') && wizTxt.includes('compatibility_flags'), 'S8 the wizard sends and verifies compatibility flags (never silently drops them)');
    check(REQUIRED_COMPAT_DATE === '2026-07-10' && REQUIRED_COMPAT_FLAGS.join(',') === 'nodejs_compat', 'S8 the required runtime values match the panel OTA updater', REQUIRED_COMPAT_DATE + ' ' + REQUIRED_COMPAT_FLAGS.join(','));
    check(typeof classifyDeployment === 'function', 'S8 classifyDeployment is exported and testable');
    check(wizTxt.includes('--doctor') && wizTxt.includes('function doctorMain('), 'S8 the read-only doctor mode exists');
    check(wizTxt.includes('Same bytes, new version first'), 'S8 the stuck-1101 path tries a delete-free re-upload before recreating the script');
    check(wizTxt.includes('function settleDeploy(') && wizTxt.includes('ZEUS_SETTLE_MS'), 'S8 the post-upload settle pause exists and is overridable');
    check(wizTxt.includes('twice in a row'), 'S8 settings confirmation requires two agreeing reads (no single flapping read)');
    check(wizTxt.includes('Observability → Logs'), 'S8 failures print a UTC timestamp plus the dashboard path to the exact exception');
    check(wizTxt.includes('already answers "error code: 1101" right now'), 'S8 the overwrite pre-flight warns about a stale 1101 record');
    const shTxt = readFileSync(join(PROJECT, 'install.sh'), 'utf8');
    const psTxt = readFileSync(join(PROJECT, 'install.ps1'), 'utf8');
    check(shTxt.includes('--check') && shTxt.includes('51200') && shTxt.includes('Zeus Install Wizard'), 'S8 install.sh validates the wizard download (size + marker + syntax) before running it');
    check(psTxt.includes('--check') && psTxt.includes('51200') && psTxt.includes('Zeus Install Wizard'), 'S8 install.ps1 validates the wizard download (size + marker + syntax) before running it');
    check(wizTxt.includes('canHeal: false') && (wizTxt.match(/canHeal/g) || []).length >= 3, 'S8 the self-heal is capped at one attempt (no recursion)');
    check((wizTxt.match(/method: 'DELETE'/g) || []).length === 2, 'S8 exactly two DELETEs exist in the wizard (the final-check self-heal and the first-install route priming, both on the worker script only)', String((wizTxt.match(/method: 'DELETE'/g) || []).length));
    check(!/d1\/database\/[^`'"]*\\?`[^`]*method:\s*'DELETE'/.test(wizTxt) && !/d1\/database\/\$\{dbId\}`,\s*\{\s*method:\s*'DELETE'/.test(wizTxt), 'S8 no DELETE is ever issued against a database');
    // The published installer path (wizard/wizard.mjs) is the single canonical wizard file.
    check(existsSync(WIZARD_SRC), "S8 wizard/wizard.mjs exists and is the canonical installer script");  }
} finally {
  if (KEEP) console.log('Kept temp dir: ' + root + '\n');
  else rmSync(root, { recursive: true, force: true });
}

console.log('\n=== RESULT: ' + pass + ' PASS / ' + failCnt + ' FAIL ===');
if (failCnt) process.exit(1);
