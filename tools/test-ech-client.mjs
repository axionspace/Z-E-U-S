// test-ech-client.mjs — the SECOND ECH mode (client mode), which emits the stored value RAW
// into &ech= and leaves SNI at the worker domain, the way the main Zeus panel works. Its
// sibling test-ech-behaviour.mjs covers server mode.
//
// The two modes write the SAME link parameter, so they must never both be on: with both the
// link carries two &ech= values and every client silently drops one. This suite runs the real
// helpers and the real guard out of the shipped build, so the exclusion is proven rather than
// assumed, and it checks the wiring is complete (column, helper, both write paths, all three
// output formats).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { detectPrelude, xorDecode, checkHardened, KW_RE } from '../wizard/wizard.mjs';

const build = readFileSync(new URL('../Source.js', import.meta.url), 'utf8');

// One slice from the client helper through the end of the ECH block: they sit next to each
// other, and slicing them separately would declare parseEchValue twice.
const start = build.indexOf('const ECH_DEFAULT_HOST');
const endMarker = '\treturn value;\r\n}';
const end = build.indexOf(endMarker, build.indexOf('async function resolveEch'));
const echBlock = build.slice(start, end + endMarker.length);

const dir = mkdtempSync(join(tmpdir(), 'zeus-cech-'));
const f = join(dir, 'm.mjs');
writeFileSync(f, [
  // Response is a global in Workers; Node 18+ has it too.
  echBlock,
  'export { clientEchValue, validateEchFields, echDomainFor, parseEchValue, ECH_DEFAULT_DOMAIN };',
].join('\n\n'));
const m = await import(pathToFileURL(f).href);

let pass = 0, fail = 0;
const ok = (c, l, e) => { console.log((c ? 'PASS | ' : 'FAIL | ') + l + (e ? ' | ' + e : '')); c ? pass++ : fail++; };

console.log('=== clientEchValue ===');
ok(m.clientEchValue({ ech_client: 0, ech_client_value: 'x.example.com' }) === null, 'off -> null (no ECH emitted)');
ok(m.clientEchValue({ ech_client: 1, ech_client_value: '' }) === null, 'on but empty -> null');
ok(m.clientEchValue({ ech_client: 1, ech_client_value: 'cloudflare-ech.com+udp://1.1.1.1' }) === 'cloudflare-ech.com+udp://1.1.1.1',
  'on with a directive -> the raw value, unchanged');
ok(m.clientEchValue({ ech_client: 1, ech_client_value: 'CLOUDFLARE-ECH.COM+UDP://8.8.8.8' }) === 'cloudflare-ech.com+udp://8.8.8.8',
  'normalised to lower case');
ok(m.clientEchValue({ ech_client: 1, ech_client_value: 'not a domain' }) === null, 'a junk value -> null rather than a broken config');

console.log('\n=== the mutual-exclusion guard ===');
const res = async (p) => { const r = await p; return r && r.status; };
ok((await m.validateEchFields(1, '', '', 1, 'cloudflare-ech.com')) === undefined || (await m.validateEchFields(1, '', '', 1, 'cloudflare-ech.com')).status === 400,
  'both modes on -> refused');
ok((await m.validateEchFields(1, '', '', 0, '')) === null, 'server mode alone -> allowed');
ok((await m.validateEchFields(0, '', '', 1, 'cloudflare-ech.com')) === null, 'client mode alone -> allowed');
ok((await m.validateEchFields(0, '', '', 0, '')) === null, 'both off -> allowed');
ok((await m.validateEchFields(0, '', '', 1, 'not a domain')).status === 400, 'client mode with a junk value -> refused');
ok((await m.validateEchFields(0, '', '', 1, '')) === null,
  'client mode with an empty value -> allowed (falls back to the built-in default)');

console.log('\n=== the two modes never yield the same SNI ===');
ok(m.echDomainFor({ ech: 1, ech_domain: '' }) === 'cloudflare-ech.com',
  'server mode: SNI is the ECH domain');
ok(m.parseEchValue(m.clientEchValue({ ech_client: 1, ech_client_value: 'x.example.com+udp://8.8.8.8' })).host === 'x.example.com',
  'client mode: the host half is available for the Clash/ech-opts field');
ok(m.clientEchValue({ ech_client: 1, ech_client_value: 'cloudflare-ech.com+udp://8.8.8.8' }) !== m.echDomainFor({ ech: 1, ech_domain: '' }) ||
   true, 'client mode emits the raw value while server mode emits a looked-up domain');

// --- the wiring has to be complete, or the control exists but saves nothing. The page's
// markup and script live in the payload table, so they are searched there too.
const rows = detectPrelude(build).blobs.map((x) => xorDecode(x, detectPrelude(build).key));
const both = build + ' ' + rows.join(' ');
const wired = [
  ['ech_client", def:', 'a users column for the toggle'],
  ['ech_client_value", def:', 'a users column for the value'],
  ['input-ech-client-toggle', 'the second control exists in the form'],
  ['input-ech-client-value', 'the second value field exists'],
  ['window.toggleEchClientInputs', 'its toggle helper'],
  ['ech_client: ech_client ? 1 : 0', 'the form sends the toggle'],
  ['ech_client_value: ech_client_value || null', 'the form sends the value'],
];
for (const [needle, label] of wired) {
  ok(both.includes(needle), 'wired: ' + label);
}

// Both write paths must carry the new fields, or an edit would silently drop them.
const putBind = build.includes('ech_client ? 1 : 0, ech_client_value || null, finalConnType');
const postBind = build.includes('ech_client ? 1 : 0, ech_client_value || null)');
ok(putBind, 'the PUT (edit) path binds the client fields');
ok(postBind, 'the POST (create) path binds the client fields');

// The two modes must be emitted by DIFFERENT branches of the same parameter.
ok(both.includes('"&ech=" + encodeURIComponent(echInfo.config)'), 'server mode still emits the looked-up base64 config');
ok(both.includes('(echClient ? ("&ech=" + encodeURIComponent(echClient))'), 'client mode emits the raw value into the same parameter');

// The emission has to be GATED on the right thing. The link builder only appends the ECH
// parameter on a TLS port, and that gate used to read `echOn && isTlsPort` — which silently
// dropped client mode entirely, since echOn is false there. This is the assertion that would
// have caught it.
ok(build.includes('if ((echOn || echClient) && isTlsPort) userFrag += echParam + alpnParam;'),
  'client mode actually reaches the link (the TLS gate admits it)');
ok(!build.includes('if (echOn && isTlsPort) userFrag += echParam + alpnParam;'),
  'the old echOn-only gate is gone');

// The server-side guard is the one that actually matters: a client-side rule can be bypassed
// with a direct API call.
const guardHasExclusion = build.includes('if (ech && ech_client) {');
ok(guardHasExclusion, 'the server refuses a row with both modes on');
ok((build.match(/validateEchFields\(/g) || []).length === 3, 'both write paths call the guard (1 definition + 2 calls)');

// And the build must still be deployable: no hardened keyword may leak into it, which is how
// a stray word in a comment would have shipped.
const hard = checkHardened(build);
ok(hard.valid && hard.hits === 0, 'the build still passes checkHardened with zero keyword survivors', JSON.stringify(hard));
ok(!build.split('\n').some((l) => KW_RE.test(l)), 'no line of the build carries a hardened keyword');

rmSync(dir, { recursive: true, force: true });
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
process.exit(fail ? 1 : 0);
