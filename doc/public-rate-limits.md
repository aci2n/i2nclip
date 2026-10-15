# Public endpoint IP rate limits

## Goal, scope, and defaults

Bound unauthenticated registration work before body reading or database access.
Use fixed 60-second windows: registration permits 10 requests per source and 120
globally; health permits 120 per source. Keep pairing's existing 10/source and
120/global join/enumeration limits, using the same resolved client address.
Authenticated media/ping/quota and valid pairing participants retain their
existing behavior. Invalid capability requests still spend pairing's public
budget. Public endpoints are limited even if an Authorization header is supplied.

Return uncached JSON 429 with Retry-After rounded up to the remaining window.
Rejected requests read no body and use no database resources. Rate state is
instance-local, in-memory, bounded to 4096 live source/endpoint buckets; reject
new sources when full, prune expired buckets, and do not evict live buckets.
Restart clears rate state. Missing peer metadata shares one conservative bucket.
IPv4-mapped IPv6 normalizes to IPv4; IPv6 sources share a /64 budget to prevent
cheap address rotation. No persistence, external limiter, tuning API, or jobs.

## Proxy trust and ownership

Separate client-IP parsing from rate accounting and HTTP handlers. Parse
I2N_TRUSTED_PROXIES once at startup as comma-separated IP addresses or CIDRs;
default to no trusted proxies, rejecting invalid configuration. Use ipnet for
CIDR handling. Only trusted TCP peers may supply proxy headers. Origin signature
validation continues using I2N_ORIGIN, never proxy host/proto headers.

Choose the first present header in this order: X-Forwarded-For, Forwarded,
X-Real-IP. Walk chained headers right-to-left, stopping at the first untrusted
hop; ignore any spoofed prefix beyond it. Accept IPv4/IPv6, bracketed/quoted
IPv6 and optional ports. Malformed/ambiguous, oversized (>4096 bytes), or overly
long (>32 hops) chains fall back to the actual TCP peer, not another header.
Forwarded requires one for= per element. X-Real-IP must contain one address.
Untrusted peers' headers are ignored. Unsupported vendor headers confer no trust.

Caddy must overwrite/strip incoming client-IP headers. Its default sanitized
X-Forwarded-For is the primary source; remove Forwarded and X-Real-IP when using
that default. If another proxy/CDN precedes Caddy, configure its trusted proxies
and strict right-to-left client-IP handling too. Trust only actual proxy peers.

## Acceptance checks

Test CIDR configuration, trusted/untrusted peers, IPv4/IPv6/ports, repeated header
fields, precedence, malformed chains, hop/size bounds, and spoofed prefixes.
Test independent sources/endpoints, global registration limits, IPv6 /64 grouping,
exact expiry, Retry-After, bounded buckets, and cleanup without extending windows.
Router tests use isolated state and prove 429 precedes body polling/database
access and Authorization cannot bypass it. Preserve pairing capability/rate tests.
Run Rust tests, configuration checks, full isolated PostgreSQL suite, Clippy and
format/build checks. Document Caddy setup and commit this feature independently.
