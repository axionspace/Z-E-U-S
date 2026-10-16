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
#   with an optional ECH-domain field (default `crypto.cloudflare.com`) and an optional ALPN
#   field. Blank ALPN means "let the client negotiate", which is the recommended setting.
#
# * The setting lives in three new `users` columns — `ech`, `ech_domain`, `alpn`. They are
#   added by the panel's existing runtime migration (`ALTER TABLE users ADD COLUMN …`), which
#   only adds what is missing, so **every existing row keeps every value it already has** and
#   every existing user continues to work with ECH off.
#
# * The ECHConfig itself is fetched from DoH **on every subscription build** — Google DNS
#   first, Cloudflare DNS as the fallback — with a bounded timeout, and cached only for the
#   duration of that single build. A user who edits their row therefore always gets the config
#   that belongs to their settings, and a user who does not use ECH causes **no network call
#   at all**.
#
# * Turning ECH on forces the generated links onto **TLS ports only** — the same rule in all
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
#   node tools/test-ech-behaviour.mjs  # runtime: the fetch order, timeout and cache behaviour
#   node tools/live-ech-check.mjs     # live, against a real deployment
#
# All three are offline-safe except the last one, which needs `ZEUS_CF_TOKEN` in the
# environment. The token is read from the environment only and is never written anywhere.
