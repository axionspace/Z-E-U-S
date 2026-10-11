// bench-decode.mjs — how much does the XOR string table actually cost at runtime?
// Measures the REAL generated prelude taken from the deployed build: cold decode of all
// rows, warm (cached) reads, and whether any decoder call sits inside the socket-piping
// path that carries user traffic.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { detectPrelude, xorDecode } from '../wizard/zeus-wizard.mjs';

const build = readFileSync(new URL('../Source-hardened.js', import.meta.url), 'utf8');
const upstreamPath = new URL('../analysis/Source.js', import.meta.url);
const upstream = (() => { try { return readFileSync(upstreamPath, 'utf8'); } catch { return null; } })();
const det = detectPrelude(build);
const plain = det.blobs.map((b) => xorDecode(b, det.key));

const plainBytes = Buffer.byteLength(plain.join(''), 'utf8');
const blobBytes = det.blobs.reduce((n, b) => n + b.length, 0);
console.log('rows in table        :', det.blobs.length);
console.log('plaintext bytes      :', plainBytes.toLocaleString(), 'B  (largest row', Math.max(...plain.map((p) => p.length)).toLocaleString(), 'B)');
console.log('encoded bytes in file:', blobBytes.toLocaleString(), 'B');
console.log('script size          :', build.length.toLocaleString(), 'B', upstream ? 'vs upstream ' + upstream.length.toLocaleString() + ' B (+' + (build.length - upstream.length).toLocaleString() + ' B, ' + ((build.length / upstream.length - 1) * 100).toFixed(1) + '%)' : '');

// run the actual generated prelude (its own cache included)
const dir = mkdtempSync(join(tmpdir(), 'zeus-bench-'));
const f = join(dir, 'prelude.mjs');
writeFileSync(f, det.raw + `\nexport const call = (i) => ${det.getName}(i);\nexport const count = () => ${det.blobName}.length;\n`);
const mod = await import(pathToFileURL(f).href);
const order = Array.from({ length: mod.count() }, (_, i) => (i * 37) % mod.count()); // shuffled read order

const t0 = process.hrtime.bigint();
for (const i of order) mod.call(i);
const cold = Number(process.hrtime.bigint() - t0) / 1e6;

const t1 = process.hrtime.bigint();
for (let n = 0; n < 1000; n++) for (const i of order) mod.call(i);
const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;
const warmPerCall = warmMs / (1000 * order.length);

console.log('\nfull table decode    :', cold.toFixed(3), 'ms  (one time per isolate, all', det.blobs.length, 'rows)');
console.log('cached read          :', (warmPerCall * 1e6).toFixed(1), 'ns per call after the first use');
console.log('per-request view     : the panel resolves', det.blobs.length, 'rows once ≈', cold.toFixed(2), 'ms of CPU at cold start');

// is the decoder in the traffic path?
const socketHits = [];
for (const token of ['cloudflare:sockets', '.connect(', 'reader.read()', 'writer.write(', 'getReader()', 'getWriter()']) {
  let i = -1;
  while ((i = build.indexOf(token, i + 1)) !== -1) {
    const win = build.slice(Math.max(0, i - 1500), i + 1500);
    const calls = (win.match(new RegExp('(?<![\\w$])' + det.getName + '\\(', 'g')) || []).length;
    socketHits.push({ token, at: i, callsWithin1_5KB: calls });
  }
}
const byToken = {};
for (const h of socketHits) (byToken[h.token] = byToken[h.token] || { n: 0, max: 0 }).n++ , byToken[h.token].max = Math.max(byToken[h.token].max, h.callsWithin1_5KB);
console.log('\ndecoder calls near socket plumbing (±1.5KB window, real numbers from the deployed file):');
for (const [t, v] of Object.entries(byToken)) console.log(' ', t.padEnd(18), 'sites:', String(v.n).padStart(3), '| max decoder calls within ±1.5KB:', v.max);

// where the calls actually are: what do the surrounding lines look like?
const samples = [];
let k = -1;
while ((k = build.indexOf(det.getName + '(', k + 1)) !== -1) {
  const line = build.slice(build.lastIndexOf('\n', k) + 1, build.indexOf('\n', k));
  samples.push(line.trim().slice(0, 110));
}
console.log('\ntotal decoder call sites:', samples.length);
console.log('example lines that use them:');
for (const s of [...new Set(samples)].slice(0, 8)) console.log('  ', s);
rmSync(dir, { recursive: true, force: true });
