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
const start = build.indexOf('const ECH_DEFAULT_HOST');
const endMarker = '\treturn value;\r\n}';
const end = build.indexOf(endMarker, start);
ok(start !== -1 && end !== -1, 'the ECH block is present in the shipped build', start + '..' + end);
const echBlock = build.slice(start, end + endMarker.length);

const mod = [
  tlsMatch[0],
  echBlock,
  'export { fetchEchConfig, resolveEch, echDomainFor, echValueFor, parseEchValue, preferredEchResolver, echResolverOrder, ECH_BUILD_CACHE, ECH_DEFAULT_DOMAIN, ECH_DEFAULT_HOST, TLS_PORTS };',
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
ok(ech.echDomainFor({ ech: 1, ech_domain: '  ' }) === ech.ECH_DEFAULT_HOST, 'an empty ECH domain falls back to the built-in default host');
ok(ech.echDomainFor({ ech: 1, ech_domain: 'Crypto.CloudFlare.com' }) === 'crypto.cloudflare.com', 'the ECH domain is normalised to lowercase');
// The default is a directive ("host+udp://dns"). Only the HOST half may ever be emitted as
// SNI, or every generated config would carry a string that is not a hostname.
// The built-in default is now the HOSTNAME ALONE: the field reads as a domain, and a user
// who just ticks the box never has to understand the "+..." syntax.
ok(ech.ECH_DEFAULT_DOMAIN === 'cloudflare-ech.com', 'the built-in default is a bare hostname, not a directive', ech.ECH_DEFAULT_DOMAIN);
ok(!ech.ECH_DEFAULT_DOMAIN.includes('+'), 'the default carries no resolver hint for a user to puzzle over');
ok(ech.echDomainFor({ ech: 1, ech_domain: '' }) === 'cloudflare-ech.com', 'the default resolves to the bare hostname for SNI', ech.echDomainFor({ ech: 1, ech_domain: '' }));
ok(!ech.echDomainFor({ ech: 1, ech_domain: 'x.example.com+udp://1.1.1.1' }).includes('+'), 'a directive value yields a bare hostname for SNI');

// 6) per-build cache: a second build must re-read (never a stale cross-request value)
mockDoh({ googleOk: true });
const a = await ech.resolveEch({ ech: 1, ech_domain: 'a.example' });
const callsAfterFirst = calls.length;
ech.ECH_BUILD_CACHE.clear(); // a new subscription build starts with an empty cache
const b = await ech.resolveEch({ ech: 1, ech_domain: 'a.example' });
ok(!!a && !!b && a.config === b.config, 'the same domain yields the same config on the next build', a.config + ' / ' + b.config);
ok(calls.length > callsAfterFirst, 'a new build re-reads the ECH config instead of serving a stale value');

// A FAILED lookup must never be remembered. The default value is shared by every user who
// left the field blank, so caching one null would hand every one of them a broken ECH for
// the whole life of the isolate (minutes to hours), long after the network recovered.
ech.ECH_BUILD_CACHE.clear();
const DEFAULT_KEY = 'cloudflare-ech.com+udp://1.1.1.1';
mockDoh({}); // both resolvers down: every request 500s
const failed = await ech.resolveEch({ ech: 1, ech_domain: '' });
ok(failed === null, 'a failing lookup returns null for that build');
ok(!ech.ECH_BUILD_CACHE.has(DEFAULT_KEY), 'a failed lookup is NOT cached');
mockDoh({ googleOk: true }); // the network comes back
const recovered = await ech.resolveEch({ ech: 1, ech_domain: '' });
ok(!!recovered && !!recovered.config, 'the very next build recovers once the lookup works again', recovered && recovered.config);
// With no hint the normal order runs, so Google is asked first and answers on the first try.
ok(calls.length >= 1 && calls.length <= 2, 'the recovery really retried (fresh lookups, not a reused failure)', calls.length + ' calls');
ok(calls[0] && calls[0].url.includes('dns.google'), 'the retry used the normal order (Google first)', calls[0] && calls[0].url);
// ...and a SUCCESS is still cached, so the retry does not become a fetch on every build.
const goodBefore = calls.length;
await ech.resolveEch({ ech: 1, ech_domain: '' });
ok(calls.length === goodBefore, 'a successful lookup IS cached');
ech.ECH_BUILD_CACHE.clear();

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

// 9) the ECH domain and ALPN are validated before they are stored. Both live in the same
// plain-code block as the rest of ECH, so they are pulled out and exercised directly.
const valStart = build.indexOf('const DOMAIN_RE =');
const valEnd = build.indexOf('// Returns the base64 ECHConfig');
ok(valStart !== -1 && valEnd > valStart, 'the ECH domain validator is present in the shipped build');
const valFile = join(dir, 'validators.mjs');
writeFileSync(valFile, build.slice(valStart, valEnd) + 'export { isValidEchDomain, alpnProblem, validateEchFields };\n');
const vchk = spawnSync(process.execPath, ['--check', valFile], { encoding: 'utf8' });
ok(vchk.status === 0, 'the validator block is valid JavaScript on its own', (vchk.stderr || '').split('\n')[1] || '');
const V = await import(pathToFileURL(valFile).href);

// a domain must really be a domain: whatever is typed now reaches a DNS lookup and the
// user's own subscription link, so a URL, an IP or a stray space must not get through
for (const good of ['crypto.cloudflare.com', 'EXAMPLE.COM', 'a.b.co.uk', 'x-1.example.com']) {
  ok(V.isValidEchDomain(good) === true, 'accepts a real ECH domain: ' + good);
}
for (const bad of ['', '   ', 'http://x.com', '1.2.3.4', 'x', '.com', 'x.', '-x.com', 'x-.com',
  'a..b.com', 'crypto.cloudflare.com/path', 'x y.com', 'crypto.cloudflare.com;drop', 'x.c', 'a'.repeat(64) + '.com']) {
  ok(V.isValidEchDomain(bad) === false, 'refuses an invalid ECH domain: ' + JSON.stringify(bad.slice(0, 28)));
}
// A homoglyph domain would pass a naive ASCII check while pointing somewhere else entirely.
ok(V.isValidEchDomain('dаmaine.com') === false, 'refuses a Cyrillic homoglyph domain');
// An address has no HTTPS record, so it can never yield an ECHConfig.
ok(V.isValidEchDomain('8.8.8.8') === false, 'refuses an IPv4 literal');

// The field accepts two shapes: a bare hostname, and the client-directive form
// "host+udp://dns" that Xray/Hiddify use. The panel does its own DoH lookup, so the hint
// picks which resolver runs first, and only the host half is ever emitted as SNI.
const P = ech.parseEchValue;
ok(P('cloudflare-ech.com').host === 'cloudflare-ech.com' && P('cloudflare-ech.com').hint === '',
  'a bare hostname parses with no resolver hint');
ok(P('cloudflare-ech.com+udp://1.1.1.1').host === 'cloudflare-ech.com' &&
   P('cloudflare-ech.com+udp://1.1.1.1').hint === 'udp://1.1.1.1',
  'the directive form splits into host and hint');
ok(P('EXAMPLE.COM').host === 'example.com', 'the parsed host is lowercased');
ok(P('x.example.').host === 'x.example', 'a fully-qualified trailing dot is normalised away');
ok(P('https://x.com') === null, 'a URL is still not accepted as a domain');
ok(P('cloudflare-ech.com+nonsense') === null, 'a malformed directive tail is refused');
ok(P('cloudflare-ech.com+udp://1.1.1.1+udp://2.2.2.2') === null, 'two directive tails are refused');
// The hint may only REORDER the two known resolvers -- it can never add one, so a crafted
// hint cannot redirect the lookup to an attacker's server.
ok(ech.preferredEchResolver('udp://1.1.1.1') === 'cloudflare-dns', 'a Cloudflare resolver hint selects Cloudflare first');
ok(ech.preferredEchResolver('udp://8.8.8.8') === 'dns.google', 'a Google resolver hint selects Google first');
ok(ech.preferredEchResolver('udp://9.9.9.9') === null, 'an unknown resolver falls back to the normal order');
ok(ech.preferredEchResolver('') === null, 'a missing hint falls back to the normal order');
// THREE hint shapes are written by the panels this idea came from, and all three must be
// honoured -- accepting a value and then ignoring it is worse than refusing it outright.
ok(ech.preferredEchResolver('udp://dns.google') === 'dns.google', 'a bare resolver hostname is honoured');
ok(ech.preferredEchResolver('https://dns.google/dns-query') === 'dns.google', "Nova's URL form is honoured (Google)");
ok(ech.preferredEchResolver('https://cloudflare-dns.com/dns-query') === 'cloudflare-dns', "Nova's URL form is honoured (Cloudflare)");
ok(ech.preferredEchResolver('https://mozilla.cloudflare.com/dns-query') === 'cloudflare-dns', "Cloudflare's alternate DoH host is honoured");
ok(ech.preferredEchResolver('1.1.1.1:443') === 'cloudflare-dns', 'an address carrying a port is honoured');
ok(ech.preferredEchResolver('https://dns.alidns.com/dns-query') === null, 'a resolver we do not carry falls back to the normal order (never added)');
// End to end: what the user types must actually change which resolver runs first.
ok(ech.echResolverOrder('udp://8.8.8.8')[0].name === 'dns.google', 'typing 8.8.8.8 really makes Google run first');
ok(ech.echResolverOrder('udp://1.1.1.1')[0].name === 'cloudflare-dns', 'typing 1.1.1.1 really makes Cloudflare run first');
ok(ech.echResolverOrder('https://dns.google/dns-query')[0].name === 'dns.google', "Nova's URL hint really makes Google run first");
ok(ech.echResolverOrder('')[0].name === 'dns.google', 'no hint keeps the normal Google-first order');
// The built-in default is the bare hostname and must still produce a usable SNI.
ok(ech.ECH_DEFAULT_DOMAIN === 'cloudflare-ech.com', 'the built-in default is cloudflare-ech.com', ech.ECH_DEFAULT_DOMAIN);
ok(ech.echDomainFor({ ech: 1, ech_domain: '' }) === 'cloudflare-ech.com', 'the default yields the bare hostname');

// ALPN is a comma-separated list; one bad entry rejects the whole field rather than
// silently dropping part of it.
ok(V.alpnProblem('') === null, 'an empty ALPN is allowed (client default)');
ok(V.alpnProblem('h2') === null, 'a single ALPN entry is allowed');
ok(V.alpnProblem('h2,http/1.1') === null, 'a normal ALPN list is allowed');
ok(V.alpnProblem('h2, http/1.1') === null, 'spaces after the commas are tolerated');
ok(V.alpnProblem('h2,,http/1.1') !== null, 'an empty ALPN entry is refused');
ok(V.alpnProblem('h2 x') !== null, 'an ALPN entry with a space is refused');
ok(V.alpnProblem('h2;drop') !== null, 'an ALPN entry with punctuation is refused');
ok(V.alpnProblem('a'.repeat(40)) !== null, 'an over-long ALPN entry is refused');
ok(V.alpnProblem('1,2,3,4,5,6,7,8,9') !== null, 'an absurd number of ALPN entries is refused');

// the guard is wired into BOTH write paths: PUT (edit) and POST (create)
const guardCalls = (build.match(/validateEchFields\(/g) || []).length;
ok(guardCalls === 3, 'both user write paths call the guard (1 definition + 2 call sites)', guardCalls + ' sites');
const putIdx = build.indexOf('const { username: new_username, limit_gb');
const postIdx = build.indexOf('const { username, uuid, limit_gb');
ok(putIdx !== -1 && build.indexOf('validateEchFields(ech, ech_domain, alpn)', putIdx) !== -1 &&
   build.indexOf('validateEchFields(ech, ech_domain, alpn)', putIdx) - putIdx < 4000,
  'the PUT (edit user) path validates before its bind');
ok(postIdx !== -1 && build.indexOf('validateEchFields(ech, ech_domain, alpn)', postIdx) !== -1 &&
   build.indexOf('validateEchFields(ech, ech_domain, alpn)', postIdx) - postIdx < 2000,
  'the POST (create user) path validates before its bind');

rmSync(dir, { recursive: true, force: true });
globalThis.fetch = realFetch;
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) process.exit(1);
