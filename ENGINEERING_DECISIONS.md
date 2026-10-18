# Engineering Decisions

## 1. Optimistic concurrency + conditional updates
**Context:** users edit stale copies; two users claim the same item.
**Choice:** every item has `version`. Edits send the version and run `UPDATE ... WHERE id=? AND version=?`; 0 rows -> `409` with the current item. Claim uses `WHERE assignee_id IS NULL`, so exactly one claim wins without locks.
**Trade-off:** losers must retry (UI shows a conflict banner and reloads). Chosen over pessimistic locks, which leak when a tab is closed.

## 2. Mutation + history in one transaction
Every change writes its `activity` row (and outbox row) inside the same DB transaction, so history can never disagree with the item. Activity is append-only; no update/delete endpoint exists.

## 3. Idempotency keys
The client sends `Idempotency-Key` on each POST. The key and response are stored in the same transaction as the change; a repeat returns the stored response (`Idempotent-Replay: true`) with no second side-effect. Failed requests are rolled back and not stored, so retrying them is safe.
Each key stores a fingerprint of method + URL + body hash, so reusing a key for a *different* request returns 422 instead of a wrong replay. Keys expire after 24h (cleaned by the worker).

## 4. Authorization at resource level, single gate
`loadItem(user, id, minRole)` is used by every item endpoint and checks team membership + role. Non-members get 404 (existence not leaked); members with too low a role get 403. List queries are scoped to the user's teams in SQL. Workflow transitions carry a required role (only LEAD approves). The UI hides buttons, but the server is the authority.

## 5. Sync core, async side effects (transactional outbox)
Notifications are written to an `outbox` table in the same transaction and processed by a worker with retries, exponential backoff, a max of 5 attempts, and an idempotent handler (`dedupe_key` unique), so at-least-once delivery yields exactly one notification.

## 6. SQLite now, PostgreSQL later
**Context:** one-day delivery and a reviewer who must run it in one command.
**Choice:** SQLite (WAL, FTS5) so `npm install && npm start` works anywhere. All correctness rules live in SQL conditional updates and transactions, not in application memory, so they carry to PostgreSQL unchanged (`SELECT ... FOR UPDATE` is not even required).
**Trade-off:** single writer limits write throughput; at the stated scale I would move to PostgreSQL with `tsvector` search and run the worker separately.

## Scale / search choices
Server-side filtering, keyset (cursor) pagination on `id`, indexes on team/status, assignee and priority, FTS5 for title search (no table scans from `LIKE '%x%'`); the browser never loads the full dataset.

## Intentionally not built
Websockets, SSO/session expiry, attachments, email delivery.
**With more time:** PostgreSQL, activity partitioning, idempotency-key TTL, SSE for live updates.
