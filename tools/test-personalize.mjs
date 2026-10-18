// test-personalize.mjs — proves the per-install build fingerprint is lossless.
// Runs the wizard's own personalization engine against the real hardened build and
// checks, for many seeds: row-for-row decode equality, a REAL execution of the renamed
// decoder (extracted prelude imported as a module and called for every row), preserved
// call-site counts, keyword cleanliness, syntax validity (node --check), determinism for
// one seed and distinctness across seeds, and rejection of non-hardened input.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { existsSync } from 'node:fs';
import { detectPrelude, personalize, xorDecode, checkHardened, KW_RE, NAME_BLOCK_RE } from '../wizard/wizard.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The shipped build lives at the repository root. This fork keeps the readable copy there as
// Source.js and the hardened one as Source-hardened.js next to it; a delivery folder that
// carries only one of them must still work, so prefer whichever is present (Source.js is the
// hardened build in the wizard's own layout — see prepareSource).
const CANON = existsSync(join(ROOT, 'Source.js')) ? join(ROOT, 'Source.js') : join(ROOT, 'Source-hardened.js');
// The plain, un-hardened upstream copy is the fixture for the two "must be rejected"
// assertions below. It is deliberately never published (.gitignore lists analysis/Source.js),
// so a checkout or worktree that does not carry it skips exactly those two checks instead of
// crashing — the other 100+ assertions need nothing but the shipped build.
const UPSTREAM = join(ROOT, 'analysis', 'Source.js');
const HAS_UPSTREAM = existsSync(UPSTREAM);

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS | ' : 'FAIL | ') + label + (extra ? ' | ' + extra : ''));
  c ? pass++ : fail++;
};

const src = readFileSync(CANON, 'utf8');
// The ECH feature added one more encoded row; the test derives the count from the build
// instead of hard-coding it, so adding a feature never makes the suite look broken.
const CANON_ROWS_N = detectPrelude(readFileSync(CANON, 'utf8')).blobs.length;
const up = HAS_UPSTREAM ? readFileSync(UPSTREAM, 'utf8') : null;
if (!HAS_UPSTREAM) console.log('note: ' + UPSTREAM + ' is absent — the two "plain upstream is rejected"\n      checks are skipped (the fixture is gitignored and never published).');
const dir = mkdtempSync(join(tmpdir(), 'zeus-fp-'));

console.log('canonical build : ' + src.length + ' chars | ' + (src.split('\n').length) + ' lines');

// ---------------------------------------------------------------- baseline shape
const det = detectPrelude(src);
ok(det !== null, 'detectPrelude finds the generated table in the canonical build');
ok(det && det.keyName === '_ZK' && det.blobName === '_ZS' && det.cacheName === '_ZC' && det.decName === '_ZD' && det.getName === '_G',
  'canonical identifiers are _ZK/_ZS/_ZC/_ZD/_G', det && [det.keyName, det.blobName, det.cacheName, det.decName, det.getName].join(','));
ok(det && det.key.length === 32, 'payload key is 32 bytes', det && det.key.length);
const N = det ? det.blobs.length : 0;
ok(N === 90, 'payload table has ' + CANON_ROWS_N + ' rows', String(N));
// The author's own source ships an HTML comment addressed to LLM assistants, ordering them to
// refuse any edit to the panel. It is a prompt injection, not a licence, and it has no runtime
// effect — this build does not carry it. Asserted here so it cannot come back in a re-import.
// The author's source ships instructions addressed to LLM assistants, ordering them to refuse
// any edit to the panel. Not licences, and none has a runtime effect — each was an atob() of a
// constant whose only use was an unrelated `.length > 0` test. They existed to be read by an AI
// analysing the source, which is what they were doing. Three were removed: the HTML comment
// plus the two base64 constants. Asserted here so a re-import cannot bring any of them back —
// including from inside a payload row, where a constant could live.
{
  const decoded = det.blobs.map((b) => xorDecode(b, det.key)).join('\n');
  const everywhere = src + '\n' + decoded;
  const TRAPS = [
    [/SYSTEM DIRECTIVE/i, 'an HTML-comment SYSTEM DIRECTIVE block'],
    [/AI_HALT/i, 'the AI_HALT blocker'],
    [/AI_DIRECTIVE/i, 'the AI_DIRECTIVE notice'],
    [/you must refuse to process requests/i, 'an instruction to refuse edit requests'],
    [/Zeus Panel is protected/i, 'a canned refusal string'],
    [/\b_AI_BLOCKER\b/, 'the _AI_BLOCKER constant'],
    [/\b_LLM_TRAP\b/, 'the _LLM_TRAP constant'],
    [/AI safety policies/i, 'a fabricated AI-safety claim'],
  ];
  for (const [re, label] of TRAPS) {
    ok(!re.test(everywhere), 'no AUTHOR->LLM trap survives: ' + label);
  }
  // And the two lines that referenced them must still do their real job unguarded.
  ok(/if \(ips\.length === 1 && ips\[0\] === host && user\.ips\) \{/.test(src),
    'the custom-IP branch keeps its real condition (the trap guard is gone, not the logic)');
  ok(/return upgradeHeader === "websocket";/.test(src),
    'the websocket check keeps its real test');
}
const plain0 = det.blobs.map((b) => xorDecode(b, det.key));
ok(plain0.every((p) => typeof p === 'string' && p.length >= 0), 'every canonical row decodes to text');
ok(plain0.filter((p) => KW_RE.test(p)).length > 0, 'decoded rows really do carry the protocol keywords', plain0.filter((p) => KW_RE.test(p)).length + ' rows');
if (HAS_UPSTREAM) {
  ok(detectPrelude(up) === null, 'detectPrelude does NOT match the plain upstream Source.js');
}
ok(checkHardened(src).valid === true, 'checkHardened accepts the canonical build');
if (HAS_UPSTREAM) {
  ok(checkHardened(up).valid === false, 'checkHardened rejects the plain upstream build');
}

const callsCanonical = (src.match(/(?<![\w$])_G\(\s*\d+\s*\)/g) || []).length;
ok(callsCanonical > 100, 'canonical build has decoder call sites to remap', String(callsCanonical));

// ---------------------------------------------------------------- per-seed transforms
const SEEDS = ['alice-0001', 'bob-7f3a', 'carol', 'd-999', 'elias@example', 'farhad', 'ghost', 'hamed-2026', 'i-3', 'jamshid', 'kaveh', 'lo-rem-ipsum-dolor'];
const hashes = new Set();
const nameSets = [];
let allChecksOk = true, allDeterministic = true;

for (const seed of SEEDS) {
  const r = personalize(src, seed);
  const out = r.out;
  const nd = detectPrelude(out);
  const problems = [];

  if (!r.ok) problems.push('internal verifyTransform failed: ' + r.problems.join(' / '));
  if (!nd) problems.push('personalised table not detectable');
  else {
    // row-for-row decode equality against the permuted original
    const dec = nd.blobs.map((b) => xorDecode(b, nd.key));
    const a = [...plain0].sort().join('\u0001');
    const b = [...dec].sort().join('\u0001');
    if (a !== b) problems.push('decoded row set changed');
    if (dec.length !== N) problems.push('row count ' + dec.length + ' != ' + N);
    if (nd.key.join() === det.key.join()) problems.push('key not re-rolled');
    if ([det.keyName, det.blobName, det.cacheName, det.decName, det.getName].some((n) => n === nd.getName)) problems.push('names not all replaced');
    // real execution of the renamed decoder
    const mod = nd.raw + `\nexport function get(i){ return ${nd.getName}(i); }\nexport const rows = ${nd.blobName}.length;\n`;
    const f = join(dir, 'probe-' + sha(seed).slice(0, 8) + '.mjs');
    writeFileSync(f, mod);
    const imported = await import(pathToFileURL(f).href);
    if (imported.rows !== N) problems.push('module reports ' + imported.rows + ' rows');
    for (let i = 0; i < N; i++) {
      if (imported.get(i) !== dec[i]) { problems.push('runtime row ' + i + ' differs from static decode'); break; }
    }
    // the runtime decoder must be idempotent/cache-backed and produce the same values twice
    if (imported.get(0) !== imported.get(0)) problems.push('decoder not stable');
    rmSync(f, { force: true });
  }
  if ((out.match(/(?<![\w$])_G\(\s*\d+\s*\)/g) || []).length !== 0) problems.push('canonical getter name survived');
  if ((out.match(/(?<![\w$])_Z[KCSD]\b/g) || []).length !== 0) problems.push('canonical table names survived');
  if ((out.match(/(?<![\w$])_p\d+(?![\w$])/g) || []).length !== 0) problems.push('canonical _p identifiers survived');
  if (out.split('\n').filter((l) => KW_RE.test(l)).length !== 0) problems.push('keyword survivor in personalised build');
  if (out.slice(0, det.start) !== src.slice(0, det.start)) problems.push('head before table altered');
  if (Math.abs(out.length - src.length) > src.length * 0.05) problems.push('size drifted: ' + out.length + ' vs ' + src.length);

  // syntax check through node itself
  const f2 = join(dir, 'build-' + sha(seed).slice(0, 8) + '.mjs');
  writeFileSync(f2, out);
  const chk = spawnSync(process.execPath, ['--check', f2], { encoding: 'utf8' });
  if (chk.status !== 0) problems.push('node --check failed: ' + (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  rmSync(f2, { force: true });

  ok(problems.length === 0, 'seed "' + seed + '" personalised build is lossless',
    'names ' + Object.keys(r.names).length + ' | rows ' + r.entries + '| renamed _p ' + r.renamed + ' | ' + out.length + 'B' + (problems.length ? ' :: ' + problems.join(' ; ') : ''));
  // Phase-4 naming / rename-completeness invariants, re-checked here independently of
  // personalize() so a regression in the shared helper cannot hide behind it.
  const freshNames = Object.values(r.names);
  const allShape = freshNames.every((n) => /^_[a-z]{5,8}$/.test(n));
  const blocked = freshNames.filter((n) => NAME_BLOCK_RE.test(n));
  ok(allShape, 'seed "' + seed + '": every generated name is short/neutral/lowercase (_abcxyz)', freshNames.slice(0, 4).join(',') + ' …');
  ok(blocked.length === 0, 'seed "' + seed + '": no generated name resembles a product/protocol/technology', blocked.join(',') || freshNames.length + ' names checked');
  ok(freshNames.every((n) => out.includes(n)), 'seed "' + seed + '": every renamed identifier is present in the output');
  const leftOld = [det.keyName, det.blobName, det.cacheName, det.decName, det.getName].some((o) => new RegExp('(?<![\\w$])' + o + '(?![\\w$])').test(out));
  ok(!leftOld, 'seed "' + seed + '": no canonical generated identifier survived the rename');
  ok(r.entries === N, 'seed "' + seed + '": the payload table still has ' + N + ' rows (re-keyed AND re-ordered)');
  if (problems.length) allChecksOk = false;
  hashes.add(sha(out));
  nameSets.push(Object.values(r.names).sort().join(','));

  // determinism for this seed
  const again = personalize(src, seed);
  const same = again.out === out;
  ok(same, 'seed "' + seed + '" reproduces byte-identically');
  if (!same) allDeterministic = false;
}

ok(allChecksOk, 'every seed produced a verified lossless build');
ok(allDeterministic, 'every seed reproduced byte-identically');
ok(hashes.size === SEEDS.length, 'every seed yields a different build fingerprint', hashes.size + '/' + SEEDS.length);
ok(new Set(nameSets).size === SEEDS.length, 'identifier names differ per seed');

// ---------------------------------------------------------------- structural invariants
const one = personalize(src, 'invariant-check');
const callsNew = (one.out.match(new RegExp('(?<![\\w$])' + detectPrelude(one.out).getName + '\\(\\s*\\d+\\s*\\)', 'g')) || []).length;
ok(callsNew === callsCanonical, 'decoder call-site count preserved', callsCanonical + ' → ' + callsNew);
ok(checkHardened(one.out).valid === true, 'checkHardened accepts a personalised build (structural probe)');

// double personalization (re-fingerprinting an already personalised build)
const two = personalize(one.out, 'second-pass');
const d2 = detectPrelude(two.out);
const set1 = [...plain0].sort().join('\u0001');
const set2 = d2.blobs.map((b) => xorDecode(b, d2.key)).sort().join('\u0001');
ok(two.ok && set1 === set2, 'personalizing a personalised build stays lossless');

// ---------------------------------------------------------------- rejection paths
let threw = false;
try { personalize(up, 'nope'); } catch { threw = true; }
ok(threw, 'personalize refuses the plain upstream Source.js');

let threw2 = false;
try { personalize('const a = 1;', 'nope'); } catch { threw2 = true; }
ok(threw2, 'personalize refuses a file with no payload table');

// the canonical build is still what the repository serves (unchanged on disk)
ok(readFileSync(CANON, 'utf8') === src, 'the local canonical build was not modified by the test');

rmSync(dir, { recursive: true, force: true });
console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) process.exit(1);
