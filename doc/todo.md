# Audit follow-up

Work through these in order. Details and reproductions are in [the audit report](audit-2026-10-10.md).

1. [x] Fix admission tests and documentation: queued downloads now resume after unpolled/partial responses release their permits, waits are bounded, and admission documentation matches the implementation. The download test passed in the reported PostgreSQL run. Corrected the upload test's stale assertion: a queued authenticated empty upload returns 400 for its invalid frame; replay still returns 401. Local PostgreSQL execution remains blocked by the missing Podman API socket.
2. [ ] Retain failed immediate context-menu uploads under individual IDs and provide retry.
3. [ ] Propagate cancellation to tab-injected media fetches and clean up their streams.
4. [ ] Preserve a pending encrypted identity and recover from lost registration responses or persistence failures.
5. [ ] Allow preparation failures to retry within the existing upload popup.
6. [ ] Show the decrypted image when downloading an image whose thumbnail was omitted.
