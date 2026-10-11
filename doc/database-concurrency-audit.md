# Database concurrency audit — 2026-10-11

All production SQL is in `src/db.rs` and `sql/001_init.sql`. Authentication,
routes, maintenance, examples, and database/API tests were also inspected to
identify callers, transaction boundaries, and every competing writer.

The current application invariants do not require REPEATABLE READ or
SERIALIZABLE. Leave PostgreSQL's default READ COMMITTED unchanged; no session,
database, or per-operation isolation setting was added. PostgreSQL implements
READ UNCOMMITTED with the same behavior as READ COMMITTED.

One startup race was fixed: simultaneous initial schema creation is now guarded
by a database-local transaction advisory lock. Request mutations already use
unique constraints, parent-row locks, and atomic transactions appropriately.

This conclusion applies to application queries at the default isolation level.
It is not a guarantee about arbitrary SQL writers that bypass the application's
locking protocol or deployments that override the database/role isolation default.

## PostgreSQL guarantees used

An ordinary SELECT reads a statement snapshot, including its correlated
subqueries. Separate SELECT statements can see different committed versions.
UPDATE, DELETE, and SELECT FOR UPDATE wait for conflicting writers, then
recheck the target row after a preceding writer commits. A locked row remains
protected until the transaction ends. Unique constraints also resolve conflicts
with inserts that were not visible in the inserting statement's snapshot.
These rules support the reasoning below. See PostgreSQL's
[transaction isolation documentation](https://www.postgresql.org/docs/current/transaction-iso.html)
and [explicit locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html).

## Query-by-query review

### 1. Initialization: advisory lock and initial schema

`initialize` starts a transaction, takes
`pg_advisory_xact_lock(1764904547, 1)`, executes the initial schema, and commits.
The two integers reserve the application's startup lock; they must remain the
same across server instances. It is local to the connected database and is
released on commit or rollback, including connection failure.

Without this lock, two servers could independently observe that a table/index
does not exist, then both attempt catalog creation. IF NOT EXISTS is not a
cross-session mutex. Concurrent CREATE OR REPLACE FUNCTION/TRIGGER also needs
startup ordering. The new lock serializes the entire schema operation before
any DDL executes. Stronger snapshot isolation would not replace that ordering.

Each CREATE TABLE establishes a primary key: registered public key, invitation
hash, content hash, file/tag pair, and nonce. These are the actual uniqueness
arbiters used by competing writes. The tags foreign key cascades parent
deletion atomically. Expiration and owner/cursor indexes affect access paths,
not consistency. ALTER COLUMN SET STORAGE changes storage policy, not values.
The immutable-content trigger compares OLD/NEW in the updating statement and
rejects content changes; concurrent updates already contend on the file row.

Reinitialization does not erase data. DDL can temporarily block requests from
an already-running instance; the advisory lock only coordinates initializers,
while PostgreSQL's normal DDL locks coordinate table access. External schema
tools must participate in the startup lock if they need the same ordering.

### 2. Authorization: SELECT EXISTS on registered_keys

`allowed` reads one snapshot. A registration committing after the snapshot can
produce a temporary unauthorized response; retry sees the registration.
Registered keys are only inserted by production code, never revoked/deleted,
so an authorization success cannot become invalid between this query and the
subsequent nonce reservation or media operation through another application
query. No read-then-write authorization race exists under that lifecycle.
Adding revocation would require reviewing the complete authenticated workflow;
changing this SELECT's isolation alone would not enforce immediate revocation.

### 3. Nonce reservation: INSERT ON CONFLICT DO NOTHING

`remember_nonce` does not perform a preliminary existence check. The nonce
primary key arbitrates concurrent attempts: a contender waits for an
uncommitted reservation, then rejects if it commits, or inserts if it rolls
back. Exactly one reservation succeeds while the row remains present.
Zero affected rows is intentionally a replay rejection, even when the
conflicting insert was outside the statement's visible snapshot.

Against maintenance, a reservation may wait for deletion and subsequently
insert after cleanup commits. The authentication caller therefore checks the
signed timestamp again after reservation; this existing check is essential
to reject a delayed replay whose earlier nonce was already expired/pruned.
Cleanup uses `expires < now`, retaining the nonce at the inclusive acceptance
boundary. Reservation commits independently of the media operation: a bad
body or failed media mutation still spends the nonce by design. Reusing the
same nonce after retention ends is not prevented indefinitely.

### 4. Invitation issuance: INSERT registration_codes

`issue_code` inserts a newly generated secret's hash directly. Concurrent
issuers with different hashes do not interact. An identical generated hash
fails its primary key rather than overwriting another invitation. The secret
is returned only after the autocommit statement succeeds. Maintenance can
remove a newly issued invitation if its expiration qualifies, including a
zero TTL; that is expiration semantics, not partial issuance.

### 5. Invitation consumption: DELETE, then INSERT registered_keys

The DELETE identifies one hash and checks its expiration. Two consumers of
the same code contend on that row. If the first commits, the second finds no
remaining row and fails; if the first rolls back, the second can consume it.
The subsequent key insertion and code deletion commit together, so a failed
registration does not spend the code.

The key insert uses ON CONFLICT DO NOTHING. Different valid codes registering
the same public key may both be consumed successfully, with one registered
key. This preserves the documented idempotent registration policy. No query
requires knowing which transaction inserted that key.

Maintenance contends on the same code row. A successful cleanup prevents a
waiting consumer from consuming it; a successful consumption leaves nothing
for cleanup. A rolled-back cleanup leaves it available if its expiry predicate
passes. The production application never changes an invitation's expiration.
The expiration cutoff is sampled before the DELETE, so a request that waits
can finish after its code's wall-clock expiry; it was evaluated against the
sampled cutoff. This is not an isolation anomaly. Strict validity at completion
would be a separate time-policy requirement, not a reason for SERIALIZABLE.

### 6. Upload: INSERT files, DELETE tags, bulk INSERT tags

`add` inserts the content-hash identifier with ON CONFLICT DO NOTHING. Competing
uploads of identical sealed content, including different owners, have one
winner. The loser never replaces the winning owner's content, metadata, or
tags. Failure/rollback of the first insert permits a waiting insert to win.
Different content hashes proceed independently.

The new file and all tags share one transaction. Listings/downloads cannot
observe a committed file without its committed tag set; a tag failure or even
a deferred commit failure rolls everything back. An update/delete starting
before the new file commits can report NotFound, because it cannot see that
uncommitted insert; these overlapping operations can be ordered before upload.

A same-hash upload waiting for deletion may succeed after deletion commits.
That is a permitted recreation, with ownership determined by the new insert.
The id is a content identity, not a never-reusable generation identifier.

### 7. Listing: SELECT files with two correlated tag subqueries

The outer rows, ARRAY of sorted tags, and AND-search count use one statement
snapshot. A concurrent upload/update/delete therefore appears entirely before
or after its commit in this listing. The query cannot return new metadata with
old tags or filter on one tag version while returning another. It uses no
read results to make a later mutation decision.

Cursor ordering uses creation time descending and hash ascending; creation
time and id are not changed by production updates. Concurrent tag edits can
change search membership, and inserts/deletions can change later pages.
Each page is consistent, but the entire multi-request traversal is not a
frozen snapshot. REPEATABLE READ on a single page would not change that.
A frozen traversal would require a snapshot/materialized-result API spanning
requests. Search input is deduplicated before the count/cardinality comparison.

### 8. Download: SELECT content by owner and id

This single SELECT sees a committed file or NotFound. Content is immutable.
Concurrent metadata replacement cannot change its bytes. Deletion after the
snapshot does not invalidate the owned bytes returned to the caller; an
already-started download can complete after deletion. A delete/reinsert
sequence yields the version visible to the statement, and the owner predicate
is evaluated on that version. No connection remains held while streaming the
response. No stronger transaction level is needed.

### 9. Metadata update: SELECT FOR UPDATE, optional SELECT tags, UPDATE files

`update_meta` locks the owner-authorized file before comparing the supplied
previous-metadata hash. If two edits use the same previous hash and replace it
with different metadata, the first succeeds; the waiting edit receives the
first edit's committed metadata and fails the comparison. It cannot silently
overwrite that edit. The comparison must remain inside the locked transaction.

On conflict, the separate tag SELECT uses a fresh READ COMMITTED snapshot.
It sees the preceding writer's committed tags, and the held file lock prevents
another production writer from replacing them or deleting their parent before
the conflict response is assembled. This is why a naive single-statement
locking query with a tag subquery would be risky: the lock may return a newer
file version while the subquery retains the original statement snapshot.

On success, UPDATE files and tag replacement retain the parent lock through
commit. The repeated owner predicate is safe; the parent cannot disappear or
change owner while held. Rollback preserves the complete earlier version.
Different files can be edited independently. An edit that reproduces identical
metadata does not advance its hash; this is value-based optimistic concurrency,
not a monotonic revision counter. Arbitrary SQL changing only tags bypasses
that protocol and is outside the application writer set.

If deletion locks first and commits, a waiting edit returns NotFound; rollback
allows the edit to proceed. If the edit locks first, deletion waits for the
edit to finish, then may delete the updated file. A successful edit response
does not promise the file survives a later deletion. Deletion and recreation
do not give a waiting edit authority over a newly inserted owner: its locking
SELECT handles the originally visible tuple, and it can instead return
NotFound. No row generation guarantee is part of the API.

### 10. Shared tag replacement: DELETE tags, bulk INSERT tokens

`replace_tokens` is private. Production callers are only `add` and
`update_meta`; they respectively own an uncommitted newly inserted parent or
hold its FOR UPDATE lock. This parent ownership serializes all tag writers,
even when there are currently no tags to lock. Locking existing tags alone
would not protect the empty-set case. The tag primary key prevents duplicate
file/token pairs, and the foreign key prevents orphan tags.

The DELETE and bulk INSERT must stay in that same transaction and
behind the parent lock. A failed INSERT rolls back the DELETE and file change.
The foreign key alone does not prevent lost replacements between independent
tag writers; any new caller must follow this parent locking convention.

Tag insertion binds one text array and uses `unnest`, so both uploads and
metadata edits use one INSERT regardless of tag count. The successful metadata
edit path has four data queries (three for upload), excluding BEGIN/COMMIT.
An empty array inserts no rows and still clears the old set. The query audit
found no other production loop issuing one query per element. Test fixture
seeding loops and diagnostic/reconnection polling remain test tooling.

### 11. Removal: DELETE files by id and owner

Two removals contend on the parent: after a committed first deletion, the
second reports NotFound; after rollback, the second may succeed. Removal vs
metadata editing follows the parent-lock ordering described above. The
foreign-key cascade removes tags in the same statement transaction; readers
see the old complete item or its absence, never committed orphan tags.
Concurrent uploads that are not yet committed need not be visible to this
DELETE. Recreation after deletion is allowed by the content-id policy.

### 12. Maintenance: DELETE expired nonces, DELETE expired codes

Both statements share a transaction, but use separate READ COMMITTED snapshots.
This is sufficient because there is no cross-table invariant linking a nonce
to an invitation. Concurrent sweeps may divide their affected-row counts; a
sweep may miss rows inserted after its statement begins. Those rows can be
handled by a later sweep. There is no requirement to remove every qualifying
row at one globally consistent instant.

Deletion contends with reservation/consumption as described above. The nonce
and invitation cutoffs deliberately differ: nonce validity includes its
boundary, invitation validity excludes its boundary. Any second-statement or
commit failure rolls back both deletions. The maintenance task awaits each
sweep and finishes its active transaction before shutdown. Multiple servers
may sweep concurrently; bulk deletions can encounter database errors/deadlocks,
which abort a transaction rather than corrupt data. The task logs failure and
retries on its next interval; this audit does not claim deadlock-free execution.

## Stronger isolation assessment

No current workflow makes a write conditional on an unlocked aggregate or an
absence predicate across multiple independently mutable rows. Uniqueness is
handled by constraints, same-file mutations by a parent-row lock, and mixed
file/tag reads by a single statement or a locked parent with a subsequent read.
There is consequently no established write-skew or lost-update invariant that
requires SERIALIZABLE. REPEATABLE READ is also unnecessary: the only multi-read
item workflow already prevents competing writes, and needs a fresh tag snapshot
after waiting for a preceding writer.

Raising either level would introduce serialization-failure paths requiring
whole-transaction retries. The application currently does not implement those
retries. It would not replace unique keys, optimistic metadata validation, the
startup mutex, or cross-request snapshot design. Reassess if adding quotas,
cross-file invariants, revocation, or independent tag mutations.

## Test and example SQL

Fixture CREATE/DROP DATABASE statements own isolated test databases. FORCE
drop is intentional fixture teardown, not a production concurrent mutation.
The browser helper's UPDATE of invitation expiry deliberately changes test
state; concurrent consumption rechecks the expiry predicate after that update.
Its pg_stat_activity inspection is a diagnostic sample, not synchronization.

Restart probes CREATE/INSERT/SELECT/DROP an isolated probe table sequentially;
their SELECT owns returned bytes and is retried while the server restarts.
Test-only pg_terminate_backend deliberately interrupts pool connections.
Test SQL also seeds rows, injects trigger failures, attempts forbidden content
updates, counts committed results, and holds table/row locks to force overlap.
These are fixtures/assertions, not alternate production write paths. Monitor
queries used to observe waiting test operations run outside the blocked
transaction so their activity snapshots refresh. Tests that change schema or
data are isolated from other tests by a dedicated database.

## Verification

New regressions force overlap rather than relying only on scheduling:

- Two initializers wait on the startup lock before any tables exist; subsequent
  simultaneous reinitialization preserves a reserved nonce.
- A stale metadata edit waits behind a writer and receives matching committed
  metadata/tags; listings before/after commit see complete versions.
- Two queued metadata replacements using the same previous hash have exactly
  one successful update and one conflict containing the winner's item.
- A queued metadata edit behind a committed deletion returns NotFound, leaving
  neither a file nor orphan tags.

Existing tests cover concurrent nonce reservation, invitation consumption,
same-hash uploads through independent routers, rollback of registration/upload/
metadata/cleanup writes, expiry boundaries, download lifetime after deletion,
and authentication's post-reservation timestamp recheck.

The bulk-insert regression additionally covers uploading 32 tags, replacing
them with a disjoint 32-tag set, searching both sets, and clearing all tags.

Final checks passed:

- `make test-db`: 33 unit/database tests, 3 configuration tests, and 23 API tests;
  the existing optional maximum-size transfer profile remains ignored.
- `make test` under Node 22.23.3: 23 client test files, Svelte checker with zero
  errors/warnings, 19 Rust unit tests, and 3 configuration tests.
- `cargo clippy --all-targets --all-features -- -D warnings`, Rust formatting,
  and `git diff --check`.
