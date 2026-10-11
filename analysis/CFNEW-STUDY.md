# CFNEW-STUDY.md — what actually transfers from cfnew to a multi-user D1 PANEL

Studied: `byJoey/cfnew` README/changelog (v2.9.1 → v3.1) and the local `bpb-wizard` folder.
**Context first:** cfnew is a *single-node* script — one UUID, one `path`, config in KV, and the
node it ships is one Cloudflare address. The ZEUS panel is a *different product*: a PWA admin
dashboard on Cloudflare Workers + D1 that stores **one row per user** (protocol mix, ports, clean
IPs, TLS mask, fragmentation, quota…) and renders **per-user subscription links, QR codes and
status pages**. So every cfnew idea has to be judged as: *does this help a per-user subscription
factory, or does it only help one node?* Anything that changes how bytes are tunnelled is out of
scope here: this panel is not the transport, it is the config generator.

---

## Findings

1. **ECH (`ech=yes`, v2.9.1)** — cfnew fetches the ECH config from DoH (Google DNS first,
   Cloudflare DNS as fallback) *every time the subscription is built*, and enabling ECH
   automatically switches the node to "TLS-only" so port 80 cannot interfere.
   → **ADOPT (Phase 6).** For the panel this becomes a *per-user* column, not a global flag:
   `ECH toggle in the «پورت‌های اتصال و شبکه» tab`, `tls=on` + TLS ports forced when it is on,
   and the ECH config re-fetched on every `/sub/<user>` build. The retry order
   (Google → Cloudflare) and the "auto TLS-only" rule are copied as-is.

2. **Graphical DNS / ECH domain + `query-server-name` (v2.9.3)** — the ECH *domain* became
   user-settable in the UI, and Clash's `ech-opts` gained `query-server-name` to match the
   v2ray output.
   → **ADOPT (Phase 6).** The panel gets an `ech_domain` field next to the toggle (Farsi label +
   English sub-label), and Clash emits `ech-opts: {enable: true, query-server-name: <domain>}`
   exactly like cfnew/v2ray, so all three client families print the same value.

3. **ALPN dropdown, blank = let the client negotiate, written only for TLS nodes (v2.9.8c)** —
   cfnew deliberately does *not* pin `alpn` unless asked, because a wrong `alpn` (e.g. `h3` on an
   `h2`-only edge) breaks the connection.
   → **ADOPT, conservative.** The panel already ships a per-user `fingerprint` and `tls_mask`;
   an `alpn` *text* field (blank by default, never auto-filled) is the safe form of this idea.
   No forced value, so no new failure mode for existing users.

4. **KV config cache: 30 s window + a cross-isolate version key `c_ver` (v2.9.8c)** — cfnew found
   that a plain 5-hour cache (v2.9.6) made "save then check" show stale data twice, and fixed it
   with a short window plus a version counter.
   → **ADAPT, not copy.** The panel's config lives in D1, not KV, so there is no `c_ver` to bump.
   The transferable lesson is *short window + explicit invalidation on write*: the ECH config we
   cache for a subscription build is held in memory for the length of that single build (never
   across builds), which is strictly safer than a 30 s cross-request cache in a panel whose users
   edit their rows at any time. No cross-request cache was added — that would be a behaviour
   change, and stale panel data is worse than a re-fetch.

5. **SOCKS5 downgrade timeout: 3.5 s of no data on the direct attempt → fall back (v2.9.8c)**.
   → **ADOPT, as a bound.** The panel already has a relay/SOCKS5 path for a user's chained
   outbound. A hard timeout on the *direct* attempt before falling back is exactly what cfnew
   does and can only remove a hang, never change a success. Applied as a bounded wait, so a slow
   proxy no longer stalls a subscription build that touches it.

6. **Internal sub-converter (v2.9.8c)** — Clash/Stash/Sing-box/Surge/Loon/Quantumult X configs are
   generated inside the worker, no external service.
   → **REJECT (nothing to do).** The panel already generates every format itself and never phones
   an external converter, so it is already at parity. Worth stating so nobody "adds" a dependency.

7. **GrainTCP-style WebSocket/TCP small-packet coalescing (v2.9.8c)** — upstream coalescing,
   downstream aggregation, large packets sent straight through, VLESS hot path tuning.
   → **REJECT, and loudly.** That is a *transport* optimisation for a script that terminates user
   traffic. This panel terminates nothing: it hands out URLs. Touching the panel's socket plumbing
   would change behaviour for every existing user to win microseconds nobody asked for. Recorded as
   "studied and deliberately not adopted".

8. **`dkby=yes` "TLS-only nodes" (v2.9.8c) and ECH's auto-TLS-mode (v2.9.1)** — the same invariant
   from two directions: some features only make sense on a TLS listener.
   → **ADOPT.** One shared rule in the panel: when ECH is on for a user, the generated links use
   the TLS ports only, so a user cannot accidentally publish a plaintext link next to an ECH one.

9. **v3.0 "official direct": dropped worker-region auto-detection, ship 10 built-in Cloudflare
   addresses spread over 10 different /24s so one blocked range cannot wipe the list.**
   → **ADAPT.** The panel's clean-IP pool is user-supplied, but the *VIP proxy repository* fetch
   has a fallback order. The transferable idea is *diversity over cleverness*: keep several
   independent sources and a fixed order, and never let a single failing source decide the result.
   The wizard's six-mirror source fetch already follows this rule.

10. **Clash: removed the "auto select" url-test group because periodic speed tests waste requests
    (v2.9.8c).**
    → **REJECT for now.** Changing an existing user-visible Clash group is a behaviour change, and
    this panel's users have working configs. It is logged as a future, opt-in cleanup rather than a
    silent swap.

11. **Invalid paths return 404 *before* any config read (v2.5/v2.9.6) — do the cheap rejection first.**
    → **ADOPT, already true.** The panel refuses `/sub/<unknown>` with 404 without touching user
    data (proved by `first-run-probe.mjs` and `live-update-check.mjs`), so the ordering is already
    correct; the study note is that it must stay that way.

12. **15-minute automatic preferred-IP refresh (cfnew README) + `rotate_time`-style rotation.**
    → **REJECT (already covered).** The panel already has per-user `auto_rotate_ip` +
    `rotate_time` + `ip_operator`/`ip_count`, which is strictly more flexible than a global timer.

13. **Farsi/RTL UI and browser-language detection.**
    → **REJECT (already covered, and out of scope).** The panel UI is already Farsi-first, and the
    night-shift spec puts the Farsi/RTL work in the *install wizard* (Phase 3), not in the panel.

14. **Node naming: `isp-colo-N` / `优选域名-N` / `IPv6优选-N` (short, no port/protocol suffix).**
    → **REJECT.** Renaming subscription entries would change existing users' client-side configs.
    Noted, not done.

15. **Floating toasts, `Ctrl+S` save, page-effect switch (v2.9.7) — pure single-page-admin polish.**
    → **REJECT.** They belong to cfnew's one-page KV editor, not to a PWA panel with its own
    design language. No behaviour, no security value here.

---

## What this means for the delivery

* Adopted and implemented: **ECH (per user) + ECH domain + TLS-only auto-mode + ECH-config
  refresh with Google→Cloudflare fallback + `query-server-name` in Clash + a bounded SOCKS5
  direct attempt.** Each has a test in `tools/test-cfnew-wins.mjs`.
* Deliberately not adopted (with reasons above): GrainTCP transport coalescing, url-test removal,
  node renaming, single-page-admin polish, external sub-converter usage, a cross-request config
  cache.
* Checks that these ideas cost nothing: `tools/bench-decode.mjs` before/after in `PROGRESS.md`
  (cold decode and cached read unchanged; the decoder is not in the socket path).
