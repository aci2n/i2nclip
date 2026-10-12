# Browser service ownership

Web pages connect to the named SharedWorker; extension pages connect to the
background context. Both host the same engine and message protocol. These are
independent scopes, not a website/extension bridge. The CLI remains file based.

| State | Owner | Lifetime |
| --- | --- | --- |
| Server, wrapped identity, pending registration | Service | IndexedDB |
| Unlocked private key, epoch, cancellation | Service | Memory only |
| Upload jobs, unfinished sources, retries | Service | IndexedDB |
| Upload progress, pairing, media metadata/mutations | Service | Memory |
| Submitted searches and pagination | Service, per view | Connection |
| Decrypted content | Service during request; page after reply | Memory |
| Navigation, setup mode, form/search/tag drafts | Page | UI |
| Password inputs and selected recovery file | Page | UI; command payload only |
| Playback, modal selection, focus, object URLs | Page | UI |
| Source-frame fetch controllers | Extension adapter | Request |
| Pairing crypto worker | Service | Pairing attempt |

The client interface is `ready`, `command(name, payload)`, `subscribe(listener)`,
and `dispose()`. Commands are requests, never direct access to service storage or
credentials. Each connection receives an initial snapshot and ordered events.
Snapshots contain session, upload, pairing, media and that client's view state.
Content and recovery files are unicast replies. Passwords and private keys are
never part of snapshots. The UI uses `unlocked`, not a private-key flag.

Messages carry a service instance ID, connection sequence and request ID. Epochs
guard identity-dependent work. Gaps trigger resynchronization; reconnect rejects
uncertain commands rather than replaying them. Accepted uploads survive page
closure, but owners can stop. Restart locks the identity, marks active transfers
interrupted and requires explicit recovery of retained jobs. An interrupted
transfer may already have reached the server.

IndexedDB transactions contain only database operations and acknowledge commit,
not individual request success. Upload source blobs are retained unencrypted in
the local database until completion/discard; library plaintext is not persisted.
Reset and successful server changes discard old upload sources.

One sequential queue accepts uploads from all pages. Images/audio use worker-safe
thumbnail generation. Web video thumbnails are optional helpers in the submitting
page; originals are accepted first. Extension video preparation runs in background.

Searches remain independent. Canonical media changes broadcast to every client;
affected searches refresh from their first page. Object URLs, playback and save
dialogs remain local and are disposed on invalidation. Pairing state and controls
are shared by all clients. Closing a page leaves pairing running in the service;
explicit cancellation, expiry, identity changes or owner shutdown end it.

Web uses a stable worker URL/name. Explicit detach plus five-second heartbeats
and a thirty-second connection lease clean up vanished or suspended pages.
Reconnecting pages receive a fresh snapshot. Extension ports provide disconnect
events. Neither transport grants an independent page authority over state.

## Commands and replies

All identity-dependent commands carry the observed epoch. `identity.backup` and
`media.content` return a Blob (content also returns optional audio art); neither
broadcasts binary content. Mutation errors have `name` and `message` and follow a
fresh snapshot. The shared JSDoc wire types are in `service/contract.js`.

| Command family | Payload / result |
| --- | --- |
| `identity.create` | server URL, password, invitation; success after durable save |
| `identity.restore`, `unlock` | recovery Blob/password or password; success |
| `identity.setServer`, `reset`, `discardCreation` | new URL or no arguments; success |
| `identity.backup` | no arguments; encrypted recovery Blob |
| `view.open`, `close`, `search`, `more` | view ID and optional submitted query |
| `media.content`, `remove` | media ID; verified content or success |
| `media.retag` | media ID, tags and observed metadata hash; success/conflict |
| `uploads.submit` | source Blob/name records; accepted IDs and per-file failures |
| `uploads.retry`, `discard` | job IDs; success |
| `pending.get`, `send` | job ID and optional tags; source preview or acceptance |
| `pairing.send`, `receive` | no arguments, or entered code/password/server |
| `pairing.approve`, `rejectVerification`, `cancel` | shared service controls |
| `snapshot` | resynchronize all shared state and the requesting client's views |

The stable `/assets/web-worker.js` and crypto-worker entry revalidate instead of
using immutable caching. Hashed page assets retain their existing cache policy;
no API or server database changes are needed.
