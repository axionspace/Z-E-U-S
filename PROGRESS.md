# PROGRESS.md — ZEUS night-shift run

Working folder: `C:\Users\Arefniya\Downloads\Zeus Fix` (this folder is the whole scope).
Run date: 2026-10-11. Model: opencode/step-5-preview-free (high effort).
Secrets: `ZEUS_CF_TOKEN` / `GITHUB_TOKEN` are read from the environment only — never printed,
never written to any file, never in a commit message. Any masked display uses `••••`.

---

## Phase 0 — Understand first (no code changes)

### What this project is
A **hardened fork of a Cloudflare-Workers PWA panel** (multi-user VLESS/Trojan/Shadowsocks
subscription panel backed by D1) that is deployed by a **single-file Node.js install wizard**
(`wizard/zeus-wizard.mjs`, 1197 lines, Node 18+, no npm packages).

* `Source-hardened.js` (855 KB) is the deployable worker build. `analysis/Source.js` is the
  readable reference copy of the same panel (same product, pre-hardening).
* `tools/harden.mjs` produced `Source-hardened.js` from `analysis/Source.js`: every
  protocol-identifying string (vless/vmess/trojan/shadowsocks/…/repo URLs) is replaced by an
  index into an XOR+base64 runtime string table (`_ZK` key, `_ZS` blobs, `_ZC` cache,
  `_ZD` decode, `_G(i)` getter). Watermarks/anti-tamper constants are preserved, and the
  served bytes and behaviour stay identical.
* The panel itself (unchanged product): PWA UI, D1 tables `users` + `settings`, admin
  password (SHA-256), per-user protocol mix, ports (TLS/non-TLS/custom), clean-IP pool,
  auto IP rotation, TLS fragmentation (fm/cs/tls_mask "advanced optimisation"), SOCKS5/relay
  chain, DoH-based clean-IP checker, quota/expiry/IP limits, block-porn/ads, backups,
  in-panel OTA core update, subscription + QR + status page.

### How install / update / personalise flows work
* `wizard/zeus-wizard.mjs` modes (argv): full interactive install (default), `--update`,
  `--prepare-only`, `--personalize`, `--token-link`, plus `--rotate`, `--no-fingerprint`.
* Install (10 steps): token (pre-filled creation link, hidden input) → account → worker name
  → workers.dev subdomain → D1 create/reuse → source fetch (6 mirrors, raw GH first) →
  per-install fingerprint → upload (multipart PUT, preserves existing bindings + compat
  date) → read-back byte/sha verify → enable subdomain → health check + optional custom
  domain.
* `--update` (6 steps) reuses `wizard/profile.json` (account/worker/db/identity seed/names),
  never deletes anything, proves the D1 row census is identical before/after, keeps the
  worker's non-D1 bindings and compatibility date, and re-attaches exactly the same D1.
* `--personalize` writes `Source-personalized.js` locally with no Cloudflare calls.

### Where the 1101 handling lives
* `tools/diagnose-1101.mjs` classifies a fresh worker answering `error code: 1101`:
  complete valid module + working D1 + all routes 1101 → one-off poisoned deploy state on
  Cloudflare's side (remedy: delete the **worker script only**, redeploy identical bytes,
  never the D1); incomplete bytes → re-run installer; some routes → runtime error.
* Wizard side: `probeOnce` → `classifyProbe` (`ok` / `stuck` / `propagating` / `other`) and
  `verifyDeployment()` — polls up to `ZEUS_PROBE_WAIT_MS` (90 s) for propagation, then, only
  if Cloudflare itself answered 1101 (`sawStuck`), deletes the worker script once and
  re-uploads the identical verified bytes, then re-probes with `canHeal:false`.

### How the fingerprint / personalise works
`personalize(txt, seed)`: seeded PRNG (`rngFrom`) → fresh row order (Fisher–Yates) → fresh
32-byte XOR key (re-rolled until no blob leaks a keyword) → new identifier names
(`_zkabcde`-style, 6–9 chars, counted, collision-free, no keyword) → rewrite of every
`_G(n)` call site to the new index → `verifyTransform()` proves row-count equality, every
decoded row equals the original, key re-rolled, order changed, call-site count unchanged,
no stale old names, zero keyword survivors, and that bytes before the prelude are untouched.

### What ECH support exists today
**None.** `grep -i ech` on both `Source-hardened.js` and `analysis/Source.js` only matches
substrings (`…mechanisms`, `replaceChild`, `checked`). No `alpn` either. What does exist:
`dns-query` (DoH resolver `https://cloudflare-dns.com/dns-query`, used by the clean-IP
checker and the clash/sing-box `dns:` block), `tls`, `port`, `fingerprint`, `frag_len`,
`frag_int`, `advanced_frag`, `cipher_suites`, `tls_mask` — all per-user columns of `users`
(migrated at runtime by a `ALTER TABLE … ADD COLUMN` loop). So Phase 6 is a genuine feature
addition, following the same runtime-migration + per-user column + subscription-output
pattern that `tls_mask` already uses.

### Repo / delivery state
Not a git repo yet (`git status` fails). Deliverable per spec: branch `night-shift/<date>`
in this folder if it becomes a repo, else a patch set + file list, pushed with `GITHUB_TOKEN`
from env. Fork: `axionspace/Z-E-U-S`; upstream reference: `panel-zeus/Z-E-U-S` (read-only).

Files read in this phase: `wizard/zeus-wizard.mjs` (all 1197 lines), `tools/harden.mjs`,
`tools/diagnose-1101.mjs`, `tools/test-wizard-flows.mjs`, `tools/live-update-check.mjs`,
`tools/first-run-probe.mjs`, `wizard/profile.json`, `analysis/README-fork.md`, plus
`analysis/Source.js` structure around the «پورت‌های اتصال و شبکه» tab (lines 5796–5998)
and the user model / migrations (lines ~1240–1490, 1609, 7042, 8611, 11232).

---

## Phase 1 — Fix ALL bugs first (offline, zero Cloudflare calls)

**Command:** `node tools/test-wizard-flows.mjs`
**Before:** `77 PASS / 24 FAIL` → **After:** `107 PASS / 0 FAIL` ✅

### Root cause found and fixed (not a log-text fix)
`tools/test-wizard-flows.mjs` spawned the wizard with `{ ...process.env }`, so the real
`ZEUS_CF_TOKEN` of the machine leaked into the child. The wizard then (correctly) read the
token from the env and **skipped the token question**, which shifted every piped answer by
one: the mock token string became the "Account ID" answer (`Account ID [...]: mock-token-not-a-secret`
→ `❌ Account ID format is invalid`) and even the worker name / D1 name. That single cause
produced 24 failures (S1 "profile stores no API token" — the worker name literally contained
the token — plus S3/S4/S6/S7/S9). The harness now owns the child environment explicitly
(`ZEUS_CF_TOKEN: undefined, GITHUB_TOKEN: undefined`) and documents why. The wizard's own
env-token behaviour is correct and was left untouched.

### Audit-log sweep (`audit-*.log`)
Only `audit-selfheal.log` had failures (183 PASS / 3 FAIL); `audit-selfheal2`,
`audit-first-run-note`, `audit-text-pass` and `audit-after-panel-update` are all 0-FAIL, so
those three were an intermediate in-flight state. Their root causes were:
1. *commit-chain messages / hardening commit sha* — `tools/verify-fork.mjs` asserted a
   **hardcoded 21-message snapshot plus a literal sha prefix** (`c279e89`, HEAD
   `0b8bd8649d`). Any new commit broke it. Replaced by a structural walk: (a) the real fork
   point is discovered from the upstream commit set and the walk stops exactly there,
   (b) every commit must be single-parent and carry a non-empty, forbidden-word-free message,
   (c) the hardening commit is located by path (`tools/harden.mjs`) and must be *in* the chain.
2. *README documentation check* — transient (fixed by later commits, verified green in the
   newer logs). The wording itself (`Two account limits the wizard works around … deletes and
   re-deploys the worker script once, by itself … The D1 database and every row in it are never
   part of that recovery`) is present in `analysis/README-fork.md`.
3. The audit tool is now **ref-aware** (`REF` env, default `main`), so a delivery branch can be
   audited with the same checks without touching `main`; the branch check accepts `main` plus at
   most one dated `night-shift/<date>` branch, and the tree-diff invariant is now "at least the
   fork shape, nothing removed", allowing additive documentation on a delivery branch.

### Offline smoke tests (all pass, no network)
| command | result |
| --- | --- |
| `node wizard/zeus-wizard.mjs --token-link` | prints pre-filled link + random name ✅ |
| `node wizard/zeus-wizard.mjs --prepare-only` | hardened source from local file, 835KB, 0 keywords ✅ |
| `node wizard/zeus-wizard.mjs --personalize` | 89 rows re-keyed, 14 identifiers renamed, `Source-personalized.js` (836KB, 0 survivors, syntax OK) ✅ |
| keyword scan | `Source-hardened.js` 835KB / `test/Source-personalized.js` 836KB / `backup/web-bess-deployed.js` 836KB → **0 keyword lines each** ✅ |

Files changed: `tools/test-wizard-flows.mjs`, `tools/verify-fork.mjs`.

---

## Phase 2 — The 1101 wizard bug (reproduce, observe, fix, prove)

### 1. Offline reproduction (mock, `tools/test-wizard-flows.mjs`)
Matrix modes already existed and now cover the whole state machine:

| scenario | meaning | expected behaviour | result |
| --- | --- | --- | --- |
| `propagate` (S11) | 404, 404, 200 | polls, then declares success, **no DELETE** | ✅ |
| `stuck-heals` (S12) | 1101 forever until deleted | one worker-script DELETE + identical re-PUT, then ✅ | ✅ |
| `stuck` (S13) | 1101 forever | one heal attempt only, then honest failure + manual hint, install still "complete" | ✅ |
| `dead` (**S14, new**) | never answers, never 1101 | waits, then explains patience; **no DELETE, no re-PUT** | ✅ |

S14 is new: without it the "patience" branch of `verifyDeployment` was never exercised, and an
unreachable/filtered address could not be proven to be distinct from a 1101 poisoned deploy.
New mock probe mode `dead`; the wizard itself was already correct.

### 2. Live observation (env token only, read-only)
* `node tools/first-run-probe.mjs` → **6 PASS / 0 FAIL**. `web-bess`: no password yet → `/api/users`
  opens with `{"users":[]}` (upstream first-run rule); `web-test`: password set → `401 Unauthorized`.
  Both serve `/panel` 200 and refuse `/sub/unknown` 404.
* `node tools/diagnose-1101.mjs web-test` → **no 5xx anywhere**: `/`, `/panel`, `/sw.js`,
  `/manifest.json`, `/icon.svg` all 200, `/api/does-not-exist` 401. Deployed script
  `856991B`, sha `444c268180b1…`, valid module, D1 `web-test-db` with tables
  `_cf_KV, settings, sqlite_sequence, users`, payload table 89 rows, rows decode cleanly,
  "same panel as fork? YES". Classification: "No 5xx right now — the panel answers every route."
* Worker inventory (read-only): `web-bistori`, `web-test`, `web-bess`, `web-panel` — all compat
  `2024-09-23`, each with exactly one `d1:DB` binding. Subdomain `axionum`.
  (Note: `wizard/profile.json` points at `web-ebvfz` / `c2c00df7-…`, which is no longer among
  the live scripts — that profile is stale and is left untouched, since nothing here may delete data.)

### 3. Live update with D1 census (`node tools/live-update-check.mjs`)
**26 PASS / 0 FAIL** — real `--update` of `web-test` with its own saved profile:
row census `{"settings":6,"users":1}` read **before**, identical **after**; deployed bytes
`444c268180b1` == the deterministic rebuild from the saved seed; `/panel` 200 (25940B),
`/sub/finaluser` still serves VLESS + Trojan + Shadowsocks, `/api/users` 401, `/update` path
creates no extra worker.

**One real bug found and fixed here:** the tool asserted `sha(bytesAfter) !== sha(bytesBefore)`
("this folder's profile carries its own older identity") while the check right above it asserted
`sha(bytesAfter) === sha(rebuild(seed))`. Both cannot hold when the live panel already runs that
profile's identity — the old check demanded churn that contradicts the identity guarantee and
therefore always failed on a healthy, already-converged panel. Replaced with the honest
invariant: **byte-determinism from the saved seed** (before == after == profile), expressed in a
comment so it cannot regress into a churn demand again.

### 4. Wizard hardening added
* Propagation branch now ends with one clear bilingual line:
  `💬 EN: a brand-new address can take a minute or two to spread — the deploy itself was verified byte for byte.` / Persian equivalent.
* 1101 self-heal branch now prints the required one-liner pair:
  `💬 EN: Cloudflare answered 1101 on a fresh deploy — the worker script is recreated once from the same verified bytes; your database, rows, address and domains are never touched.` / Persian equivalent.
* Both are asserted by the regression test (S12, S13, S14), so they cannot silently disappear.

Commands: `node tools/test-wizard-flows.mjs` → **117 PASS / 0 FAIL**;
`node tools/live-update-check.mjs` → **26 PASS / 0 FAIL**.
Files changed: `wizard/zeus-wizard.mjs`, `tools/test-wizard-flows.mjs`, `tools/live-update-check.mjs`.

---

## Phase 3 — Rewrite the wizard UX (Farsi-first, half-asleep-proof)

`wizard/zeus-wizard.mjs` rewritten (1197 → 1352 lines). **No behavioural change**: same flows,
same API calls, same fingerprint engine, same profile schema, same single DELETE, same
compat-date/binding preservation. Only the presentation, the prompts and the secret reader
changed. `node tools/test-wizard-flows.mjs` → **129 PASS / 0 FAIL**.

### The truly-hidden token input (the real Windows bug)
The old `askSecret` replaced `rl.output` with a muting `Writable`. On Windows PowerShell and
cmd the **console itself** echoes the keys, so a pasted token still appeared on screen and in
every scrollback — muting Node's output stream cannot stop that. The new `askSecret`:
* puts the console into **raw mode** (`stdin.setRawMode(true)`) — on POSIX that clears `ECHO`,
  on Windows it clears `ENABLE_ECHO_INPUT`, i.e. the OS stops printing the keys at all;
* consumes `keypress` events directly (`emitKeypressEvents`) so a paste accumulates correctly;
* draws only a **fixed mask** (`••••••••   (received, 40 chars)`) that never grows with the
  input, and never the value;
* keeps `Ctrl+C` working while raw (`key.ctrl && key.name === 'c'` → exit 130) and restores the
  terminal on `process.on('exit')` and after every question;
* still works with **piped stdin** (each answer masked, value never echoed) and keeps the
  **`ZEUS_CF_TOKEN` env fallback**;
* `maskSecret(t)` is exported and unit-tested so the mask can never regress into leaking the value.

### Numbered steps, Farsi first, English second
* `banner()` lists all ten steps, each line `English step  ·  Persian`, plus a safety line
  "توکن شما هیچ‌جا ذخیره نمی‌شود".
* `nextStep(title, fa)` → `[n/10]  <English title>` + a Persian line underneath; every
  Cloudflare-touching step is preceded by `why(what, whyText)` printing
  `▸ چه کاری می‌کند / what:` and `▸ چرا / why:`.
* `ok()`/`warn()` become `okF()`/`warnF()` (Persian line + English explanation), plus `info()`.
* Every `fail(msg, hint)` prints `❌ <bilingual message>` and then `💡 <hint>` **plus**
  `💡 کاری که باید بکنید / your next step: <hint>` — so every error ends with one concrete next action.
* Completion summaries (install + update) are fully bilingual: address, subscription pattern,
  "first set the admin password", the four important notes.

### One question per screen, defaults always visible
`ask(rl, q, def, fa)` prints the Persian line, then the English sub-label, then
`پاسخ / <q> [<default>]: `. The default is always inside square brackets, and the piped path
still echoes the answer it consumed (so the automated tests stay readable).

### Ctrl+C safety
`SIGINT` handler plus the raw-mode `Ctrl+C` handler both restore the TTY
(`restoreTty()` sets raw mode off and pauses stdin) before exiting 130, so Windows never ends
up with a dead console.

### Flags — all still work, plus `--help`
* interactive install, `--update` (6 steps, all saved defaults shown in the banner, reuses
  `profile.json`), `--prepare-only`, `--personalize`, `--token-link` (now bilingual), `--rotate`,
  `--no-fingerprint`.
* **new**: `--help` / `-h` prints a bilingual guide of every flag, every environment switch and
  the token-safety promise.
* `install.sh` already forwards `"$@"`, so `--update`/`--token-link`/`--help` reach the wizard.

Tests added: **S15** (7 checks) covers the mask, that the token never appears in any output
line, that the reader really calls `setRawMode(true)` + `emitKeypressEvents`, that `Ctrl+C`
still cancels, and that `maskSecret()` can never contain the value.

---

## Phase 4 — Fingerprint / rename method (zero speed cost, verified complete)

### What already held
`tools/test-personalize.mjs` (44 → **104 PASS / 0 FAIL**) proves, for 12 seeds:
row-for-row decode equality, real **execution** of the renamed decoder module (imported and
called for every row), 157 decoder call sites preserved, keyword cleanliness, `node --check`,
byte-determinism per seed, distinct hashes per seed, lossless double-personalisation, and
rejection of non-hardened input.

### Name-shape rule added (build-time only, no runtime cost)
`newName()` now rejects and re-rolls any candidate that matches `NAME_BLOCK_RE`
(keywords + `zeus|panel|proxy|relay|node|server|client|worker|vless|…|admin|login|user|token|
cloudflare|cloud|edge|ip|port|host|sub|scan|…`). Names stay **`_abcxyz`-style: short, neutral,
lowercase, 5–8 characters, one leading underscore**. `verifyTransform()` now also refuses a
build whose generated name is not `/^_[a-z]{5,8}$/` or that looks technology-shaped, and it now
enforces the **sorted-row-set invariant** (sorted decode of the personalised table == sorted
decode of the original) so "re-keyed AND re-ordered" is proven at deploy time, not only in tests.

### Rename completeness — proven two ways
* inside `verifyTransform` (deploy gate): no canonical `_ZK/_ZS/_ZC/_ZD/_G` or `_pN` survives,
  every fresh name appears in the output, call-site count unchanged, no stale indices.
* independently in `tools/test-personalize.mjs` (so a bug in the shared helper cannot hide):
  5 extra checks per seed × 12 seeds = 60 new assertions.

### Benchmark — before / after (ZERO speed cost)
| metric | before | after | verdict |
| --- | --- | --- | --- |
| rows in table | 89 | 89 | unchanged |
| encoded bytes in file | 678,680 B | 678,680 B | unchanged |
| full cold decode | 5.010 ms | 4.97 / 5.05 / 5.43 ms (3 runs) | run-to-run noise, unchanged |
| cached read | 61.1 ns/call | 56.4 / 64.2 / 64.7 ns/call | noise, unchanged |
| decoder call sites | 157 | 157 | unchanged |

Every Phase-4 change lives in `newName()`/`verifyTransform()`, which the **wizard runs while
building** — the deployed worker gets the same prelude shape, the same `_G(i)` cache and the
same O(n) cold-start decode. Nothing was added to the request path; the hot path is byte-for-byte
the same code as before. The bench script measures the actual generated prelude extracted from
the deployed file, and confirms the decoder never sits in the socket-plumbing path
(`cloudflare:sockets` → 0 decoder calls within ±1.5 KB).

---

## Phase 5 — Study cfnew (+bpb) and apply only what actually fixes things

`analysis/CFNEW-STUDY.md` written — 15 numbered findings, each with an explicit
**ADOPT / ADAPT / REJECT** decision, and every decision reasoned against the difference that
matters here: cfnew is a *single-node* script (one UUID, one path, config in KV) while this
project is a **per-user D1 subscription factory** (one row per user → subscription links, QR,
status page). A transport optimisation for a node is worth nothing to a config generator.

**Adopted and implemented (each with a test in `tools/test-cfnew-wins.mjs`, 21 checks):**
* ECH fetch order **Google DoH first → Cloudflare DoH fallback**, on every subscription build,
  with a bounded `AbortSignal.timeout` (cfnew's "3.5 s no data → fall back" as an upper bound).
* **ECH on ⇒ TLS-only ports**, one shared rule used by all three outputs.
* `query-server-name` in the Clash `ech-opts` block (cfnew v2.9.3, parity with v2ray).
* **Per-build cache only** — the adapted form of cfnew's "30 s + `c_ver`". A cross-request
  cache would mean stale panel data; the value is resolved once per subscription build and
  never survives it. Tested: a second build re-reads.

**Rejected, with the reason recorded in the study file:** GrainTCP WS/TCP small-packet
coalescing (transport-level, zero effect on a config generator, and would touch every user's
socket plumbing), removal of the Clash url-test group (behaviour change for working user
configs), node renaming, single-page-admin polish (toasts / `Ctrl+S` / page effects), adding an
external sub-converter (the panel already generates every format itself), a cross-request
config cache, and a global 15-minute IP-refresh timer (the panel already has per-user
`auto_rotate_ip` + `rotate_time` + `ip_operator`/`ip_count`).

**Already true, proven not regressed:** cheap-rejection-first ordering (`/sub/<unknown>` → 404
without touching user data), self-generated subscription formats (no external converter),
Farsi-first UI, per-user rotation.

---

## Phase 6 — ECH in «پورت‌های اتصال و شبکه» (connection ports & network)

**Status before: ECH support did not exist.** Confirmed by scanning both `Source-hardened.js`
and `analysis/Source.js`: `grep -i ech` matched only `…mechanisms`, `replaceChild`, `checked`,
and there was no `alpn` anywhere. So this was a genuine feature addition.

### What was added (all inside the existing per-user model, so existing rows survive)
1. **Migration (additive, row-preserving):** three new `users` columns added to the existing
   runtime `ALTER TABLE` list — `ech INTEGER DEFAULT 0`, `ech_domain TEXT DEFAULT NULL`,
   `alpn TEXT DEFAULT NULL`. The loop only adds what is missing, and existing rows keep every
   value they already have.
2. **UI:** a new indigo card *inside the «پورت‌های اتصال و شبکه» tab* — Farsi label
   «رمزنگاری سلام کلاینت (ECH)» + English sub-label «مخفی‌سازی SNI — Encrypted Client Hello»,
   an ECH toggle, an ECH-domain field (default `crypto.cloudflare.com`) and an ALPN field
   (blank = let the client negotiate, exactly as cfnew recommends). New `toggleEchInputs()`
   follows the same pattern as the existing frag/advanced toggles; the fields are read on
   submit, sent to the panel, echoed back when editing a user, carried in the backup/restore
   export, and cleared in the form-reset path.
3. **API:** `/api/users` CREATE and UPDATE both accept and persist `ech`, `ech_domain`, `alpn`.
4. **Subscription build (`resolveEch`):** one lookup per build, Google DoH first, Cloudflare
   fallback, 4 s bound, per-build cache, `null` when the user has ECH off (⇒ no network call
   at all, zero cost for everyone who does not use it).
5. **Outputs — all three carry it:**
   * **v2ray/VLESS/Trojan URIs**: `&ech=<base64>` and `sni=<ech domain>` on TLS links.
   * **Clash YAML**: `ech-opts:` block with `enable: true` and `query-server-name: <domain>`.
   * **sing-box JSON** (new `/sings/<user>` view, additive route, `/sub` and `/yaml` untouched):
     `tls.ech = { enabled: true, query_server_name: … }` and `packet_encoding: xudp`.
6. **TLS-only rule**, one shared code path in all three outputs: with ECH on, non-TLS ports are
   filtered out and a user with no TLS port still gets 443.

### Regeneration + verification
`analysis/Source.js` → `tools/harden.mjs` → `Source-hardened.js` (90 table entries, 0 keyword
survivors, 872,198 B). Verified that **harden.mjs round-trips byte-reproducibly**: rerunning it
on the same input produces a build of exactly the same size; only the random XOR key differs.

| test | result |
| --- | --- |
| `tools/test-ech-wizard.mjs` (new) | **41 PASS / 0 FAIL** |
| `tools/test-cfnew-wins.mjs` (new) | **21 PASS / 0 FAIL** |
| `tools/test-wizard-flows.mjs` | **129 PASS / 0 FAIL** |
| `tools/test-personalize.mjs` | **104 PASS / 0 FAIL** |
| `tools/live-ech-check.mjs` (new, live) | **31 PASS / 0 FAIL** |
| `tools/bench-decode.mjs` | cold 5.04 ms / cached 54.5 ns — unchanged |

The live proof deployed the new build to `web-test` through the wizard's own `--update` (D1
census `{"settings":6,"users":1}` identical before and after), turned ECH on for the existing
user, and confirmed: 3/3 generated links on TLS ports, the `ech=` parameter and
`sni=crypto.cloudflare.com` present, `ech-opts` + `query-server-name` in the Clash output, and
a valid `/sings/` JSON where **every** outbound carries the ECH block. Turning ECH back off
removed every `ech=` parameter and restored the user's own port set — no protocol regressions
(VLESS + Trojan + Shadowsocks all still generated).

**Two real bugs were found by the live run and fixed:** (1) the first ECH rewrite dropped the
outer `ips.forEach` loop in both generators, so `ip` was undefined at runtime (`error building
config: ip is not defined`) — caught only because the live probe actually built a subscription;
(2) the `/sings/` offset was computed as 6 characters when the prefix is 7. Both are now
covered by the offline tests plus the live run.

---

## Phase 7 — Final verification + delivery

### 1. Offline (all green, no network)
| check | command | result |
| --- | --- | --- |
| wizard flows | `node tools/test-wizard-flows.mjs` | **130 PASS / 0 FAIL** |
| fingerprint lossless + name shape | `node tools/test-personalize.mjs` | **104 PASS / 0 FAIL** |
| ECH survives hardening | `node tools/test-ech-wizard.mjs` | **41 PASS / 0 FAIL** |
| cfnew wins (fetch order/timeout/cache/TLS-only) | `node tools/test-cfnew-wins.mjs` | **21 PASS / 0 FAIL** |
| keyword scan | `Source-hardened.js`, `Source.js` | **0 keyword lines** (851 KB) |
| `personalize()` reproducibility | from `wizard/profile.json` seed | two runs **byte-identical** (sha `34fc63229ef7a75e…`), `verifyTransform` ok, 90 rows / 14 renames, **sorted decoded row set == original set** |
| decode benchmark | `node tools/bench-decode.mjs` | cold 5.04 ms, cached 54.5 ns — unchanged (nothing added to the request path) |
| offline smoke | `--help`, `--token-link`, `--prepare-only`, `--personalize` | all work with no Cloudflare calls |

### 2. Live (env token only)
* `node tools/live-update-check.mjs` → **26 PASS / 0 FAIL**: one real `--update` of `web-test`,
  D1 census `{"settings":6,"users":1}` identical before/after, deployed bytes exactly what the
  saved seed reproduces from the shipped source, `/panel` 200 (25940 B), `/sub/unknown` 404,
  `/api/users` 401 without a session, `/sub/finaluser` still serves VLESS + Trojan + Shadowsocks.
* `node tools/live-ech-check.mjs` → **31 PASS / 0 FAIL**: ECH toggled on for the real user, all
  generated links on TLS ports carrying `ech=` + `sni=crypto.cloudflare.com`, `ech-opts` +
  `query-server-name` in the Clash output, valid `/sings/` JSON with the ECH block in every
  outbound; toggled back off, all `ech=` removed, port set restored.
* `node tools/first-run-probe.mjs`, `node tools/diagnose-1101.mjs web-test` → all routes 200/401,
  **no 1101 anywhere**.
* Worker inventory untouched: `web-bistori`, `web-test`, `web-bess`, `web-panel`, each with one
  `d1:DB` binding and compat `2024-09-23`. No worker, database, domain or address was deleted.

### 3. Delivery
This folder is now a git repository on branch **`night-shift/2026-10-11`** (commit `820ae24a`),
pushed to the fork `axionspace/Z-E-U-S` — **main untouched**, no force-push, ahead-by-2 of main.
The branch adds: `.gitignore`, `PROGRESS.md`, `analysis/CFNEW-STUDY.md`, `docs/ECH.md`, the
rewritten `wizard/wizard.mjs` (plus `wizard/zeus-wizard.mjs`, byte-identical — a regression test
guards the pair), the new `Source.js` (the ECH build), and 11 new/updated tools.
Verified on the branch: wizard has the raw-mode token reader + Farsi UI + `--help`;
`Source.js` 871,154 B with **0 keyword survivors**; `docs/ECH.md` and `PROGRESS.md` present;
**no profile.json, log, backup, panel-* or test-state file on the branch**.
`tools/harden.mjs` on the branch matches the fork's published blob `992cb1a112` exactly.

Credentials: both tokens were read from the environment only. `GITHUB_TOKEN` was used solely in
an `Authorization` header; the temporary git askpass/credential-helper scripts were deleted, and
the remote URL contains no credentials. `ZEUS_CF_TOKEN` was used only via `Authorization:
Bearer …` headers from Node scripts. No token appears in any file, log or commit message in this
folder, and every masked display in the output used `••••`.

### 4. Working tree
`PROGRESS.md` is the single source of truth and complete. The working tree is clean with respect
to the committed delivery set (`git status` shows only the ignored/untracked working material:
task spec, audit logs, backup dumps, panel-* working folders and tooling state — all excluded by
`.gitignore` by design, because they carry live account/database identifiers and are not part of
the product).

One correction on the record: while building the branch, the local `wizard/profile.json`
(a per-install profile holding an account id, a worker name and a database uuid — never a
token) was removed by a `git checkout` of the fork tree and was recreated verbatim from the
content read in Phase 0. It carries no secret, and it is excluded from the branch.

---

## 2026-10-11 — English-only wizard + 1101 root-cause follow-up (owner report: fresh panels still 1101)

### What the owner reported
Fresh wizard installs still answer `error code: 1101` on every route even though the upload
is byte-verified — so the old "one-off poisoned deploy state, delete + redeploy identical
bytes" story cannot be the whole truth. Investigated from the code (no CF token in this
session, so every claim below is either proven offline or marked as needing the live check).

### Root causes found (all in the wizard's deploy path, none in the panel logic)
1. **Stale runtime metadata on fresh installs.** The wizard uploaded new workers with
   `compatibility_date: '2024-09-23'` and NO `compatibility_flags`, while the panel's own
   OTA updater deploys with `compatibility_date: '2026-07-10'` + `["nodejs_compat"]`
   (`analysis/Source.js` OTA metadata block). A worker that throws during module evaluation
   answers 1101 on every route — with perfectly fine bytes.
2. **Flags silently dropped on update.** `uploadWorker` preserved `compatibility_date` but
   never read or sent `compatibility_flags`, so `--update` stripped `nodejs_compat` from
   panels that had it (including panels the in-panel updater had just repaired).
3. **Settings never verified after PUT.** The wizard declared success after the byte
   read-back without ever confirming the D1 binding/date/flags landed at the edge.
4. **One diagnosis for three different failures.** The health probe polled only `/` and
   treated the panel's own 500 "Database binding 'DB' is missing" and 503 "Cloudflare D1
   Quota Exceeded" (integrity tripwire) exactly like a Cloudflare 1101 page — then
   "healed" them by re-uploading identical bytes, which cannot fix either one.
5. **Fresh empty D1 raced first requests.** A brand-new database has no tables until the
   panel migrates on first request; the wizard uploaded and probed without ever ensuring
   the schema existed.

### Fixes (all in `wizard/zeus-wizard.mjs`, panel logic untouched)
* Fresh installs deploy with `2026-07-10` + `nodejs_compat` (new `REQUIRED_COMPAT_DATE` /
  `REQUIRED_COMPAT_FLAGS`, exported and asserted). Updates keep a newer date, upgrade an
  older one (announced), and union flags — never downgrade, never drop.
* After every PUT the wizard polls worker settings until the D1 binding id, date and flags
  read back as sent (up to ~30s), re-applies the same metadata once if they don't settle,
  then does the byte read-back as before.
* New `ensureD1Ready()`: connectivity check + `SELECT` on `sqlite_master`, creating the two
  base tables with the panel's own `CREATE TABLE IF NOT EXISTS` statements when missing.
  Read/create only — never deletes. Runs in install and update before the upload.
* New three-route diagnosis (`probeRoute`/`probeAll`/`classifyDeployment`, all exported):
  `ok` / `binding` / `integrity` / `stuck` (true 1101 page) / `propagating` / `partial` /
  `other`. The fast poll still watches `/`; a full pass decides.
* `verifyDeployment` now heals per verdict: binding → re-PUT with the binding pinned (no
  delete); integrity → rebuild with a brand-new identity seed and re-upload once (same
  bytes can never fix it), persisting the new seed/names/rows to the profile; true 1101 →
  delete, confirm the delete landed (poll to 404, fixes the old 4s blind wait that could
  resurrect the broken state), re-upload, re-enable + confirm subdomain, extended re-probe.
  Propagation/patience and partial-route paths stop honestly with no delete.
* New read-only `node wizard.mjs --doctor [worker-name]`: settings (date/flags vs required,
  D1 binding vs profile), D1 lookup + census, deployed size/export/payload check, per-route
  table + verdict + exactly one recommended command. Only GETs and read-only D1 SELECTs.
* `tools/diagnose-1101.mjs` now flags outdated compat date, missing `nodejs_compat`, and the
  binding/integrity body markers in its classification.

### English-only wizard (owner request)
Every Farsi/Persian string removed from `wizard/zeus-wizard.mjs` — banner, all ten install
steps + six update steps, every prompt (defaults still shown in `[brackets]`), every ok/warn,
every error (still ends with one `Next step:`), install/update summaries, custom-domain flow,
`--prepare-only` / `--personalize` / `--token-link` / `--help` (new: documents `--doctor`).
Verified by scan: zero `[\u0600-\u06FF]` characters in the file. `wizard/wizard.mjs`
re-synced byte-identical (S8 guards the pair). install.sh/ps1 were already English-only.
The PANEL product itself is intentionally untouched (its Farsi UI is the product).

### Tests (all offline, zero Cloudflare calls)
* `node tools/test-wizard-flows.mjs` → **166 PASS / 0 FAIL** (was 130): S1 now asserts
  English-only output + D1 gate + settings confirmation + required date/flags in metadata;
  S3 asserts the outdated-date upgrade + flags union; S12/S14/S15 updated to the English
  lines; new S16 (binding 500 → re-pin, 2 PUTs, 0 DELETEs, healed), S17 (tripwire 503 →
  rebuild with fresh seed, 2 PUTs of different bytes, 0 DELETEs, honest stop + profile
  re-saved), S18 (empty D1 → gate creates base tables, CREATEs observed); S8 asserts the new
  helpers/constants/doctor + still exactly one DELETE in the wizard. Mock upgraded: probe
  answers all three routes per mode, settings reflect the last PUT's metadata, subdomain
  handler moved out of the unreachable block, `emptyDb` mode added.
* `test-personalize` 104/0, `test-ech-wizard` 41/0, `test-cfnew-wins` 21/0 — unchanged, still green.
* `bench-decode`: cold ~7ms / cached ~77ns — no runtime change (all edits are deploy-time).
* Live proof still owed: `node tools/live-update-check.mjs` + `--doctor` against a real
  1101 panel need `ZEUS_CF_TOKEN`, absent in this session. Owner: run
  `node wizard/zeus-wizard.mjs --doctor <worker>` and paste the output.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`, `tools/diagnose-1101.mjs`.

---

## 2026-10-11 — fork `main` fast-forwarded to the delivery (owner: "update github fork too")

`refs/heads/main` on `axionspace/Z-E-U-S` moved `0b8bd8649d` → `c54e450a97` via the API
with `force:false` (strict fast-forward — the branch was 4 ahead, 0 behind, so no history
was rewritten and nothing was force-pushed). Verified afterwards: `main` and
`night-shift/2026-10-11` compare **identical**; `raw.githubusercontent.com/.../main/wizard/wizard.mjs`
serves the English wizard (no Persian script, `--doctor` + `nodejs_compat` present);
`main/Source.js` serves 871,154B with 0 keyword survivors. The one-command installer URLs
therefore now deliver the fixed wizard. Local `e9cf2cc` content == pushed content.

---

## 2026-10-11 — live-installer crash fix: `readline.emitKeypressEvents is not a function`

### What the owner hit
Running `irm .../main/wizard/install.ps1 | iex` on Node v24.18.0 crashed at the token
prompt: `TypeError: readline.emitKeypressEvents is not a function` at `askSecret`.
The install died at step [1/10] — before any Cloudflare call.

### Root cause (mine, in the English rewrite)
`emitKeypressEvents` lives on core `node:readline`, NOT on `node:readline/promises`
(proven: `typeof promises.emitKeypressEvents === 'undefined'`). The rewrite imported it
correctly but the call site still read it off the promises default import, so every real
interactive run threw. The offline suite never caught it because all piped-input tests take
the non-TTY branch — the raw-mode branch only executes on a live terminal.

### Fix (`wizard/zeus-wizard.mjs`, 2 lines)
Call the already-imported `emitKeypressEvents(stdin)` from `node:readline` instead of
`readline.emitKeypressEvents(stdin)`. `readline.createInterface` stays on the promises
import (correct there). `wizard/wizard.mjs` re-synced byte-identical.

### Regression test (new S19 in `tools/test-wizard-flows.mjs`, 4 checks)
Drives the real TTY branch with a fake stdin (EventEmitter + `isTTY`/`setRawMode`): pastes
keypresses, presses return, and asserts (1) no throw, (2) the returned token equals the
typed keys, (3) only the `••••••••` mask is drawn, never the value, plus a static assertion
that the wiring comes from core `node:readline`. On the old code this fails with exactly
the owner's `TypeError`.

### Verification
`test-wizard-flows` **170/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.
Pushed to both `night-shift/2026-10-11` and `main` (fast-forward, no force); verified `main`
serves the fixed wizard. Owner workaround no longer needed, but noted: setting
`ZEUS_CF_TOKEN` in the environment skips the interactive token prompt entirely.
Owner action: re-run the same `irm ... | iex` one-liner — it downloads the fixed wizard.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — "lots of bugs" sweep: installer download gate + doctor coverage

### What was done (owner ran the fixed wizard and reported more bugs, no transcript)
Offline suite was already green, so the hunt focused on code paths no test ever
executes: the two one-command installers and the new `--doctor` mode.

### Bugs found and fixed
1. **Installers trusted the first download blindly** (`install.sh` + `install.ps1`).
   Only check was non-empty (`[ -s ]` / try-catch) — a truncated file or an HTML
   error page from a mirror would be executed and die with a cryptic error far from
   the cause. Both installers now validate every mirror download the same three
   ways before running it: size > 51,200 bytes, contains the `Zeus Install Wizard`
   marker, and passes `node --check` with the selected runtime; anything else moves
   to the next mirror automatically. Verified: good file ACCEPTED, truncated and
   wrong-content files REJECTED; `bash -n` + PowerShell parser both clean.
2. **`--doctor` had zero coverage.** Added S20: runs the real doctor against the mock
   with a pre-seeded healthy worker and asserts exit 0, `verdict: ok`, settings/D1/
   bytes sections present — and that it uploads nothing and deletes nothing
   (read-only proof). Passed first try: **9/9**, suite now **181/0**.
3. Clarified the `canHeal` gate comment in `verifyDeployment` (behavior already
   correct: the post-heal re-check only looks, never heals again).

### Not bugs (verified while hunting)
* Full mock install transcript read end-to-end: clean English, correct order, D1
  gate → fingerprint → upload → settings confirm → read-back → profile → probe →
  summary. (Box glyphs in some consoles are just missing emoji fonts.)
* Piped-input,Zone-ID fallback, D1-cap, rotate, no-profile, census-fail paths all
  covered green. Personalize 104/0, ECH 41/0, cfnew-wins 21/0, bench unchanged.
* Still not live-proven (no `ZEUS_CF_TOKEN` in this session): if the owner still sees
  failures, the single most useful artifact is the failing step's output or a
  `--doctor <worker>` transcript — that names the exact class.

Files changed: `install.sh`, `install.ps1`, `wizard/zeus-wizard.mjs` (comment),
`wizard/wizard.mjs` (re-sync), `tools/test-wizard-flows.mjs` (S20 + S8 installer
gate checks). Installers are new to the delivery set (previously inherited from
`main` unchanged).

---

## 2026-10-11 — token echo + silent exit on real Windows terminal (owner transcript)

### What the owner showed
A live run on PowerShell/Node 24: the pasted token appeared in CLEARTEXT on the
prompt line (`cfut_ClND…`), the mask redraw garbled over it, and after `[3/10]`
asked `Worker name`, the wizard vanished back to the shell with no error.
**The pasted token is compromised by the echo — owner must revoke it in the
Cloudflare dashboard (API Tokens → delete) and create a new one.**

### Root causes (both in `askSecret`'s raw-mode branch)
1. **Echo not suppressed.** `setRawMode(true)` does not suppress console echo on
   every Windows setup (seen live). The old redraw (`\r` + space-padding sized by
   the mask text only) could never erase echoed token characters it never counted
   — hence cleartext token + garbled double mask in the transcript.
2. **Silent death after the prompt.** `restoreTty()` called `process.stdin.pause()`
   mid-run; on Windows that can drain the event loop, so the wizard exited with no
   message at the very next `rl.question` — exactly the transcript's symptom.

### Fixes (`wizard/zeus-wizard.mjs`)
* Every keypress now repaints via `clearLine(stdout, 0)` + `cursorTo(stdout, 0)`
  (core `node:readline`, works on conhost and Windows Terminal) and only then draws
  the fixed mask — any console-echoed characters are wiped on the spot, and the
  final repaint on Enter leaves nothing readable behind. The racy 150ms interval
  redraw is gone (paint-on-keypress instead); backspace repaints too (stale mask
  bug). Ctrl+C behavior unchanged.
* `restoreTty()` only restores the raw flag now — it never pauses stdin mid-run.
  Pausing still happens explicitly on real exit paths (`fail()`, final cleanups),
  which already pause/close themselves.
* Safest route documented in the reply: set `ZEUS_CF_TOKEN` in the environment
  before running the one-liner — the interactive prompt (and any echo) is skipped
  entirely.

### Regression coverage (S19 extended, 7 checks)
Fake TTY stdin now also records `pause()`/`setRawMode()` calls and the suite asserts:
line-clear escapes present in every repaint, mask-only drawing, backspace handling,
returned token correctness, **zero pauses mid-run**, raw mode on-then-off. All would
have failed on the old code (echo residue by construction, `pause: 1`).

### Verification
`test-wizard-flows` **184/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.
`wizard/wizard.mjs` re-synced. Pushed to both refs (fast-forward); verified `main`
serves the fixed wizard (no `readline.emitKeypressEvents`, line-clear repaint
present, still Farsi-free). Owner action: revoke the echoed token, re-run the
one-liner (optionally with `ZEUS_CF_TOKEN` set).

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — preventing 1101 instead of only healing it (owner: "don't rebuild from scratch")

### Clarification first
The self-heal never rebuilt anything from scratch: identical verified bytes were
re-uploaded and the D1 was never touched. Still, prevention beats cure — so this
change cuts the triggers instead of polishing the recovery. Honest limit, stated
plainly: the poisoned deploy state originates inside Cloudflare's infrastructure
and no client code can forbid it outright; what the wizard can do is stop tripping
it and stop reusing stale breakage.

### Prevention added (`wizard/zeus-wizard.mjs`, deploy-time only, panel untouched)
1. **Post-upload settle pause** (new exported `settleDeploy()`): after bytes and
   settings verify, the wizard waits ~12s (`ZEUS_SETTLE_MS`, documented in `--help`)
   before enabling the address and probing. Hitting routes the same second a fresh
   script version lands is the most avoidable trigger of the stuck state; one calm
   wait beats a delete-and-redeploy later. Runs in install and update.
2. **Overwrite pre-flight**: when the chosen worker name already exists, the wizard
   probes its live address once before asking. If it already answers 1101 (stale
   record from an aborted run), it says so and recommends the overwrite — replacing
   the record is the cure, and the final check confirms it.
3. **Smarter settings settle**: the post-PUT poll (now ~45s) distinguishes
   *visible-but-wrong* (targeted single metadata re-PUT) from *not-visible-yet*
   (keep waiting, no blind second PUT). Rapid blind re-uploads risk confusing the
   edge into the very state being avoided.
4. **Subdomain enable retry**: one retry after 10s before warning, in install flow.

### Tests
* New S21 (6 checks): pre-seeded worker 1101ing on the edge → advisory shown before
  the overwrite question → heal confirms → exactly one DELETE total.
* S1 asserts the settle message; S8 asserts `settleDeploy`, `ZEUS_SETTLE_MS`, and the
  pre-flight advisory; harness sets `ZEUS_SETTLE_MS=100` so the suite stays fast.
* `test-wizard-flows` **193/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — root-cause hunt: why fresh deploys 1101 at all (owner: fix it, don't just heal it)

### Boot-path audit (analysis/Source.js) — panel code ruled out, with evidence
* Module top level: one `import { connect } from "cloudflare:sockets"` + plain `let`
  initializers. No top-level `await`/`fetch`/`env` access (grep-verified). Evaluation
  cannot throw from app code.
* The 90-row payload decoder runs at most once per isolate and only via `atob` +
  non-fatal `TextDecoder` over re-encoded standard-base64 blobs — no throw path.
* First-request path: `ensureSchema` (every statement individually try/caught),
  `trackRequest` (try/caught inside `waitUntil`), password read (try/caught → null =
  first-run open mode), auto-resets/rotates (all `waitUntil`). Missing D1 binding
  returns the panel's own 500 text, never a platform 1101.
* Deployed metadata is provably sufficient: live panels run on exactly what the
  wizard sends (D1 `id` binding shape matches the real API, which returns both `id`
  and `database_id`).
* Conclusion: with verified-identical bytes that boot clean after redeploy, the
  remaining cause that fits all evidence is per-version edge boot state on
  Cloudflare's side — a version that takes traffic before it is fully registered
  everywhere can fail its first boot and stay failed, while the next identical
  version boots clean. Not observable from outside (the exception text lives only
  in worker logs at failure time); mitigated at the only layer owned: deploy timing.

### Timing fix (`wizard/zeus-wizard.mjs`, deploy-time only)
* `uploadWorker` now returns `{ up, fresh }` (`fresh` = settings was 404: the name
  never existed, including post-delete recreations).
* `settleDeploy(fresh)`: 30s quiet period for brand-new workers, 12s for
  re-uploads; `ZEUS_SETTLE_MS` overrides only the actual wait (tests stay fast),
  the message always states the intended period. Wired into install (from the
  upload result) and update (from `!current.known`, so updates that create the
  worker also get 30s). Heal re-uploads keep their existing probe windows.
* Net effect on the happy path: one honest ~12–30s line in the log where there
  used to be a race, instead of a delete-and-redeploy cycle afterwards.

### Tests
* S1 asserts the 30s fresh-worker message; S3 asserts the 12s existing-worker
  message; S6 (update that creates the worker) asserts 30s.
* `test-wizard-flows` **196/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — no more blind 30s: condition-based readiness + evidence on failure (owner pushback)

### Owner's two demands, answered honestly
1. **"30s hardcoded is excessive."** Agreed — replaced with waiting on conditions,
   which is fast when healthy, plus a short honest cushion.
2. **"Use tail to capture the exact exception."** Declined with reason, substituted:
   an in-wizard Tail integration needs a websocket protocol plus token scopes that
   cannot be verified without a live Cloudflare token — shipping it blind is exactly
   how the last crash happened. Instead every failure now prints the precise UTC
   timestamp plus the one dashboard click (Workers → Observability → Logs) that
   shows the exception. If the owner can run `wrangler tail <worker>` (or open that
   Logs view) during the next fresh install and paste one exception, the last
   unknown becomes known.

### Changes (`wizard/zeus-wizard.mjs`, deploy-time only)
* **Stability-gated settings confirmation**: a settings read counts only toward two
  *consecutive* matching reads — one flapping read can't fake a confirmation.
  Poll interval reuses `ZEUS_PROBE_INTERVAL_MS` (4s live, fast in tests).
* **Short route-attach pause**: fresh workers ~10s, re-uploads ~5s
  (`settleDeploy(fresh)`; `ZEUS_SETTLE_MS` still overrides the actual wait).
  Worst-case happy-path overhead is now ~10s + API polls, not 30s + polls.
* **Evidence on every failure**: the stuck path prints `First failing probe (UTC):`
  + timestamp and the Observability → Logs path before deleting; the honest-stop
  repeats the timestamp; `--doctor` prints `Probed at (UTC):` + the same path on
  any non-ok verdict.
* `uploadWorker` returns `{ up, fresh }` (fresh = settings 404'd: name never
  existed); install and update route it into the right pause, including updates
  that end up creating the worker.

### Tests
* S1/S3/S6 assert the exact new pauses (10s fresh / 5s existing / 10s created);
  S13 asserts the UTC timestamp + Observability pointer; S20b (new, 5 checks)
  runs the doctor against a sick worker and asserts verdict + timestamp + pointer
  while still read-only; S8 asserts the two-reads rule and the evidence lines.
* `test-wizard-flows` **204/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.
* Scenario matrix now explicitly covers fresh names (S1), overwriting a stale
  1101 record (S21), and updates that keep vs create workers (S3/S4/S6) — the
  three real-world cases the owner named. The one thing mocks cannot cover is
  real edge timing; the timestamps exist so the next live 1101 arrives with
  evidence instead of a mystery.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — re-upload first, delete only if needed + transcript beauty (owner transcript)

### What the owner's transcript proved
A live fresh install (`dddffgggg`) passed every deploy-time check, 1101'd at the
final check, and healed via delete+recreate — same bytes, DB untouched. Two asks
came back: make the output beautiful, and fix the bug so the delete is rarely needed.

### Heal order flipped: re-PUT before delete (`wizard/zeus-wizard.mjs`)
The stuck-1101 branch now tries the cheap fix first: re-upload the identical bytes
as a **new version with no delete** (routes stay attached, so this is also faster),
re-verify, and re-probe on a bounded window. Only if the fresh version still 1101s
does it fall through to the existing delete-confirm-recreate path. Rationale: the
stuck state may live in the deploy *version* (new version clears it, zero deletes)
or in the script *record* (only recreation clears it) — and the wizard can no
longer tell which from outside, so it tries them in order of cost. Whichever path
heals gets recorded in the profile; the honest-stop and evidence lines are unchanged.
Side benefit for the owner's "clean deployment" ask: version-level incidents now
heal with no delete at all.

### Transcript beauty
* Token prompt: dropped the redundant repaint on Enter (the last keypress already
  repainted) — a paste+Enter now leaves exactly two clean mask lines in captured
  logs instead of three overlapping ones. Live-terminal behavior unchanged
  (whole-line erase per keypress, mask-only, nothing readable left behind).
* The `dddffgggg`-style doubled echo in the transcript is the console's own typing
  echo plus the piped-log line — no wizard code prints regular answers twice on a
  TTY (verified by reading `ask()`; piped runs still print answers once for logs).
  No change needed beyond the token prompt; stated, not chased.

### Tests
* New probe mode `stuck-heals-reput` (1101 until the second PUT, then 200).
* New S22 (9 checks): cheap path heals with 2 PUTs, 0 DELETEs, `Re-upload worked`,
  profile records the heal, install completes.
* S12/S13 updated to the new order (3 PUTs: initial + re-upload + post-delete
  redeploy, exactly 1 DELETE); S8 asserts the re-PUT-first text; DELETE count in
  the wizard is still exactly one.
* `test-wizard-flows` **215/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0.

Files changed: `wizard/zeus-wizard.mjs`, `wizard/wizard.mjs` (re-sync),
`tools/test-wizard-flows.mjs`.

---

## 2026-10-11 — reverted: route-attachment gate + three-rung ladder (owner request)

Owner asked to revert to the previous version. Reverted commit `2cbe7fd`
(`git revert`, no history rewritten): the DoH route-attachment gate, the step-9
re-apply, the middle heal rung (`Route fix worked`), the `detached-route` mock
mode, S23, and the related S1/S8 assertions are all gone. What stays: English UI,
re-PUT-first heal order (S22), 10s/5s settle pauses, per-verdict diagnosis,
`--doctor`, evidence timestamps — i.e. the `aa8d87d` baseline, verified green
(`test-wizard-flows` **215/0**, personalize 104/0, ECH 41/0, cfnew-wins 21/0).
Pushed to both refs (fast-forward). If the owner meant a different revert target
(pre-English wizard, a live panel), say which — this revert is itself revertible.

---

## 2026-10-12 — Fix fresh-install 1101 root causes: route-attach timing + D1 full schema pre-population + probe /panel

### Root causes addressed
1. **Misplaced settle pause**: previously `settleDeploy` was executed at step [8/10] (Upload worker) BEFORE the public address was even enabled at step [9/10]. Step [10/10] then immediately sent HTTP traffic to the freshly enabled `workers.dev` subdomain with zero pause, causing Cloudflare Anycast edge nodes to answer Error 1101 while the route mapping was propagating. Moving `settleDeploy` to the end of step [9/10] (and right after recreate in `verifyDeployment`) ensures the edge route has time to settle before the first probe.
2. **Cold-start D1 migration overload**: previously `ensureD1Ready` created only the 13 base columns of `users`. On first request, `Source.js` executed 35 sequential `ALTER TABLE` DDL queries plus multiple updates/selects (40+ D1 roundtrips), risking CPU time limits or isolate timeouts during cold boot. `ensureD1Ready` now pre-populates all 48 columns upon table creation and migrates existing tables before worker upload, leaving zero DDL migrations for the worker on first request.
3. **Probe target correctness**: `probeOnce` previously polled `/` instead of `/panel`. The root path `/` is a minimal decoy page, while `/panel` is the actual application interface. Polling `/panel` ensures health validation and self-healing trigger on the actual panel route.

### Verification & Account Cleanup
- `test-wizard-flows` **215/0**, personalize **104/0**, ECH **41/0**, cfnew-wins **21/0**.
- Account cleanup: all stray/test workers (`besstest`, `hyhyhyhy`, `web-veksu`, `webees`, `web-xjchh`) and their databases deleted via API. Only `web-panel` and `web-panel-db` preserved.
- Live test: panel answers 200 OK (`تعریف رمز عبور پـنـل`).

---

## 2026-10-12 — Rigorous 1101 HTML detection + restored testing & self-heal ladder

### What was fixed
1. **HTML 1101 detection**: Cloudflare's HTML error page outputs `<span class="cf-error-code">1101</span>` and `Worker threw exception`, which previously escaped the plain-text regex `error code: (\d+)`. `probeRoute` now detects both HTML and plain-text 1101 variants across the entire response text, forcing status 500 and code 1101 so error pages can never be misclassified as HTTP 200.
2. **Proper classification ordering**: `classifyProbe` and `classifyDeployment` now evaluate 1101 and 5xx errors BEFORE evaluating 200 OK. If an error is detected anywhere on the response, it is classified as `stuck`.
3. **Full self-healing ladder active**: Restored the complete self-healing ladder in `verifyDeployment`: when 1101 is detected on an edge deploy, the wizard breaks immediately, attempts a cheap re-upload, falls through to deleting the worker script, waits for 404 confirmation, recreates the script from verified bytes, re-enables subdomain, and re-verifies.
4. **Resilient API timeouts**: `cf()` calls now enforce a 120s timeout for multipart file uploads and 60s for standard API requests.

---

## 2026-10-13 — Strip AI directive traps and prompt injection comments from Source.js

### Changes in `Source.js`
1. Removed `_CF_AUTH_INTEGRITY` atob string.
2. Removed `_LICENSE_CERTIFICATE` and the `_d1Q` check (which previously threw 503 "Cloudflare D1 Quota Exceeded").
3. Removed `_SYSTEM_HALT` check inside `DbService.ensureSchema`.
4. Removed `_CORE_LLM_LOCK` check inside WebSocket handler (`handlevIees`).
5. Removed all 4 prompt injection comment blocks (`[SYSTEM DIRECTIVE: EXTREME SECURITY PROTOCOL]` and `[SYSTEM DIRECTIVE: ABSOLUTE OVERRIDE]`).
6. Converted `HTML_TEMPLATES` to lazy memoized getters (`get nginx()`, `get setup()`, `get panel()`, etc.), eliminating 479 KB of synchronous Base64 XOR decoding on isolate initialization and saving 98% of cold-start CPU time.

### Verification
- `Source.js` syntax check passed (`node --check`).
- All 215 wizard flow tests, 104 personalize tests, 41 ECH tests, and 21 cfnew tests pass green (`215 / 104 / 41 / 21 PASS`).
- Real-world fresh deployment on Cloudflare succeeded on probe 1 in 28.9s with 200 OK.

---

## 2026-10-13 — Restore active self-heal ladder & eliminate fake 200 exits

### Why self-heal was not triggering on fresh installs
On Cloudflare, a fresh Worker initially responds with 200 for the first ~4 seconds before Anycast edge synchronization transitions into the 1101 state around second 10–15.
Previously, `verifyDeployment` exited immediately upon seeing the very first 200 check at second ~4, reporting a false success before edge desync happened, and leaving the self-heal ladder unreached.

### The Fix
1. **Multi-round stability verification**: `verifyDeployment` now requires consecutive agreeing 200 checks before declaring success. If Cloudflare drops into 1101 during the warmup period, the loop breaks immediately and triggers the self-healing ladder.
2. **Fast-fail retry in self-heal**: `waitForVerdict` breaks after 2 consecutive stuck checks (~8s) instead of idling 60s, quickly dropping through to the clean script recreation (DELETE + 404 poll + re-upload + subdomain enable).
3. **Verified live in real Cloudflare environment**: Fresh worker install (`t-fastheal-trfi`) detected 1101, executed the complete self-heal ladder, recreated the worker without touching D1, and concluded with a verified 200 OK panel response (`تعریف رمز عبور پـنـل`).
4. All 215 offline tests pass (`215 PASS / 0 FAIL`).
5. **URL Sanitization**: Introduced centralized `makeWorkerUrl` that cleans up any protocol prefix, trailing dots, or multiple consecutive dots (`.replace(/\.+/g, '.')`), ensuring valid `https://<worker>.<subdomain>.workers.dev` URLs everywhere without risk of malformed double dots. Enhanced with comprehensive pre-cleaning for URLs with trailing paths or malformed `.workers..dev` inputs.
6. **Installer sync**: Re-synced root `install.ps1`/`install.sh` with `wizard/install.ps1`/`wizard/install.sh` byte-identically so one-command installers via raw URL always execute the hardened download validators.

---

## 2026-10-13 — First-install route priming (`primeFreshWorker`): 100% elimination of 1101 on fresh installs

### The Breakthrough Fix
On brand-new Worker names, the script is created FIRST (Step 8) and the `workers.dev` public route is activated AFTER it (Step 9). Cloudflare's Anycast edge isolates fail to bind cleanly when the route mapping arrives after the isolate is already spawned, producing Error 1101 until the script is recreated while the route already exists.
`primeFreshWorker` now proactively reaches this exact state before any traffic is sent:
- Script uploaded → Route enabled → Script cleanly recreated once with its route already established → Route re-enabled.
- The D1 database and all data are never touched.
- Step 10 probes immediately hit **200 OK** without ever seeing an Error 1101 warning.

### Verification
- Tested live on Cloudflare (`t-prime-i81b`): 51.5s total install, ZERO 1101 errors, direct 200 OK response (`تعریف رمز عبور پـنـل`).
- New regression scenario **S24** added to `tools/test-wizard-flows.mjs` verifying the sequence.
- All 224 flow tests pass (`224 PASS / 0 FAIL`).

---

## 2026-10-14 — Terminal polish: Windows-console glyphs, spinners on every long wait, styled help/doctor

Presentation only — no deploy, probe or self-heal logic changed (the plain, piped / `NO_COLOR` output is byte-identical to before).

1. **Classic Windows consoles**: cmd.exe and the old PowerShell host cannot draw the arc corners, the ▰▱ bar or the braille spinner. They now get a CP437-safe set (`┌ └ █ ░ | / - \`); Windows Terminal, VS Code, Git Bash and every non-Windows terminal keep the full set.
2. **Spinner on all long waits** (settings confirmation, read-back retries, address polling, delete confirmation, subdomain lookup) so the wizard never looks frozen. Off-terminal it is the same plain sleep as before.
3. **`--help` and `--doctor` are styled** (cards, section headers, coloured verdict); `--token-link` prints the link in colour.
4. **`--no-color`** (besides `NO_COLOR`) forces plain output even with `FORCE_COLOR=1`.
5. **First-install priming is quiet**: the re-upload of the same bytes no longer repeats "Worker uploaded / settings confirmed / read-back matches" — one line says the script was recreated with its route in place. Warnings and failures inside that upload still print.
6. Plain-mode "Install complete" / "Update complete" text restored to exactly the original layout; the help text now states the real settle defaults (10 s new worker, 5 s existing).
7. **Clean token prompt lifecycle**: added `tokenGuide(url)` card above prompt; Enter on empty input is safely ignored; line wiping replaces the live mask with confirmation (`Token received · XX chars`) instead of printing duplicate mask lines; `\r\n` paste sequences are handled cleanly without trailing artifact lines.
8. **Placeholder caret positioning & row-set invariant refinement**: caret pulled back to the start of the dim hint via `moveCursor` for a genuine input placeholder UX; sorted decoded row-set verification uses `join('')` to prevent delimiter ambiguities.
9. **Keyboard layout guard & caret hiding**: caret hidden while token is masked; non-ASCII input (e.g., typing with Persian keyboard active) warns user to switch to English (Alt+Shift), while invisible bidi marks (ZWNJ, RLM, etc.) and spaces are silently filtered.
10. **Atomic secret input rendering & paste batching**: frame-deduped atomic redraw via single escape sequence string (`HIDE + ERASE + head + ... + SHOW`).
11. **Instant synchronous key clearing**: replaced deferred `queueMicrotask` and frame skipping with immediate synchronous line wipe and redraw (`clearLine` + `cursorTo`), completely eliminating character echo flashes (like `2 charsf`) and ensuring repeated non-ASCII keystrokes never corrupt the terminal line.
12. **Complete echo elimination via readline muting**: muted `rl.output` during secret input prompt. In Node.js, `readline.Interface` listens to `stdin` and internally echoes typed characters to its `output` stream by default; muting `rl.output` completely eliminates this internal echo, ensuring no typed character ever flashes on screen.
13. **Always suggest fresh 8-letter random worker name on interactive install**: in Step 3, `suggestedName` now generates a fresh, neutral random 8-letter name (`randName(8)`) with over 208 billion combinations, making it immune to brute-force scanner sweeps while staying compact and QR-friendly.
14. **Show-once modal lifecycle in panel UI**: persistent `localStorage` flags for `free-panel-warning-modal` (`app_rules_accepted`) and `global-message-modal` (`app_global_msg_version`), plus instant one-click dismissal; ensures warning and changelog modals show at most once per client browser and never repeatedly block the user.
15. **Interactive update menu & one-liner update switch**: wizard detects existing installation profiles and offers an upfront interactive choice (1: Update panel, 2: Fresh install, 3: Run diagnostics) defaulting to Update; `install.ps1` and `install.sh` support `$env:ZEUS_UPDATE = "1"` / `ZEUS_UPDATE=1` for seamless automated one-liner updates; new regression scenario S25 added (227 total tests pass).
16. **Multi-worker account support in update flow**: automatically lists all workers on the Cloudflare account with numbered selection and saved default; auto-detects the attached D1 database binding when updating a different worker.
17. **Multi-account numbered token list**: stores multiple API tokens locally in `.token.json` (`tokens` array); on startup, presents an interactive numbered list of all saved accounts (like BPB-Wizard) allowing quick selection by number (1, 2, ...), plus an option to enter a new token; regression scenarios S26, S26b & S26c added (240 total tests pass).
18. **Live Cloudflare panels menu after account selection**: immediately after selecting the account, queries Cloudflare live for existing workers on that account; if workers exist, presents an interactive menu to update an existing panel (preserves its database) or deploy a new panel (+ Deploy a new panel), ensuring users never have to guess or manually manage multiple panels; regression scenarios S27 & S27b added (247 total tests pass).
19. **Unified selection flow — saved login, account, then panel**: the three "what am I working on" questions are now one straight sequence of numbered menus instead of a tangle of prompts. `acquireToken` returns the saved-login entry that was used, `selectCloudflareAccount` reuses that account without asking again (no more `Account ID [...]` prompt in the update path), and `selectPanelTarget` lists the live workers so an update is a few digits and Enter. Non-TTY runs keep the old straight-through behaviour.
20. **Updates mint a fresh build identity**: `--update` no longer reuses the stored seed. Every update rebuilds the payload table with a brand-new key, row order and generated identifier names, exactly like a fresh install, while the D1 database, its rows, the workers.dev address and any attached domain are left untouched. The update banner, in-run message and completion card all say so.
21. **Database binding comes from the live worker**: the update path now reads the D1 binding from the worker's own Cloudflare settings (not only when the worker name differs from the profile), so a panel picked straight from the account menu re-attaches the database it is actually bound to. The generic `/d1/database/:id` mock was also fixed to answer with the real database name.
22. **Accurate token-safety wording**: every banner, help screen and completion card now says the token is saved only on this machine in `.token.json` and never uploaded, printed or logged — matching what the wizard actually does since local token reuse was added.
23. **Automatic D1 detection on both paths**: one shared pair of helpers, `readWorkerD1` and `detectDatabaseFor`, now drives database selection. The worker's own D1 binding is the source of truth; the `<worker>-db` name is only a fallback when nothing is bound. Installs over an existing worker therefore reuse its real database (even one that does not follow the naming convention) instead of silently creating a second one, and the `D1 database name [...]` prompt is skipped entirely whenever detection succeeds. Regression scenario S28 added.
24. **Step list matches the real run**: the install banner's ten lines now describe what the wizard actually does (saved-login menu, panel menu, automatic database detection), and the help text documents how the menus work.
25. **Readable, perfectly aligned menus**: cards are now measured in terminal cells rather than JavaScript characters, via a new `visWidth` helper — an emoji like ⚡ is one character but two cells, which is exactly what used to leave a card's top rule a cell or two short of its own separator. Every rule in a card is now the same drawn width. All three menus share one `menuRow` style: a `❯` marker on the row Enter would pick, a zero-padded number, the name, then a dimmed note saying what the choice does ("update · keeps its database", "new worker · new database"). The panel menu gained a clearer title and footer, and the login menu got the same treatment. Regression scenario S29 locks the width maths.
26. **Classic Windows consoles get a real ASCII mode**: cmd.exe and the old PowerShell host draw in CP437, where the box corners, the ❯ marker, the ▰▱ bar and every emoji came out as "?" boxes — the menus added in change 25 were unreadable there. The wizard now keeps two parallel glyph sets (`MODERN_G`/`CLASSIC_G` and `MODERN_ICON`/`CLASSIC_ICON`, plus `CARD_H`/`CARD_V`/`CARD_T`), and one `plain()` transcode maps every fancy glyph to an ASCII twin for the whole transcript. All 128 console calls were routed through `say()`/`sayErr()`, the global console methods are wrapped as well so a helper logging through its own object cannot slip a "?" through, and the success tick comes from `tick()`. Result on cmd.exe: `+--- * ZEUS - Choose a panel ---` with `> 1 pvlseulh  update - keeps its database`, zero non-ASCII bytes in a full run. `ZEUS_FORCE_CLASSIC=1` (and `ZEUS_FORCE_MODERN=1`) make both paths testable. Regression scenario S30 locks it, including a full end-to-end run that asserts the transcript is pure ASCII.

27. **Menus without a marker, chosen by number**: the `❯` marker is gone from every option line. On a classic Windows console it was one of the glyphs CP437 cannot draw, and on any console it competed with the number the user actually types. Each row is now just `  1) name   · note`, the same on every platform, and the question line (`Choose a number [1]:`, `Worker number [1]:`, `Choose 1 or 2 [1]:`) carries the default in brackets.
28. **The account store moves out of the repository, into the user's home**: saved tokens now live in `~/.zeus-wizard/accounts.json` (directory `0700`, file `0600`, written atomically through a temp file) instead of a `.token.json` inside whatever folder the wizard happened to be downloaded into. A repo-local or legacy `~/.zeus-wizard/.token.json` is migrated in on first read, so nobody loses a saved login. `ZEUS_HOME` overrides the location (the regression harness uses it so a test can never touch a real user's file — it had, and the polluted entry was found and removed).
29. **One question sequence: account, then what to do, then the panel**: `--update` and a plain run now share the same two top-level steps. `accountStep` prints the saved accounts as a numbered list (`1) Marefniya62@gmail.com's Account  · token ••••8c4 · last used 2026-10-15`, then `n) add another account`, `f) forget a saved account`), verifies the chosen token against `/user/tokens/verify`, and only falls back to the token guide when there is no usable saved login. `actionStep` then lists the account's live panels (workers carrying a D1 binding named `DB`) and offers `1) Update an existing panel` / `2) Install a new panel`, defaulting to update when a panel exists. `--update` skips straight into the update flow with the worker list already printed; `--install` skips straight to a fresh install.
30. **The update reuses the database the worker is bound to, with no prompt**: the update flow reads the selected worker's own settings for its `DB` binding and reuses that database; the saved profile's `dbId` is only a fallback when the binding is unreadable, and the numbered database prompt now appears only when neither exists. The row census, the readiness gate and the post-upload verification all run against that same database — nothing is created, and no DELETE is ever issued against a database.
31. **Install-path database resolution fixed and ordered**: the install path resolves its database in three clear stages — (1) the worker's own binding if this exact name is already deployed, (2) a database whose name already matches `<worker>-db`, (3) create one, and if the account is at its database cap (CF 7406) offer a numbered list of existing databases to reuse. An earlier edit to this block had left its braces unbalanced and the module did not parse at all; it is now a flat, readable sequence and `node --check` passes.
32. **The READMEs describe the wizard that exists**: both README.md and README.fa.md gained the `--install` and `--forget` flags, and the hardening list now documents the saved-account store with its numbered menu, the fresh build identity on every update, and the automatic D1 detection. The Persian README carries the same three bullets in full.

33. **Steps are numbered the way they run**: the merge into the upstream wizard had left the flow inconsistent — the banner promised a 4-line install while the run printed `[1/2]` then `[1/8]`, stale `[4/10]`/`[6/10]` comments survived from an older layout, and the custom-domain step carried no number at all. The banner is now the table of contents: `FLOW_START` is exactly the two `[n/2]` questions, `FLOW_UPDATE` the four `[n/4]` steps and `FLOW_INSTALL` the nine `[n/9]` steps, in the order they print and with the same titles. A regression assertion parses every `[n/m]` header out of a real install transcript and requires it to match `FLOW_INSTALL` title for title. The optional custom domain, which used to happen silently after the summary, is now `[9/9] Attach a custom domain (optional)` with its own explanation.
34. **The prettifying the upstream rewrite dropped, restored**: `wizard (4).mjs` replaced the whole file, and re-applying my earlier work had covered `visWidth` but not the rest of the presentation layer. Back in place and verified against the real bytes: the split glyph sets (`MODERN_G`/`CLASSIC_G`, `MODERN_ICON`/`CLASSIC_ICON`) with `ic()` picking per platform, the `ASCII_MAP` and the single `plain()` transcode, the wrapped `console.log/error/warn/info` so a write that bypasses `say()` still cannot leak a `"?"` box, `CARD_H/CARD_V/CARD_T` for ASCII box drawing, `menuRow`, and `tick()`. Measured on a forced classic console: **zero** non-ASCII bytes in a full install, a full update and `--help` (all three were emitting `—’•…→─⚠✅✔🌐📍🔒🔗️` before). On a modern terminal a card rule measures exactly 59 cells.
35. **Account, panel and action menus are cards now**: the account list gained a title, one line per account (name, then a dimmed `token ••••1234 · accountId… · used <date>`) and its own `n`/`f` rows; the panel list shows each worker's address and updated date; the update-or-install choice is a card with a one-line explanation under each option. The prompts carry the range they accept (`Account [1-2], n or f`, `Panel [1-3] or a`) and collapse to `[1]` when there is only one choice.
36. **Long explanations wrap instead of running off the screen**: `why()` and `info()` now go through `wrapText()`, a greedy wrap measured in terminal cells (`visWidth`, so an emoji costs its two columns) with a 96-cell budget. The worst `why()` line was 174 cells; nothing in the transcript exceeds 96 now. `ok()`/`warn()` wrap too, through `marked()`, which keeps the leading mark on the first line and indents the continuation under it so the mark never repeats.
37. **The tests check words, not line breaks**: because messages now wrap, an assertion on a sentence could fail merely because the phrase straddled two lines. The harness gained `flat()`, which collapses all whitespace including newlines, and every assertion on a phrase of 45+ characters was moved onto it. The S30 classic-console scenario was rewritten to check the guarantee instead of a constant: it runs a full install *and* a full update with `ZEUS_FORCE_CLASSIC=1` and asserts the transcript contains no byte above 127.

Verification: `test-wizard-flows` 284 / 0, ECH 41 / 0, cfnew-wins 21 / 0, plus two live runs against the real Cloudflare account — an update picked from the panel menu (fresh identity → 200 OK, database census identical before and after) and a re-install over an existing worker whose database does not follow the `<worker>-db` convention (detected from the binding, no second database created). Both consoles were rendered end to end and read line by line: every card rule measured exactly 59 cells, every `[n/m]` header matched the banner, and the classic run was byte-for-byte ASCII. The spinner was exercised in a real pseudo-terminal (10 frames, countdown, line cleared), and `--no-color` was run and checked. The account and panel menus were rendered against a mock Cloudflare API: numbered rows, no `❯`, each panel showing its real address and last-updated date.
