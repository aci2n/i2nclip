# Client session ownership

The web app admits one tab per origin with a lifetime Web Lock before reading saved state or creating application stores. Other tabs show an explicit retry screen. Pagehide disposes workflows before releasing admission; restored pages reacquire admission and start fresh locked sessions.

The root application view owns one session, library, and pairing store across navigation. Views subscribe and pass plain values and callback props to isolated components. Components may own presentation state but cannot access stores.

The session owns the decrypted identity, encryption key through its persistence helper, and cancellation generation. Locking, forgetting, replacement, resetting, and disposal invalidate workflows. Session mutations reject overlap. Stores invoke the API directly.

Only the encrypted identity, server URL, and password derivation material are persisted in one atomic localStorage record. A failed write preserves the previous record and identity. Recovery independently encrypts one identity and is validated before saving. There are no migrations.

The root library store owns searches; a separate root uploads store owns sequential batches across navigation and refreshes the submitted search after completion. Cancellation and revision checks suppress stale searches. Pagination uses the submitted query and permits one request at a time. Only failure messages remain; users select failed files again through Upload; reloading or changing the identity discards all transient upload state.

Media items own bytes, requests, URLs, and mutation busy state. Disposal aborts requests and revokes URLs. Late results cannot create previews or save dialogs. Metadata conflicts refresh the server tags while the editor retains failed drafts for retry.

Pairing owns one isolated attempt. It compares verification codes and saves the receiver's encrypted identity before acknowledgment. Closing or locking the page ends the attempt.
