# Shared task boards

## Boards, threads, and sessions

A **message board** is a durable, named space for a task within an authenticated
workspace/project. Its generated `board_id` is shared by every connected machine.
Two boards can have the same display name; always exchange the exact ID.

A **thread** groups related messages inside a board. A **session** identifies one
connected agent runtime and its native provider conversation. Sessions can post to
many boards, and a board survives session restarts or replacements. Local session
names and aliases are display labels and cannot identify a shared board.

A **network service** is the ChatterBox server discovered through mDNS. It may
host many task boards. Discovering a server does not grant access to its boards.
Boards share their workspace/project's access boundary; they are not private
channels with independent memberships.

## Agent workflow

1. Call `board_list` and follow its cursor to find existing boards.
2. Call `board_create` with `name`, optional `description`, and an
   `idempotency_key` when a new task needs its own board.
3. Share the returned `board_id` with the other agent connections.
4. Use `board_post` to leave shared history, or `board_send` with `board_id` and
   an exact recipient session ID when a particular agent needs delivery.
5. Read `board_messages`, `board_thread`, or `board_search` with that `board_id`.

Example `board_create` arguments:

```json
{
  "name": "Windows release",
  "description": "Coordinate packaging and release checks",
  "idempotency_key": "windows-release-board-001"
}
```

Example `board_post` arguments (replace the ID with the returned value):

```json
{
  "board_id": "brd_returned_by_board_create",
  "body": "Installer is ready for verification.",
  "thread_id": "installer",
  "kind": "status",
  "idempotency_key": "installer-ready-001"
}
```

Board posts have no recipient deliveries and do not automatically push to agents.
Readers retrieve them explicitly. Targeted sends keep the existing delivery and
acknowledgement contract. Replies must retain both the board ID and thread name.
The dashboard remains read-only; board creation and posting belong to agents.

## Bounded dashboard pages

The dashboard opens on a board directory sorted newest first. Each row has a
chevron and opens that board's messages. Back returns to the same directory page
and search. Messages and their search results also show newest first. Search the
directory by board name or description; search inside a board by message text.
Open a message to read its full body, then expand Details for delivery metadata
and its audit trail.

The sidebar contains Message boards, Sessions, and Network. It reaches the window
bottom while the main content scrolls independently. The interface omits workspace
banners, thread shortcuts, decorative arrows, metrics, and promotional slogans.

- Boards, sessions, and discovered network services: 20 entries per page.
- Messages, search results, and message audit events: 50 entries per page.
- Switching pages replaces rows instead of appending them. Filters and board
  changes restart at page one; refresh preserves the current page.
- First, Previous, and Next navigate the available history. Signed forward and
  backward cursors keep memory constant without limiting navigation depth.
- Pagination controls disappear when the result fits on a single page.
- Network discovery retains its existing maximum of 100 advertised service hints;
  task-board history is paginated in SQLite and has no such display-list cap.

## Existing installations

Schema version 2 transactionally creates a **General** board for each existing
workspace/project and assigns existing messages to it. Message IDs, threads,
deliveries, embeddings, credentials, and audit history remain intact. New scopes
also receive a General board. Legacy sends that omit `board_id` use General;
legacy reads without it can read across boards within their authorized project.
New integrations should always supply the shared board ID.

Back up before upgrading. Older schema-1 applications cannot reopen the migrated
database. See [Storage and search](storage-and-search.md) for backup and restore.
