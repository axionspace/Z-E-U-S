// build-artifact.mjs — rebuild the OTA artifact (zeus.obfuscated.js) from Source.js.
//
// The panel's in-panel update button no longer deploys anything (it only reports whether a
// newer source exists and points at the wizard, because the per-install build identity is
// minted locally and cannot be reproduced inside the worker). The artifact is still the
// release asset other channels expect, so this rebuilds it with the same chain the existing
// file used:
//
//   1. drop the `cloudflare:sockets` import and turn `export default {` into a captured
//      object returned from the function body;
//   2. XOR the whole body with a random 32-byte key and base64 it;
//   3. emit a loader that decodes the blob and runs it through `new Function("connect", …)`.
//
// The key bytes are emitted as small sums ("(a+b)") rather than literals, so the key does
// not sit in the artifact as a readable byte array, and the wrapper carries the visible
// CURRENT_VERSION / UPDATE_FIX strings the old artifact had.
//
// Usage: node tools/build-artifact.mjs [source] [output]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'Source.js');
const OUT = process.argv[3] ? resolve(process.argv[3]) : join(ROOT, 'zeus.obfuscated.js');
const VERSION = existsSync(join(ROOT, 'version.txt')) ? readFileSync(join(ROOT, 'version.txt'), 'utf8').trim() : '0.0.0';

let code = readFileSync(SRC, 'utf8');
const importRe = /^\s*import\s*\{[^}]*\}\s*from\s*["']cloudflare:sockets["'];?\s*/;
if (!importRe.test(code)) throw new Error('the cloudflare:sockets import was not found at the top of ' + SRC);
code = code.replace(importRe, '');
if (!/export\s+default\s*\{/.test(code)) throw new Error('export default was not found');
code = code.replace(/export\s+default\s*\{/, 'const __WORKER_EXPORT__ = {') + '\nreturn __WORKER_EXPORT__;';

// Compile the inner body now: a syntax error here would only surface in production otherwise.
try { new Function('connect', code); } catch (e) { throw new Error('the inner module does not compile: ' + e.message); }

const key = randomBytes(32);
const bytes = Buffer.from(code, 'utf8');
const xored = Buffer.alloc(bytes.length);
for (let i = 0; i < bytes.length; i++) xored[i] = bytes[i] ^ key[i % key.length];
const blob = xored.toString('base64');

// key bytes as "(a+b)" sums: same value, no readable byte array
const keyExpr = Array.from(key).map((b) => {
  const a = Math.floor(Math.random() * (b + 1));
  return '(' + a + '+' + (b - a) + ')';
}).join(',');

const out = `import { connect } from "cloudflare:sockets";
const CURRENT_VERSION = '${VERSION}';
const UPDATE_FIX = "constsCURRENT_VERSION='d.d.d'";
const _k = new Uint8Array([${keyExpr}]);
const _d = atob("${blob}");
const _b = new Uint8Array(_d.length);
for (let i = 0; i < _d.length; i++) _b[i] = _d.charCodeAt(i) ^ _k[i % _k.length];
const _w = new Function("connect", new TextDecoder().decode(_b))(connect);
export default _w;
`;

writeFileSync(OUT, out);
console.log('source  :', SRC, '(' + code.length + ' chars inner body)');
console.log('artifact:', OUT, '(' + out.length + ' chars, key ' + key.length + ' bytes, version ' + VERSION + ')');
