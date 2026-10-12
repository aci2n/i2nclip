# Browser service ownership

Web pages connect to the named SharedWorker; extension pages connect to the
background context. Both host the same engine and message protocol. These are
independent scopes, not a website/extension bridge. The CLI remains file based.

Each scope contains a local catalog of named libraries. The transport owner routes
commands by `libraryId` into a separate library runtime. Identities, epochs,
searches, metadata, downloads and pairing are isolated by library; one global
scheduler admits sequential uploads. A tab's selector is page-owned and preserved
in its URL. Switching does not invalidate the selected library's accepted jobs.

Each client scope has one master password and one encrypted local vault. The
`i2nclip-vault` IndexedDB database (version 1, `vault` store) holds a password-wrapped
random vault key, an encrypted catalog/job manifest, and separately encrypted
binary sources. Names, servers, completed identities and uploads are
encrypted at rest. Only cryptographic parameters and opaque record identifiers
remain outside encryption. The greenfield schema does not migrate former databases
or accept the former recovery format; reset development storage for this version.

Unlock initializes every library runtime only after all identities validate.
Locked snapshots expose only vault status and empty library collections. Lock is
immediate across tabs: it cancels work, disposes runtimes, clears decrypted state
and invalidates queued commands. Restart always requires the master password.
Password changes atomically re-wrap the vault key without rewriting stored data.
There is no idle timeout. Web and extension vaults remain independent.

| State | Owner | Lifetime |
| --- | --- | --- |
| Names, servers, completed identities | Service | Encrypted IndexedDB |
| Submitted setup, generated key and registration | Service, per connection | Temporary owner memory |
| Unlocked private key, epoch, cancellation | Service | Memory only |
| Upload jobs, unfinished sources, retries | Service | Encrypted IndexedDB |
| Upload progress, pairing, media metadata/mutations | Service | Memory |
| Submitted searches and pagination | Service, per view | Connection |
| Decrypted content | Service during request; page after reply | Memory |
| Navigation, setup mode, form/search/tag drafts | Page | UI |
| Password inputs and selected recovery file | Page | UI; command payload only |
| Playback, modal selection, focus, object URLs | Page | UI |
| Source-frame fetch controllers | Extension adapter | Request |
| Pairing crypto adapter | Service | Pairing attempt |

The client interface is `ready`, `command(name, payload)`, `subscribe(listener)`,
and `dispose()`. Commands are requests, never direct access to service storage or
credentials. Each connection receives an initial snapshot and ordered events.
Unlocked snapshots contain vault status, the completed-library catalog, per-library session, upload, pairing, media and view state, and a sanitized `setup` belonging only to the requesting connection. Empty catalogs have no saved placeholders.
Content and recovery files are unicast replies. Passwords and private keys are
never part of snapshots. The UI uses `unlocked`, not a private-key flag.

Messages carry a service instance ID, connection sequence and request ID. Epochs
guard identity-dependent work. Gaps trigger resynchronization; reconnect rejects
uncertain commands rather than replaying them. Accepted uploads survive page
closure, but owners can stop. Restart locks the identity, marks active transfers
interrupted and requires explicit recovery of retained jobs. An interrupted
transfer may already have reached the server.

IndexedDB transactions contain only database operations and acknowledge commit,
not individual request success. Upload source blobs and metadata are encrypted in
the local database until completion/discard. Source encryption preserves binary
bytes without JSON/base64 expansion. Encryption finishes before an atomic
transaction commits catalog and source changes.
Forgetting a library and successful server changes discard only its sources.
Reset atomically deletes the vault header, catalog and sources.

One sequential queue accepts uploads from all libraries and pages. Vault locking stops every library; normal identity changes affect only their library. Images/audio use worker-safe
thumbnail generation. Web video thumbnails are optional helpers in the submitting
page; originals are accepted first. Extension video preparation runs in background.

Searches remain independent. Canonical metadata changes broadcast to every client. Successful tag edits reconcile each submitted query in memory, preserving cursor/order and avoiding list requests. Per-query membership overrides protect against older list responses; conflicts publish authoritative metadata and preserve the inline draft/card membership until review or explicit search. Object URLs, playback and save
dialogs remain local and are disposed on invalidation. Sender pairing state and controls are shared by saved-library clients. Closing a sender page leaves its pairing running in the service; explicit cancellation, expiry, identity changes or owner shutdown end it. Temporary receiver pairing belongs to its initiating connection and ends with setup disposal.

Web uses a stable worker URL/name. Explicit detach plus five-second heartbeats
and a thirty-second connection lease clean up vanished or suspended pages.
Reconnecting pages receive a fresh snapshot. Extension ports provide disconnect
events. Neither transport grants an independent page authority over state.

## Commands and replies

All identity-dependent commands carry a library ID, observed epoch and runtime
instance. Catalog commands rename or forget saved entries. Setup actions carry an owner-issued `setupId`, scoped to the submitting connection and vault epoch. `vault.export` and
`media.content` return a Blob (content also returns optional audio art); neither
broadcasts binary content. Mutation errors have `name` and `message` and follow a
fresh snapshot. The shared JSDoc wire types are in `service/contract.js`.

| Command family | Payload / result |
| --- | --- |
| `vault.initialize`, `unlock`, `lock` | master password or no arguments; shared vault transition |
| `vault.changePassword` | current/new master passwords; atomic wrapper update |
| `vault.export` | recovery password and optional library ID; encrypted recovery Blob |
| `vault.previewRecovery`, `importRecovery` | recovery Blob/password; names/servers preview or imported IDs/skipped count |
| `vault.reset` | no arguments; delete all local vault data |
| `vault.contextUpload` | transient request ID and destination library; accept retained request |
| `identity.create` | setup ID, invitation or authorizer ID; `{ outcome: "saved", libraryId }` after durable save |
| `identity.setServer`, `reset` | new URL or no arguments; success |
| `setup.open`, `close` | name, method, server/authorizer or no arguments; temporary owner session ID / disposal |
| `view.open`, `close`, `search`, `more` | view ID and optional submitted query |
| `media.content`, `remove` | media ID; verified content or success |
| `media.retag` | media ID, tags and observed metadata hash; success/conflict |
| `uploads.submit` | source Blob/name records; accepted IDs and per-file failures |
| `uploads.retry`, `discard` | job IDs; success |
| `pending.get`, `send` | job ID and optional tags; source preview or acceptance |
| `pairing.send`, `receive` | no arguments, or entered code/server |
| `pairing.approve`, `rejectVerification`, `cancel` | shared service controls |
| `snapshot` | resynchronize all shared state and the requesting client's views |

The stable `/assets/web-worker.js` entry revalidates instead of
using immutable caching. Hashed page assets retain their existing cache policy;
no API or server database changes are needed.

Additional libraries can be created using an unlocked authorizing library on the
same server. The authenticated registration endpoint signs the new public-key
JSON with the existing library's key. No key or file access is shared between
these independent libraries by registration. Pairing receives into a temporary owner runtime, resolves a saved destination or commits one completed identity, then acknowledges using that destination's guarded identity context. Completion replies contain `{ outcome: "saved" | "existing", libraryId }`; a lost acknowledgment adds `confirmation: "uncertain"`. Only the receiver page selects the destination after the reply. Setup is disposed after the reply settles.

Form state lives in the page. Closing Add Library, leaving Settings, changing selection, locking/resetting, or disconnecting ends unfinished setup and clears its fields. Owner resources are allocated lazily with `setup.open`; generated registration keys never enter durable storage before server success. Registration rejection retains no key, and a new submission generates a fresh one. Lost replies and final local commit failures report that the invitation may have been used and require a fresh invitation/restart. There is no saved retry key, resume or discard-pending flow. Server registration and local storage cannot be atomic.

Final commits recheck name uniqueness, vault epoch and attempt ownership. Authorization uses the selected saved runtime's server and identity guard. Network pairing and approval do not hold the engine's catalog queue. Unlock removes old unfinished rows and their encrypted sources atomically, preserves completed identities while clearing obsolete setup markers, and publishes only after cleanup and validation succeed.

Unlocked extension context menus list named library destinations. While locked,
generic upload actions open unlock and retain only an in-memory source request.
The user selects a destination after unlocking; fetching and persistence start
then. These transient requests do not survive owner restart. Jobs permanently retain
that destination, and upload windows resolve their library from the job ID.

Pairing executes the single `createPairingCrypto` implementation directly in the
service. There are no nested workers or client crypto helpers. Each attempt owns
a separate executor; disposal clears its secrets and rejects unfinished calls.

## Recovery

Individual-library and whole-vault exports share encrypted recovery format v2.
A separately chosen recovery password protects the manifest, including names,
servers and identities. Whole-vault exports contain registered libraries only;
they exclude unfinished registrations, uploads, media caches and UI preferences.
Imports preview names/servers and atomically merge libraries, skipping matching
server/public-key identities and suffixing name conflicts. Imported data uses the
destination vault's existing master password. Changing that password does not
change old recovery files. The CLI consumes individual-library exports only.
