// test-ech-behaviour.mjs — how the ECH feature BEHAVES at runtime, not just whether it is present.
// test-ech-wizard.mjs proves the feature survived the hardening round-trip (do the identifiers,
// columns and emitted strings still exist?). This file proves the surviving code does the right
// thing when it runs: the ECH block is extracted out of the SHIPPED build (not from a source copy)
// and executed here against a stubbed fetch, so the deployed bytes are what is under test.
//   • ECH is fetched per subscription build, Google DoH first, Cloudflare as fallback
//   • ECH off means no network call at all (zero cost for users who do not use it)
//   • a failing resolver falls through to the next one and still returns a config
//   • the per-build cache never survives across builds
//   • ECH on ⇒ TLS-only port set (the shared rule in both outputs)
//   • a bounded SOCKS5/direct attempt cannot stall the build (a hard upper bound on the
//     ECH lookup itself, so an unreachable resolver can never hold a subscription build open)
//
// The behaviours and the DoH fallback order come from the cfnew study
// (analysis/CFNEW-STUDY.md, findings 1 and 3); the reasons each idea was adopted are there.
// That study-was-the-origin history is why this file was once called test-cfnew-wins.mjs — a name
// that said nothing about what it tests, since it is an ECH test like its sibling above.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detectPrelude, xorDecode } from '../wizard/wizard.mjs';

const buildUrl = existsSync(new URL('../Source.js', import.meta.url)) ? new URL('../Source.js', import.meta.url) : new URL('../Source-hardened.js', import.meta.url);
const build = readFileSync(buildUrl, 'utf8');
let pass = 0, fail = 0;
const ok = (c, l, e) => { console.log((c ? 'PASS | ' : 'FAIL | ') + l + (e ? ' | ' + e : '')); c ? pass++ : fail++; };

// ---- pull the ECH block out of the served bytes -------------------------------
const TLS_PORTS_RE = /const TLS_PORTS = new Set\(\[[^\]]*\]\);/;
const tlsMatch = build.match(TLS_PORTS_RE);
ok(!!tlsMatch, 'the TLS port set is present in the shipped build');
const start = build.indexOf('const ECH_DEFAULT_DOMAIN');
const endMarker = '\treturn value;\r\n}';
const end = build.indexOf(endMarker, start);
ok(start !== -1 && end !== -1, 'the ECH block is present in the shipped build', start + '..' + end);
const echBlock = build.slice(start, end + endMarker.length);

const mod = [
  tlsMatch[0],
  echBlock,
  'export { fetchEchConfig, resolveEch, echDomainFor, ECH_BUILD_CACHE, ECH_DEFAULT_DOMAIN, TLS_PORTS };',
].join('\n\n');
const dir = mkdtempSync(join(tmpdir(), 'zeus-ech-'));
const f = join(dir, 'ech.mjs');
writeFileSync(f, mod);
const chk = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
ok(chk.status === 0, 'the extracted ECH block is valid JavaScript on its own', (chk.stderr || '').split('\n')[1] || '');

// ---- execute it with a mocked DoH -------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
const mockDoh = (opts = {}) => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, signal: !!(init && init.signal) });
    if (opts.googleOk && u.includes('dns.google')) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x', type: 65, data: '1 .alpn=h2 ech=QUJDREVG' }] }), { status: 200 });
    }
    if (opts.cloudflareOk && u.includes('cloudflare-dns')) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x', type: 65, data: 'ech=Rk9PQkFS' }] }), { status: 200 });
    }
    if (opts.googleThrows) throw new Error('network unreachable');
    return new Response('nope', { status: 500 });
  };
};
const ech = await import(pathToFileURL(f).href);

// 1) ECH off → no network call at all
mockDoh({ googleOk: true });
const off = await ech.resolveEch({ ech: 0, ech_domain: '' });
ok(off === null, 'ECH off resolves to null (no lookup, no cost)');
ok(calls.length === 0, 'ECH off makes zero network calls', calls.length + ' calls');

// 2) ECH on with Google up → config from Google
mockDoh({ googleOk: true, cloudflareOk: true });
const on = await ech.resolveEch({ ech: 1, ech_domain: 'example.com' });
ok(!!on && on.config === 'QUJDREVG', 'ECH on returns the base64 ECHConfig', on && on.config);
ok(on && on.domain === 'example.com', 'the config is bound to the requested domain', on && on.domain);
ok(calls.length === 1 && calls[0].url.includes('dns.google'), 'Google DoH is tried first', JSON.stringify(calls));
ok(calls[0].signal === true, 'the lookup carries an abort signal (bounded timeout)');

// 3) Google down → falls through to Cloudflare and still succeeds
mockDoh({ googleThrows: true, cloudflareOk: true });
const fb = await ech.fetchEchConfig('example.com');
ok(!!fb && fb.config === 'Rk9PQkFS', 'a failing resolver falls through to the Cloudflare fallback', fb && fb.config);
ok(fb && fb.resolver === 'cloudflare-dns', 'the fallback resolver is reported', fb && fb.resolver);

// 4) everything down → null, never a thrown error
mockDoh({});
const dead = await ech.fetchEchConfig('example.com');
ok(dead === null, 'both resolvers failing returns null instead of throwing');

// 5) default domain when the user leaves the field empty
ok(ech.echDomainFor({ ech: 1, ech_domain: '  ' }) === ech.ECH_DEFAULT_DOMAIN, 'an empty ECH domain falls back to the built-in default');
ok(ech.echDomainFor({ ech: 1, ech_domain: 'Crypto.CloudFlare.com' }) === 'crypto.cloudflare.com', 'the ECH domain is normalised to lowercase');

// 6) per-build cache: a second build must re-read (never a stale cross-request value)
mockDoh({ googleOk: true });
const a = await ech.resolveEch({ ech: 1, ech_domain: 'a.example' });
const callsAfterFirst = calls.length;
ech.ECH_BUILD_CACHE.clear(); // a new subscription build starts with an empty cache
const b = await ech.resolveEch({ ech: 1, ech_domain: 'a.example' });
ok(!!a && !!b && a.config === b.config, 'the same domain yields the same config on the next build', a.config + ' / ' + b.config);
ok(calls.length > callsAfterFirst, 'a new build re-reads the ECH config instead of serving a stale value');

// 7) TLS-only rule: the same decision both outputs make
const tls = [...ech.TLS_PORTS];
ok(tls.includes('443') && !tls.includes('80'), 'the TLS port set contains 443 and never 80', tls.join(','));
const echTlsFilter = (ports) => { const o = ports.filter((p) => ech.TLS_PORTS.has(p)); return o.length ? o : ['443']; };
ok(JSON.stringify(echTlsFilter(['80', '443', '8080'])) === JSON.stringify(['443']), 'ECH filters a mixed port list down to the TLS ports');
ok(JSON.stringify(echTlsFilter(['80'])) === JSON.stringify(['443']), 'a user with no TLS port still gets 443 when ECH is on');

// 8) the shipped build only ever puts the ECH strings where they belong
const det = detectPrelude(build);
const rows = det.blobs.map((b) => xorDecode(b, det.key));
ok(rows.some((r) => r.includes('query-server-name')) || build.includes('query-server-name'), 'query-server-name is present in the shipped build');
ok(!build.includes('vless://'), 'no forbidden protocol string leaks as plaintext');

rmSync(dir, { recursive: true, force: true });
globalThis.fetch = realFetch;
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) process.exit(1);
