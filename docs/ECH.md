# ECH — Encrypted Client Hello, per user, in the «پورت‌های اتصال و شبکه» tab
#
# Encrypted Client Hello (ECH) hides the real SNI in the TLS ClientHello: a filtered
# network can no longer read the domain you are connecting to from the handshake, which is
# the one field a plain TLS WS config still exposes. This document describes how the panel
# exposes it and what each client family receives.
#
# ------------------------------------------------------------------ how it works
#
# * One toggle per user, in the «پورت‌های اتصال و شبکه» tab («رمزنگاری سلام کلاینت (ECH)»),
#   with an optional ECH-domain field (default `cloudflare-ech.com`) and an optional ALPN
#   field. Blank ALPN means "let the client negotiate", which is recommended.
#
# * The default is the HOSTNAME ALONE, so the field reads as a domain and a user who just
#   ticks the box never has to understand the "+..." syntax. The field still accepts two
#   shapes. A bare hostname is looked up and emitted as-is. The directive form
#   (`cloudflare-ech.com+udp://8.8.8.8`) is the shape Xray, Hiddify, BPB and cfnew use: the
#   part before `+` is the host, and the part after names the resolver to read the config
#   from. This panel performs the DoH lookup itself, so the hint decides which of our two
#   resolvers tries first. It cannot add a resolver, only reorder the fixed pair. Everything
#   that goes into a generated config as SNI (`query-server-name`, `server_name`, `sni`) is
#   the hostname ALONE — the full directive is not a valid SNI.
#
# * Three hint shapes are recognised, because three panels write them and a value that is
#   accepted but then ignored is worse than one refused: `udp://8.8.8.8` (cfnew and ours),
#   `udp://dns.google` (a bare resolver hostname), and `https://dns.google/dns-query`
#   (Nova's URL form). Matching is on the resolver, not the syntax, and a port or a trailing
#   dot is tolerated. An unrecognised resolver keeps the normal Google-then-Cloudflare order.
#
# * Both fields are validated server-side on save, on both write paths (create and edit).
#   A bad domain or a malformed ALPN list is refused with a 400 and nothing is written, so a
#   user's other edits are never half-applied.
#
# * There is a SECOND, independent ECH control beside it — «ECH کلاینتی», the way the main Zeus
#   panel works. It stores a raw value in `ech_client_value` and emits that value UNCHANGED into
#   `&ech=`, leaving SNI at the worker domain, so the CLIENT resolves the config itself. Server
#   mode instead resolves it here and emits base64. Both write the same link parameter, so a
#   client keeps whichever it parses first and silently drops the other — the two are therefore
#   mutually exclusive: turning one on turns the other off immediately in the UI, and the server
#   refuses a row that holds both (`400`, nothing written) because a client-side rule alone can
#   be bypassed with a direct API call. In the YAML and JSON cores both modes express the same
#   thing, since those take an ECH server NAME rather than a config: the hostname half.
#
# * The setting lives in five `users` columns — `ech`, `ech_domain`, `alpn`, `ech_client`,
#   `ech_client_value`. They are added by the panel's existing runtime migration
#   (`ALTER TABLE users ADD COLUMN …`), which only adds what is missing, so **every existing
#   row keeps every value it already has** and every existing user continues to work with ECH
#   off.
#
# * The ECHConfig itself is fetched from DoH **on every subscription build** — Google DNS
#   first, Cloudflare DNS as the fallback — with a bounded timeout, and cached only for the
#   duration of that single build. A user who edits their row therefore always gets the config
#   that belongs to their settings, and a user who does not use ECH causes **no network call
#   at all**.
#
#   Server mode forces the generated links onto **TLS ports only** — the same rule in all
#   three output formats — so a plaintext link can never appear next to an ECH link.
#
# ------------------------------------------------------------ what each client gets
#
# * VLESS / Trojan links (`/sub/<user>`): `&ech=<base64 ECHConfig>` and `sni=<ech domain>`.
# * Clash (`/yaml/<user>`): an `ech-opts` block with `enable: true` and
#   `query-server-name: <ech domain>`, exactly matching the v2ray output.
# * sing-box (`/sings/<user>`, a new additive route): `tls.ech = { enabled: true,
#   query_server_name: … }` plus `packet_encoding: xudp`.
#
# The subscription link, the QR code and the status page are unchanged.
#
# ------------------------------------------------------------------ verification
#
#   node tools/test-ech-hardening.mjs  # static: the feature survived the hardening round-trip
#   node tools/test-ech-behaviour.mjs  # runtime: fetch order, timeout, cache, validation, both value shapes
#   node tools/test-ech-client.mjs     # client mode: the raw form, and the mutual exclusion
#   node tools/live-ech-check.mjs     # live, against a real deployment
#
# All three are offline-safe except the last one, which needs `ZEUS_CF_TOKEN` in the
# environment. The token is read from the environment only and is never written anywhere.
