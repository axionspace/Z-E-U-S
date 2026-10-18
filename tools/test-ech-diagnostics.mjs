// test-ech-diagnostics.mjs — the ECH response headers on the subscription routes.
//
// Real code, extracted from the shipped build: the ECH block (so the lookup behaves exactly
// as deployed) and the header wrapper the route layer uses. The point is that a user can open
// their browser's network tab on a subscription URL and see whether ECH was applied, and if
// not, WHY — the case that was previously silent.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { detectPrelude, xorDecode } from '../wizard/wizard.mjs';

const build = readFileSync(new URL('../Source.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, e) => { console.log((c ? 'PASS | ' : 'FAIL | ') + l + (e ? ' | ' + e : '')); c ? pass++ : fail++; };

// --- slice the ECH block, the way the sibling suites do
const start = build.indexOf('const ECH_DEFAULT_HOST');
const endMarker = '\treturn value;\r\n}';
const end = build.indexOf(endMarker, build.indexOf('async function resolveEch')) + endMarker.length;
ok(start >= 0 && end > start, 'the ECH block is present in the shipped build', start + '..' + end);
const echBlock = build.slice(start, end);

// --- the header wrapper, lifted so its behaviour can be run. It ends at the `};` that closes
// the arrow function, which is the first one after its own `return resp;` fallback.
const wStart = build.indexOf('const withEchHeaders = (resp) => {');
ok(wStart >= 0, 'the header wrapper is present in the shipped build');
const wEnd = build.indexOf('};', build.indexOf('return resp;', wStart)) + 2;
const wrapper = build.slice(wStart, wEnd);
ok(wrapper.trimEnd().endsWith('};'), 'the wrapper slice is complete');
ok(!wrapper.includes('isYamlPath'), 'and stops before the route dispatch lines');

const dir = mkdtempSync(join(tmpdir(), 'zeus-diag-'));
const f = join(dir, 'm.mjs');
// echDiagnostics reads ECH_BUILD_CACHE and clientEchValue, both inside the ECH block.
writeFileSync(f, [
  echBlock,
  'export { echDiagnostics, resolveEch, fetchEchConfig, ECH_BUILD_CACHE, ECH_DEFAULT_DOMAIN };',
].join('\n\n'));
const m = await import(pathToFileURL(f).href);

const realFetch = globalThis.fetch;
const mockDoh = (opts) => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (opts.unreachable) throw new Error('network down');
    if (opts.serverError) return new Response('nope', { status: 500 });
    if (opts.noEchRecord) return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x', type: 65, data: '1 . alpn=h2' }] }), { status: 200 });
    if (opts.ok) return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x', type: 65, data: '1 . alpn=h2 ech=QUJDREVG' }] }), { status: 200 });
    return new Response('nope', { status: 500 });
  };
};

console.log('\n=== the status a user sees ===');
ok(m.echDiagnostics({ ech: 0, ech_client: 0 }).status === 'OFF', 'both modes off -> X-ECH-Status: OFF');

m.ECH_BUILD_CACHE.clear();
mockDoh({ ok: true });
await m.resolveEch({ ech: 1, ech_domain: 'good.example' });
const good = m.echDiagnostics({ ech: 1, ech_domain: 'good.example' });
ok(good.status === 'SUCCESS', 'a resolved lookup -> SUCCESS', JSON.stringify(good));
ok(good.length === 8, 'and reports the config length', 'len=' + good.length);
ok(good.domain === 'good.example', 'and the domain that was used', good.domain);
ok(!!good.resolver, 'and which resolver answered', good.resolver);

console.log('\n=== the failure says WHY, which is the whole point ===');
m.ECH_BUILD_CACHE.clear();
mockDoh({ noEchRecord: true });
await m.resolveEch({ ech: 1, ech_domain: 'norecord.example' });
const noRec = m.echDiagnostics({ ech: 1, ech_domain: 'norecord.example' });
ok(noRec.status === 'FAILED', 'a domain with no ech= record -> FAILED');
ok(/no HTTPS record with an ech= parameter/.test(noRec.reason), 'the reason names the real cause', noRec.reason);

m.ECH_BUILD_CACHE.clear();
mockDoh({ unreachable: true });
await m.resolveEch({ ech: 1, ech_domain: 'down.example' });
const down = m.echDiagnostics({ ech: 1, ech_domain: 'down.example' });
ok(down.status === 'FAILED', 'unreachable resolvers -> FAILED');
ok(/no DoH resolver reachable/.test(down.reason), 'and the reason distinguishes this case', down.reason);

console.log('\n=== client mode reports itself, not a lookup it never did ===');
const cl = m.echDiagnostics({ ech: 0, ech_client: 1, ech_client_value: 'cloudflare-ech.com+udp://1.1.1.1' });
ok(cl.status === 'CLIENT', 'client mode -> CLIENT (no server-side lookup happens)', JSON.stringify(cl));

globalThis.fetch = realFetch;

console.log('\n=== the header wrapper ===');
// Run the wrapper itself, with the diagnostics stubbed through a small shim.
const runWrapper = new Function('echDiagnostics', 'user', 'resp', wrapper + '\nreturn withEchHeaders(resp);');
const base = () => new Response('payload', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

const rOff = runWrapper(() => ({ status: 'OFF' }), { ech: 0 }, base());
ok(rOff.headers.get('X-ECH-Status') === 'OFF', 'the OFF status reaches the header');
ok(rOff.headers.get('X-ECH-Debug') === null, 'and no debug header is added when there is nothing to debug');

const rOk = runWrapper(() => ({ status: 'SUCCESS', mode: 'server', domain: 'd.example', resolver: 'dns.google', length: 96 }), { ech: 1 }, base());
ok(rOk.headers.get('X-ECH-Status') === 'SUCCESS' && rOk.headers.get('X-ECH-Config-Length') === '96',
  'SUCCESS carries the length', rOk.headers.get('X-ECH-Config-Length'));
ok(rOk.headers.get('X-ECH-Resolver') === 'dns.google', 'and the resolver that answered');
ok((await rOk.text()) === 'payload', 'the body is unchanged');
ok(rOk.headers.get('Content-Type') === 'text/plain' && rOk.headers.get('Cache-Control') === 'no-store',
  'and every existing header survives');

const rBad = runWrapper(() => ({ status: 'FAILED', mode: 'server', reason: 'the domain publishes no ECH config' }), { ech: 1 }, base());
ok(rBad.headers.get('X-ECH-Status') === 'FAILED', 'FAILED reaches the header');
ok(rBad.headers.get('X-ECH-Debug') === 'the domain publishes no ECH config', 'with the reason in X-ECH-Debug', rBad.headers.get('X-ECH-Debug'));
ok((await rBad.text()) === 'payload', 'and a failed lookup still delivers the subscription');

// Diagnostics must never be able to break a subscription.
const rThrow = runWrapper(() => { throw new Error('diagnostics exploded'); }, { ech: 1 }, base());
ok(rThrow && rThrow.status === 200, 'if the diagnostics throw, the original response still goes out');
ok((await rThrow.text()) === 'payload', 'with its body intact');

rmSync(dir, { recursive: true, force: true });
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
process.exit(fail ? 1 : 0);
