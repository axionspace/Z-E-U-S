// Phase-6 verification: does the ECH feature survive the hardening round-trip?
// Searches BOTH the served bytes (real code: identifiers, non-keyword string literals) and
// the decoded payload table (quasis / keyword-bearing literals), because harden.mjs only
// moves protocol-identifying strings into the table.
import { readFileSync } from 'node:fs';
import { detectPrelude, xorDecode, checkHardened } from '../wizard/zeus-wizard.mjs';

const build = readFileSync(new URL('../Source-hardened.js', import.meta.url), 'utf8');
const det = detectPrelude(build);
let pass = 0, fail = 0;
const ok = (c, l, e) => { console.log((c ? 'PASS | ' : 'FAIL | ') + l + (e ? ' | ' + e : '')); c ? pass++ : fail++; };

ok(det !== null, 'payload table still detected in the regenerated build');
const rows = det.blobs.map((b) => xorDecode(b, det.key));
const plain = rows.join(' ');
const both = build + ' ' + plain;
const where = (needle) => build.includes(needle) ? 'code' : (plain.includes(needle) ? 'table' : 'nowhere');

const checks = [
  ['input-ech-toggle', 'the ECH checkbox id exists'],
  ['input-ech-domain', 'the ECH domain field exists'],
  ['input-alpn', 'the ALPN field exists'],
  ['ech-inputs-container', 'the ECH collapse container exists'],
  ['toggleEchInputs', 'the ECH toggle helper exists'],
  ['ech-opts:', 'Clash ech-opts is emitted'],
  ['query-server-name:', 'Clash query-server-name is emitted'],
  ['fetchEchConfig', 'the ECHConfig fetcher exists'],
  ['resolveEch', 'the per-user ECH resolver exists'],
  ['ECH_DOH_RESOLVERS', 'the DoH fallback list (Google then Cloudflare) exists'],
  ['dns.google/resolve', 'Google DoH is the first resolver'],
  ['cloudflare-dns.com/dns-query', 'Cloudflare DoH is the fallback'],
  ['crypto.cloudflare.com', 'the default ECH domain is embedded'],
  ['ECH_BUILD_CACHE', 'the per-build cache exists'],
  ['const tlsOnly = ports.filter((p) => TLS_PORTS.has(p));', 'ECH forces TLS-only ports'],
  ['{ name: "ech", def: "INTEGER DEFAULT 0" },', 'the ECH column migration exists'],
  ['{ name: "ech_domain", def: "TEXT DEFAULT NULL" },', 'the ECH-domain column migration exists'],
  ['{ name: "alpn", def: "TEXT DEFAULT NULL" },', 'the ALPN column migration exists'],
  ['ALTER TABLE users ADD COLUMN', 'the runtime ALTER TABLE migration is still generated'],
  ['ech_domain = ?, alpn = ?', 'the UPDATE statement carries ech_domain/alpn'],
  ['trojan_hash, enable_direct, ech, ech_domain, alpn) VALUES', 'the INSERT statement carries the new columns'],
  ['&ech=" + encodeURIComponent(echInfo.config', 'the VLESS/Trojan links carry the ech parameter'],
  ['tls: true', 'Clash keeps emitting TLS blocks exactly as before'],
];
for (const [needle, label] of checks) ok(both.includes(needle), label, where(needle));

// the TLS-only rule must exist in EVERY output (plain links, Clash yaml, sing-box JSON)
const tlsRuleCount = (build + plain).split('const tlsOnly = ports.filter((p) => TLS_PORTS.has(p));').length - 1;
ok(tlsRuleCount === 3, 'the TLS-only rule exists in ALL THREE outputs (links + Clash + sing-box)', tlsRuleCount + ' sites');

// the sing-box view must exist and carry the ECH block
for (const needle of ['"/sings/"', 'query_server_name', 'packet_encoding', 'type: "ws"']) {
  ok(both.includes(needle), 'the sing-box output carries ' + JSON.stringify(needle), where(needle));
}
ok(both.includes('generateSingsResponse'), 'the /sings/ route handler exists');

// the form must read the three new fields and send them
for (const needle of ["const ech = isEchOn ? 1 : 0;", "const ech_domain = isEchOn", "const alpn = isEchOn", "ech: ech, ech_domain: ech_domain || null, alpn: alpn || null"]) {
  ok(both.includes(needle), 'form handling carries the new fields', where(needle));
}

// keyword + structural sanity
const KW = ['vless','vmess','trojan','shadowsocks','v2ray','xray','hiddify','clash','sing-box','singbox','flclash','panel-zeus','z-e-u-s','ss://'];
const re = new RegExp(KW.join('|'), 'i');
ok(build.split('\n').filter((l) => re.test(l)).length === 0, 'hardened build has zero keyword survivors');
ok(rows.filter((r) => re.test(r)).length > 0, 'the encoded table still carries the protocol strings it is meant to hide');
ok(checkHardened(build).valid === true, 'checkHardened accepts the regenerated build');
ok(/export\s+default/.test(build), 'the build is still a module with a default export');

// only the forbidden protocol strings must be hidden
for (const needle of ['vless://', 'trojan://', 'ss://']) {
  ok(!build.includes(needle), 'no plaintext leak of the forbidden string "' + needle + '"', where(needle));
}
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) process.exit(1);
