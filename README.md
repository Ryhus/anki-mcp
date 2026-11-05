# Anki MCP Server

An MCP server that exposes Anki operations to MCP-compatible clients. It
communicates with Anki through an AnkiConnect-compatible HTTP API and uses
standard input/output (`stdio`) as its MCP transport.

## Requirements

- Node.js 24.15.0, as specified in `.nvmrc`
- npm
- Anki running with an AnkiConnect-compatible API available

If you use `nvm`, select the project Node.js version with:

```bash
nvm install
nvm use
```

## Installation

Install the project dependencies from the repository root:

```bash
npm install
```

## Environment configuration

Create a `.env` file in the repository root:

```dotenv
ANKI_URL=http://127.0.0.1:8765

# Optional: use AnkiConnect API v1 for all tools (default: legacy).
# ANKI_API_MODE=v1

# Optional: queue wait + full AnkiConnect HTTP request deadline (milliseconds)
# ANKI_REQUEST_TIMEOUT_MS=30000

# Optional: ":"-separated on macOS/Linux and ";"-separated on Windows
# ANKI_MEDIA_IMPORT_DIRS=/absolute/path/to/media
```

`ANKI_URL` must point directly to the HTTP(S) endpoint exposed by AnkiConnect,
without embedded URL credentials. API redirects are not followed. The example
uses its usual local address; change it if your AnkiConnect instance uses a
different host or port.

`ANKI_API_MODE=v1` runs all tools through
[AnkiConnect API v1](https://git.sr.ht/~foosoft/anki-connect/blob/master/API_V1.md).
Keep `ANKI_URL` at the base endpoint, without `/api/v1`; the server appends
that path for JSON-RPC calls. Set the variable in the MCP client's
environment or in `.env`, then restart the MCP server. The root legacy
endpoint is not needed in v1 mode. Without the variable, the default
`legacy` mode continues to use version 6 for older add-ons.

In v1 mode, multi-step tools pin native requests to one collection session
per invocation. Session checks stop subsequent steps after a profile switch;
they do not roll back a previously completed step. A v1 failure never
triggers a legacy fallback or a write retry. MCP tool names and numeric IDs
are unchanged; out-of-range upstream IDs are rejected rather than rounded.
Both modes share the same request limiter and timeout. If the installed
add-on does not serve v1, upgrade AnkiConnect or select `legacy` explicitly.

`ANKI_REQUEST_TIMEOUT_MS` is optional and defaults to **30,000 ms (30 seconds)**.
It must be an integer from 1 to 300,000 ms; `0` does not disable the deadline.
The deadline includes waiting for a request slot, connecting, waiting for
headers, and loading the JSON response body. It is not restarted when a slot
becomes available. As with other JavaScript timers, it cannot interrupt
synchronous CPU work while the event loop is blocked. Each AnkiConnect HTTP
request gets its own deadline: a tool that makes several requests can take longer overall. A
`multi` batch in legacy mode shares one HTTP deadline. In v1 mode, internal
read groups run as separate native requests in one session. Neither is a
transaction. Set the
MCP client's tool timeout accordingly; the client may stop waiting sooner.
This setting does not change the separate timeout for public HTTPS media downloads.

All AnkiConnect HTTP calls in one Node.js process share a **four-request
concurrency limit**, including calls from different tools or server factories.
Excess requests wait in FIFO order; a legacy `multi` batch uses one slot for
its entire HTTP exchange. A slot remains held through body loading, then is
returned on completion/failure or explicit transport abort. Timed-out and
cancelled waiters are removed and never sent later. No extra tool parameters
or dependencies are required, and the limit is fixed in this release.
Cancellation here refers to a low-level request `signal`; MCP client
cancellation is not automatically forwarded to that signal.

If the deadline/cancellation occurs before sending, `AnkiRequestError` has
`mayHaveExecuted: false` and the message states that no HTTP request was sent.
After sending, the outcome may be unknown. This is a client-side limit, not a
limit on Anki's background work or on other apps/processes connecting to Anki.
Socket cleanup may be asynchronous; an adapter that ignores abort can finish
late, but its response is discarded. A broken adapter cannot keep a slot
forever after the client's deadline. The queue does not serialize entire MCP
tools, create transactions, or prevent interleaving of multi-step operations.

Requests are **never automatically retried**. A timeout, cancellation, or bad
response after sending does not prove that an operation failed: Anki may have
already changed data. Stopping HTTP does not cancel/roll back work inside Anki.
Inspect the current state before retrying any mutation; obtain a fresh preview
and hash where the tool requires them.

`ANKI_MEDIA_IMPORT_DIRS` is optional. When set, `store-media-file` accepts
`localPath` sources only when their resolved path is inside one of these
directories. Local file imports are disabled when the variable is omitted.
Base64 and public HTTPS sources do not require it.

## Development commands

### Start the development server

```bash
npm run dev
```

Runs the source entry point with `tsx` and watches the project for changes.
The server is restarted automatically after a source file changes.

### Check TypeScript types

```bash
npm run typecheck
```

Runs the TypeScript compiler without generating output. It checks both the
application source and the tests. Use this command frequently while changing
types or migrating a file.

### Run tests

```bash
npm test
```

Runs unit tests and MCP integration tests, including both supported protocol
eras, JSON Schema compilation, native media content, stdio child processes,
large requests, and shutdown. Tests use mocked AnkiConnect responses and local
fake HTTP servers (including stalled headers/bodies and redirects). They do not
require or modify a running Anki collection.

### Build the project

```bash
npm run build
```

Compiles the application source tree with `tsconfig.build.json` into `dist/`.
Tests are type-checked but are not included in the published build. The
generated directory is cleared first, then rebuilt to mirror the source
structure and include source maps.

The compiler does not write partial output when type errors are present.

### Start the compiled server

```bash
npm start
```

Runs `dist/mcp/server.js`. Build the project before using this command:

```bash
npm run build
npm start
```

## Recommended development workflow

1. Start Anki and make sure its API is available.
2. Create the local `.env` file.
3. Run `npm run dev`.
4. Make the required source changes.
5. Run `npm test`.
6. Run `npm run typecheck`.
7. Run `npm run build`.
8. Test the affected tools through an MCP client connected to the server.

## Connecting an MCP client

Build the server first:

```bash
npm run build
```

Then configure your MCP client to launch the compiled entry point. The exact
configuration format depends on the client, but a typical configuration looks
like this:

```json
{
  "mcpServers": {
    "anki": {
      "command": "node",
      "args": ["/absolute/path/to/anki-mcp/dist/mcp/server.js"],
      "env": {
        "ANKI_URL": "http://127.0.0.1:8765"
      }
    }
  }
}
```

Replace `/absolute/path/to/anki-mcp` with the actual repository path.

The server uses `stdio`, so normal application output must not be written to
standard output. Diagnostic messages should be written with `console.error`
to avoid corrupting MCP protocol messages.

## MCP SDK and protocol compatibility

The server uses MCP TypeScript SDK v2, pinned to
`@modelcontextprotocol/server` 2.4.0. The matching
`@modelcontextprotocol/client` package is a development dependency for tests.
The old monolithic SDK package is no longer required. Zod is pinned to 4.6.7;
SDK-bound schemas use Zod's Standard Schema and JSON Schema support.

`mcp/create-server.ts` builds a fresh server and registers all 45 tools without
starting a transport or contacting Anki. `mcp/stdio.ts` hosts that factory with
`serveStdio`, serving both the `2026-07-28` revision and legacy `initialize`
clients. Integration tests explicitly exercise `2025-11-25` and `2026-07-28`.
The launch command and `ANKI_URL` configuration are unchanged.

The SDK's default stdio read-buffer limit is 10 MB. This project sets a
**40 MiB inbound buffer limit**, allowing a 25 MiB media file to be sent as
roughly 33.4 MiB of base64 plus JSON overhead. This is a transport-wide limit
for the complete buffered request, separate from each tool's input limits.
An oversized buffer causes an error and closes the connection; reconnect with
a smaller request. Client applications may impose smaller limits of their own.
URL and allowed local-path media imports avoid sending the file's bytes in
the MCP request, but retain the same 25 MiB media-file limit.

When the client closes stdin, the SDK tears down the connection and the server
exits naturally once pending work no longer keeps the process alive. `SIGINT`
and `SIGTERM` also close the stdio handle. Closing the connection does not roll
back Anki operations that have already been sent.

See the official [SDK v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
and [stdio serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html).

## Project structure

```text
.
├── anki-api/
│   ├── anki-request.ts       # HTTP client for AnkiConnect
│   ├── cards/
│   │   ├── card-client.ts    # Typed AnkiConnect card operations
│   │   └── card-types.ts     # AnkiConnect card response types
│   ├── decks/
│   │   ├── deck-client.ts    # Typed AnkiConnect deck operations
│   │   └── deck-types.ts     # AnkiConnect deck response types
│   ├── media/
│   │   ├── media-client.ts   # Typed AnkiConnect media operations
│   │   └── media-types.ts    # AnkiConnect media request/response types
│   ├── notes/
│   │   ├── note-client.ts    # Typed AnkiConnect note operations
│   │   └── note-types.ts     # AnkiConnect note response types
│   └── note-types/
│       ├── note-type-client.ts # Typed note-type discovery and design operations
│       └── note-type-types.ts  # AnkiConnect note-type response types
├── mcp/
│   ├── server.ts             # MCP server entry point
│   ├── create-server.ts      # Transport-independent server factory
│   ├── stdio.ts              # Protocol compatibility, input limit, and stdio hosting
│   ├── tools/
│   │   ├── cards/            # Card tool contracts and handlers
│   │   ├── decks/            # Deck tool contracts and handlers
│   │   ├── media/            # Media storage, inspection, and reference tools
│   │   ├── notes/            # Note tool contracts and handlers
│   │   └── note-types/       # Note-type discovery and HTML/CSS tools
│   └── utils/
│       ├── tool-annotations.ts # Shared MCP behavior annotations
│       ├── tool-handler.ts   # Shared tool error handling
│       └── tool-result.ts    # Structured MCP result creation
├── dist/                     # Generated build output
├── package.json
└── tsconfig.json
```

The server currently exposes tools for:

- listing, creating, deleting, and inspecting decks;
- finding, inspecting, moving, suspending, and reviewing cards;
- creating, finding, updating, tagging, and deleting notes;
- storing, inspecting, attaching, detaching, and deleting media;
- inspecting, cloning, and redesigning note types.

### Study statistics

`get-study-stats` is a read-only, collection-wide count of actual reviews
today and recent days with review activity. `limitDays` defaults to 30 and
counts returned active days, not elapsed calendar days. Rows are newest
first, days with no reviews are omitted, and `hasMore` indicates truncation.
`reviewedToday` follows Anki's configured study-day boundary, not the MCP
host's midnight. V1 also returns `todayDate` and `nextDayAt`; legacy returns
`null` for those values because its count endpoint does not supply them.
The two native counts are separate reads, so a review or day rollover can
occur between them. For current scheduling counts by deck use `get-deck-stats`.

### Card tools

- `search-cards` searches with Anki query syntax and returns a bounded page of
  scheduling summaries.
- `get-card-details` returns note fields and normalized scheduling data for
  selected cards.
- `get-card-preview` returns Anki-rendered HTML, shared CSS, and restricted
  standalone HTML documents for one existing card, in light or dark mode.
- `get-card-review-history` returns bounded, newest-first review history.
- `set-card-suspension` suspends or unsuspends cards.
- `set-card-flag` safely applies one of Anki's supported flag colors.
- `reschedule-cards` changes due dates with Anki's Set Due Date syntax.
- `reset-cards-to-new` resets card scheduling progress.
- `start-card-relearning` starts relearning for active Review cards and reports
  which entered Relearning, returned directly to Review, or were suspended.

With v1, `search-cards` uses the same [cursor options as Note search](#note-tools).
For Card summaries, `isDue` uses Anki's native New or Due search and excludes
suspended and buried Cards, rather than interpreting legacy review-log intervals.
Rendered content is requested from Anki only for previews or when explicitly
requested in Card details.

Low-level scheduling field and ease-factor setters are not exposed to MCP
clients. A general-purpose answer/reviewer tool is not exposed. However,
`start-card-relearning` can perform an **Again answer** in current AnkiConnect,
adding review history and changing repetition/lapse counts. Treat it as a study
action, not a harmless metadata edit. Anki may skip the relearning queue when
no steps are configured, or suspend a leech. See Anki's
[relearning options](https://docs.ankiweb.net/manual/deck-options#relearning-steps).

#### Verified Card changes

The five Card mutation tools require every requested Card to exist and be
readable before writing; a missing/incomplete Card blocks the whole selection.
Duplicate input IDs are processed once. These tools apply immediately: this
workflow does not add `dryRun`, revision hashes, or an approval dialog.

- Suspension and flag changes skip Cards already in the requested state. When
  a write is needed, `cardsInfo` verifies the desired state of the full selection.
  AnkiConnect's `suspend` boolean (including `false` for no change) and legacy
  `unsuspend` null acknowledgement are handled separately from verification.
- Due-date changes require a positive `setDueDate` acknowledgement, then verify
  Review state and the requested date/range with Anki's native `prop:due` search.
  This uses Anki's scheduler day/rollover, not the MCP host's date. Intervals are
  managed by the current scheduler/FSRS; no exact interval or random day is
  predicted. Offsets must be ascending nonnegative 32-bit integers.
- Reset checks New type/queue, zero interval, and reset ease factor.
  It does **not** promise to erase review history or repetition/lapse counts;
  Anki may record a reset entry, restore a previous new-card position, or retain
  a stale internal `left` value that is inactive once the Card is New.
- Relearning accepts only active Review Cards. Verification distinguishes an
  actual Relearning queue from an immediate return to Review or leech
  suspension. The latter outcomes also require increased repetition/lapse
  counts so an unchanged Review Card cannot masquerade as a successful lapse.

Flag writes are sequential. A failed write stops later writes and reports
acknowledged-but-unverified and not-attempted IDs; failures are not silently
collected into a successful result. Existing success response fields are kept;
`start-card-relearning` additionally returns `reviewCardIds` and
`suspendedCardIds`. `failedCardIds` is empty on verified flag success; failure
is an MCP error instead of a normal success response.

Readback checks Card identity and operation-specific state, not every Card
field or all historical side effects. It is a point-in-time check, not an
atomic transaction. A concurrent edit, scheduler rollover, or read failure may
prevent verification even after a write succeeded. Errors state that changes
may already be applied; there is no automatic retry, rollback, or MCP backup.
Reset and relearning are marked non-idempotent because Anki may log actions.

#### Static HTML/CSS preview

Find an existing card with `search-cards`, or use a Card ID returned by
`create-notes` or `get-note-details`, then call:

```json
{
  "cardId": 1234567890000,
  "side": "both",
  "theme": "light"
}
```

`side` accepts `front`, `back`, or `both` (the default). `theme` accepts `light`
(the default) or `dark`. The tool makes one `cardsInfo` request and does not
open Anki's reviewer, answer cards, or change scheduling, Notes, or Note Types.
Anki itself substitutes fields, filters, conditional sections, and cloze
content; the MCP server does not implement its own template renderer.

The result contains `exists` and a nullable `preview`. An existing card's
preview includes its Note ID, Note Type, deck, template ordinal, exact shared
CSS, and selected sides. Each side contains:

- `html`: the **unmodified, untrusted** HTML returned by Anki;
- `document`: a standalone restricted HTML document containing that side and CSS;
- `removedElementCount` and `removedAttributeCount`: counts of removed elements
  and attributes in the document copy (a removed subtree counts as one element).

The server does not write preview files, create backups, start a browser, or
install a browser engine. A client can save `document` as an `.html` file and
open it as a separate document in a viewer that honors Content Security Policy.
For embedding, use a sandboxed iframe without script, same-origin, or navigation
permissions. Never insert `document`, raw `html`, or `css` as innerHTML in a
privileged application page. Retained CSS relies on CSP to block URL loads.

Documents preserve common text, table, ruby, layout, and inline-style markup,
but remove scripts, event handlers, embeds, links' URL attributes, and media
sources. Form controls are disabled. A CSP additionally blocks resource
loading, JavaScript, frames, navigation base URLs, and form submissions.
No media bytes or external URLs are fetched by this tool. Images, custom fonts,
audio/video, MathJax, interactive hints, and JavaScript-driven layouts may be
missing or nonfunctional. Raw source is retained so the LLM can inspect these
features without executing them.

The body receives `.card` and `.cardN` classes (`N = templateOrdinal + 1`),
plus `.nightMode` and `.night_mode` in dark mode. Dark mode does not override
colors explicitly set by the Note Type. No platform-specific classes or Anki
reviewer runtime are emulated, so this is not a pixel-exact reviewer screenshot.

The combined UTF-8 size of CSS and selected raw sides is limited to 256 KiB.
Oversized source is rejected rather than silently truncated; selecting a single
side may help. Missing CSS also fails instead of returning a misleading preview.

The intended LLM workflow is to inspect the current design, preview and apply
an approved HTML/CSS edit with the existing revision guards, then request
`get-card-preview` again on representative real cards. It can compare populated
HTML, cloze content, CSS, and theme classes. This first version **does not let
an LLM see a rendered image**, detect pixel-level layout problems, or preview
unapplied template drafts. PNG screenshots and embedded media are later steps.

See the official [Anki styling documentation](https://docs.ankiweb.net/templates/styling.html)
for card classes, night mode, and shared Note Type CSS.

### Deck tools

- `list-decks` lists every deck with its ID and hierarchy metadata.
- `create-deck` creates a deck or returns the existing deck with the same name.
- `rename-deck` renames a deck or moves its subtree under an existing parent
  using native AnkiConnect v1, preserving deck and card IDs.
- `get-deck-stats` returns scheduler counts for selected or all decks.
- `get-card-decks` groups card IDs by their current deck.
- `move-cards-to-deck` moves cards and creates the target deck when necessary.
- `delete-deck-and-cards` previews deletion of a normal deck and its complete
  subtree, then requires a reviewed impact hash and explicit confirmation.

`rename-deck` takes exact `name` and `newName` paths. It previews all affected
paths and refuses collisions, moves into the source subtree, missing parents,
and filtered destination parents. Apply with `dryRun: false`,
`confirmRename: true`, and the reviewed `expectedImpactHash`. The hash covers
the profile, subtree and destination parent; the server verifies paths and
preset assignments by deck ID after the rename. Concurrent changes may
still race the final write. This tool requires `ANKI_API_MODE=v1`.

Low-level deck configuration ID operations are not exposed to MCP clients.
Deck option management will be added separately after its behavior has been
validated against current Anki versions.

Some AnkiConnect versions report `Deck counts unavailable.` when Anki omits
the empty default deck from its scheduler tree. `get-deck-stats` isolates the
per-deck results and returns zero counts only after native search confirms
that the affected deck and its descendants contain no cards. Other errors,
including unavailable counts for nonempty decks, remain errors.

#### Safe deck deletion

`delete-deck-and-cards` now defaults to `dryRun: true`. Old calls containing
only `name` no longer delete anything. Use the exact root name from `list-decks`:

```json
{
  "name": "Languages::German"
}
```

Review `profileName`, `deck`, `impactComplete`, `impact`, `blockers`, and
`warnings`. Descendants are included automatically. Impact counts distinguish
deleted Cards, Notes that lose their last Card, and Notes/Cards preserved
elsewhere. Samples contain up to 20 decks, Card IDs, and affected Notes;
truncation flags identify omitted samples. Use the existing detail tools to
inspect sampled IDs when needed. Unknown counts are `null`, not evidence of
zero impact. Incomplete scopes have `impactHash: null`. A rejected stale apply
request may return a new current hash; do not automatically reuse it without
reviewing the changed impact and obtaining user approval.

After the user approves the complete impact, apply with the reviewed hash:

```json
{
  "name": "Languages::German",
  "dryRun": false,
  "expectedImpactHash": "<impactHash from the complete reviewed preview>",
  "confirmDeletion": true
}
```

Replace the placeholder with the actual 64-character lowercase hash. Before
writing, the server reloads the subtree, Card placement, and affected Notes.
The hash includes the active profile, every deck ID/name, all target Card IDs
and their current deck assignments, and full affected Note snapshots (fields,
HTML, field order, tags, modification times, and all sibling Card IDs). It is
calculated before sampling, so unchanged totals or identical displayed
samples cannot conceal changed impact. Unrelated decks/Notes do not affect it.
Card scheduling, review logs, deck option settings, shared Note Type design,
and the placement of preserved outside siblings are not hashed.

Only normal decks are supported. The built-in Default deck **ID 1** is blocked,
even if renamed or nested. Filtered decks, descendants of unknown/unsupported
kind, and Cards borrowed from the subtree into filtered decks are blocked.
`getDeckConfig` must reliably identify each deck as normal (`dyn: false` or
`0`); errors or missing metadata cannot be bypassed with confirmation flags.
Return borrowed Cards or resolve the issue with user approval, then review a
fresh preview. The tool never automatically empties filters, moves Cards,
renames decks, or repairs data just to enable deletion.

Full review is limited to 100 decks, 5,000 target Cards, 1,000 affected Notes,
and 10,000 total Cards referenced by those Notes (including outside siblings).
Exceeding a limit blocks application instead of silently reviewing a subset.
Native searches use validated numeric deck/Card/Note IDs, not interpolated deck
names or wildcards. Note reads and explicit-ID checks are batched at 250 IDs.
Multiple read phases are required; larger reviews take more work than the old
immediate-delete operation. The active profile, hierarchy, target Card set,
and referenced Card presence are checked again before an impact is complete.

Anki deletes the normal deck subtree's Cards and their review history. A Note
with other Cards outside the subtree **survives**, unlike `delete-notes-and-cards`,
which deletes all Cards of its selected Notes. Shared Note Types and media
files are not removed. See Anki's [native deck removal implementation](https://github.com/ankitects/anki/blob/main/rslib/src/decks/remove.rs)
for normal/filtered behavior and Default's special handling.

After applying, native searches verify that all reviewed deck IDs/names and
target Cards are absent, orphaned Notes are gone, and expected surviving Notes
and sibling Cards still exist. Only then are `applied` and `verified` true;
`deletedDecks` contains the full reviewed subtree and `deletedDeck` its root.
Preview/blocked results have false flags, empty `deletedDecks`, and null
`deletedDeck`. A write or verification failure returns an MCP error: some data
may already be deleted. No automatic retry, MCP backup, or rollback is provided.
Inspect Anki before retrying. Read/compare/delete is not atomic, and concurrent
changes after the final read can still race. The hash and confirmation flag
are not authentication or proof of human approval.

### Note type tools

- `list-note-types` lists the note types available for note creation.
- `get-note-type-schema` returns ordered fields and the fields used by each
  generated card template.
- `get-note-type-design` returns the complete front/back HTML, shared CSS,
  ordered fields, and a revision hash.
- `create-note-type` validates and creates a new Normal or Cloze note type from
  ordered fields, complete card templates, and shared CSS.
- `clone-note-type` safely copies ordered field names, card template HTML, and
  shared CSS into a new independent note type without copying notes or cards.
- `add-note-type-field` adds an empty field to every note of a note type,
  optionally at a selected zero-based order.
- `rename-note-type-field` renames one field while preserving existing values
  and allowing Anki to update template references.
- `reposition-note-type-field` changes the editor/display order of a field
  without changing its values.
- `delete-note-type-field` previews the affected notes, then permanently
  removes a field and all of its values from every note of the note type.
- `add-note-type-template` validates and appends a new Card Template, while
  reporting how many existing Notes may generate another Card.
- `rename-note-type-template` renames a Card Template without changing its
  HTML, Cards, or review history.
- `reposition-note-type-template` changes the zero-based Card Template order.
- `delete-note-type-template` previews and permanently removes a Card Template
  and the Cards generated from it.
- `update-note-type-styling` validates and replaces the CSS shared by all cards
  generated from a note type.
- `update-note-type-templates` validates and replaces selected front or back
  HTML templates in one Anki update.

AnkiConnect calls note types "models" in its API, so note-type tool inputs use
`modelName` to stay consistent with existing AnkiConnect and card payloads.

To create a note type from scratch, call `create-note-type` with ordered
`fields` and `templates`. Its dry run validates unique names, field references,
HTML, CSS, and Normal/Cloze compatibility. Repeat the same request with
`dryRun: false` only after reviewing the result. The operation creates only the
schema and design; it does not create notes or cards. A Cloze definition must
have exactly one card template with a `{{cloze:Field}}` filter on its front.

The Card Template lifecycle is split into focused operations. Use
`get-note-type-design` to read names, order, HTML, and `designHash`; use
`update-note-type-templates` to change existing HTML; and use the add, rename,
reposition, or delete tool for structural changes. Every structural mutation
defaults to `dryRun: true` and requires the current `expectedDesignHash` when
applied.

Adding a Card Template appends it to the current order and may generate one
new Card per existing Note whose values satisfy the front template. Its apply
step requires the reviewed `expectedNoteCount` and
`confirmCardCreation: true`. Reposition it separately if another order is
needed.

Deleting a Card Template permanently deletes the Cards generated from it and
their review history. The dry run reports exact Card and affected Note counts,
including Notes that would lose their last Card. Applying requires the
reviewed `expectedCardCount`, `expectedNotesLosingLastCardCount`, and
`confirmCardDeletion: true`; `confirmNoteDeletion: true` is also required when
any Note may lose its last Card. The last template of a Note Type cannot be
deleted.

The update tools default to `dryRun: true`. A safe design-editing workflow is:

1. Call `get-note-type-design`.
2. Propose a CSS or HTML change with the returned `designHash` as
   `expectedDesignHash`.
3. Review the dry-run validation errors, warnings, and before/after hashes.
4. Repeat the same update with `dryRun: false`.

`update-note-type-styling` reports `applied: true` only after Anki acknowledges
the write and a fresh design read confirms the exact CSS, the same Note Type
ID, and unchanged Card Template names/order/front/back HTML. Success returns
the verified `afterHash`; a dry run still returns a proposed hash without
writing. An already-matching CSS value skips the write and extra readback.
Whitespace and Unicode are compared exactly, not reformatted automatically.

A write error, invalid acknowledgement, unreadable design, or unexpected saved
CSS/templates returns an MCP error rather than a successful change report.
The message distinguishes an unconfirmed write from an acknowledged write
whose verification failed. Either can follow an applied change: inspect the
current design before retrying. No automatic retry, rollback, or backup is
created. Pre-read, write, and readback are not atomic; this verifies a saved
HTML/CSS snapshot, not visual rendering or every Note Type property. Tool
parameters and success response fields are unchanged.

To create a separate design, call `clone-note-type` in dry-run mode, then
repeat it with `dryRun: false` and the returned source design hash. The clone
can be styled independently and used as `modelName` when creating new notes.
AnkiConnect does not expose the source model's normal/Cloze flag, so the tool
detects Cloze templates from `{{cloze:...}}` filters and provides an explicit
`isCloze` override for unusual templates.

The clone copies ordered field names, card template HTML, and shared CSS. It
does not copy notes, cards, deck placement, field descriptions, editor font
settings, or a custom sort-field selection.

Field mutations also default to `dryRun: true`. Call `get-note-type-schema`,
review its ordered fields and `schemaHash`, preview the mutation, and pass that
hash as `expectedSchemaHash` when applying it. Adding a field gives every
existing note an empty value and does not automatically place the new field in
a card template. Moving a field into the first position changes the field Anki
uses for duplicate checks, so the tools report that as a warning.

Deleting a field has stronger safeguards because it permanently removes data.
The dry run reports the total note count, the number of notes with a non-empty
value, and a bounded sample of affected note IDs. Applying the deletion
requires the same `schemaHash`, the reviewed non-empty note count as
`expectedNonEmptyNoteCount`, and `confirmDataLoss: true`. The tool refuses to
delete the last field or a field still referenced by a card template. It does
not create an MCP backup, so remove template references and review the impact
before applying the change.

`expectedDesignHash` is required when `dryRun` is false. This prevents an LLM
from overwriting a design that was changed in Anki after the LLM read it.

Styling and templates belong to a note type, not to one note or card. A
successful update therefore changes every card generated from that note type.
The tools return the previous content in their change details, but do not
create or store backup files. A recent change can be reverted with Anki Undo;
Anki's collection backups remain the fallback for older changes.

Local validation parses CSS with `css-tree`, checks Anki field references,
conditional sections, and potentially executable or externally loaded content.
Anki still performs the authoritative template validation when an update is
applied.

### Note tools

- `search-notes` searches with Anki query syntax and returns a bounded page of
  field previews, tags, and generated card IDs.
- `get-note-details` returns complete ordered fields, per-field SHA-256 hashes,
  and metadata for selected notes.
- `validate-note-drafts` checks decks, note types, field names, empty-card
  rules, existing media references, and duplicates without creating anything.
- `create-notes` validates and creates a bounded batch, then returns both note
  IDs and generated card IDs, preserving acknowledged IDs if readback fails.
  Each draft can safely merge `mediaReferences` for files already in Anki.
- `update-note-fields` previews partial field patches by default, rejects stale
  field hashes before writing any note, and verifies saved values after applying.
- `edit-note-tags` adds and removes selected tags without replacing unrelated
  tags.
- `list-tags` returns a filtered, paginated view of collection tags.
- `delete-notes-and-cards` previews deletion of explicit Note IDs and all their
  generated Cards. Applying requires a reviewed impact hash and confirmation;
  native searches verify the result.

With `ANKI_API_MODE=v1`, ordinary `search-notes` calls use native cursor
paging by default:

```json
{"query":"deck:German tag:A1","limit":20}
```

Continue sequentially with the same query and limit and set `cursor` to the
previous result's `nextCursor`. A null `nextCursor` ends the search.
In this mode, `total` and `offset` are null: AnkiConnect sends only the
requested page of IDs and does not return an exact total. The page's detail
read uses the same Anki collection session. Start a new search if a cursor
expires, the profile changes, or a continuation fails after consuming its
cursor. Use `pagination: "offset"` for an exact total, or supply an explicit
`offset` (including 0) to select offset mode when pagination is omitted.
V1 offset mode walks the native search pages to count the matches; this can
be slower than a single cursor page and does not call legacy. Legacy mode
defaults to offset and does not support native cursors.

#### Note creation outcomes

`create-notes` keeps the existing input format and validates the entire batch
before sending one creation request. A failed draft prevents every Note in
that batch from being sent. In v1 mode, `notes.validateMany` and
`notes.createMany` use the same fields, tags, and duplicate policy, with
preflight, media reads, creation, and verification pinned to one collection
session. Creation uses `atomic: false` to retain independent item outcomes.
Legacy mode still uses `addNotes`. Validation is not a reservation or an
idempotency guarantee; concurrent edits can change what Anki accepts.

Each input has a zero-based `inputIndex` in `noteResults`:

| Status | Meaning |
| --- | --- |
| `created` | An aligned creation reply acknowledged an ID, and readback confirmed that ID, its Note Type, and readable distinct Card IDs. |
| `created-unverified` | Creation acknowledged an ID, but readback was missing, malformed, failed, or inconsistent. The ID is retained; `cardIds` is `null`. |
| `not-created` | A valid reply returned legacy `null` or a v1 lookup/validation rejection for this input. |
| `not-attempted` | No creation request was sent, or v1 rejected the stale session before executing it. |
| `unknown` | No trustworthy acknowledgement for this input; its Note may already exist. A v1 internal failure is not proof of rejection. |

`outcome` summarizes the batch as `complete`, `incomplete`, `unknown`, or
`not-attempted`. `createdNoteCount` is the exact acknowledged count when all
outcomes are known, **not the number successfully read back**. It is `null`
if any outcome is unknown, even when other IDs were acknowledged and verified;
`0` is used only for known zero creation. A Note may
disappear after its creation was acknowledged without changing that historical
count. Existing success fields `createdNotes` and `validations` remain, and
each `createdNotes` entry additionally includes `verified`. Normal success
still supplies numeric counts and Card ID arrays; error results can have a
null count and/or null Card arrays. `[]` means a readback actually reported no
Cards; it is never substituted for unavailable data.

Incomplete/unknown execution returns `isError: true` **with structured data**,
not an exception that discards acknowledged IDs. Results are also serialized
in a text content block so clients that ignore `structuredContent` still
receive the evidence, following the [MCP structured-content guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content).

Malformed, misaligned, or duplicate-ID creation replies cannot be safely
associated with drafts. Their distinct positive integer IDs are retained only
as `reportedNoteIds` (up to 50; `reportedNoteIdsTruncated` identifies overflow).
These are **unmapped reports, not proof of creation or ownership**. They are
not read back, assigned to input positions, or used for automatic cleanup.
`validations` remains validation/rejection metadata; use `noteResults` for
execution status. It may be empty if draft preparation itself failed.

No creation retry, speculative search, or rollback is performed. Do not resend
the whole batch after an incomplete/unknown result. Inspect acknowledged IDs
with `get-note-details` where available, then review what actually exists
before deciding whether to retry any inputs. A readback verifies ID/Note Type
and Card ID data, not exact field/tag content, scheduling, or visual rendering.
Reads, creation, and verification are not atomic and do not exclude concurrent
edits. V1 session checks prevent later steps from operating in a different
profile, but cannot undo a write acknowledged before a profile switch.

#### Safe field updates

`update-note-fields` defaults to `dryRun: true`. Existing callers that apply
updates must now explicitly set `dryRun: false` and provide
`expectedFieldHashes` for every submitted field.

A dry run validates the complete batch and returns `changes` with canonical
field names, `beforeFieldHash`, `afterFieldHash`, and raw HTML previews of the
current and proposed values. Each preview is limited to 1,000 UTF-16 code
units; `previewTruncated` identifies shortened previews. Hashes always cover
the complete value, including HTML and whitespace.

For example, preview a field replacement:

```json
{
  "dryRun": true,
  "updates": [
    {
      "noteId": 1234567890123,
      "fields": {
        "Front": "<b>das Haus</b><br>Translation: house"
      }
    }
  ]
}
```

To apply the same patch, set `dryRun: false` and add
`"expectedFieldHashes": { "Front": "<beforeFieldHash from the preview>" }`
inside the update object. Replace the placeholder with the actual 64-character
hash. A separate preview is optional: `get-note-details` already returns the
hash as `notes[i].fields.Front.hash`, which can be passed directly when applying.
When using a preview to check an earlier read, include those earlier hashes in
the dry run too; a hash-free preview only describes the current data.

Field names and hash keys resolve case-insensitively to the note type's exact
names. Only submitted fields are checked for conflicts, so editing another
field does not block the patch. Missing notes, invalid field names, or any
stale expected hash reject the whole batch before the first write. No-op
patches skip writes and additional readback. Successful apply results report
`applied: true` and `verified: true` after changed fields have been read back
and matched exactly; for no-op patches, values were already matched during
validation. Dry runs report both flags as `false`.

Each submitted field replaces its complete value. Preserve any existing HTML
or media markup that should remain; unspecified fields are untouched. A hash
check detects changes since the read or preview, but cannot judge whether the
proposed replacement preserves the intended content.

With `ANKI_API_MODE=v1`, this tool passes the same collection session to
`notes.getMany`, each `notes.update`, and the verification read. If the
profile changes during a tool call, a stale-session error stops the
remaining steps without falling back to a legacy write. A preview and a
later apply are separate calls: the apply still checks the field hashes
against current values. Media attachment and detachment also use v1 when
enabled, with their own preflight and readback checks.

The preflight check and subsequent writes are separate AnkiConnect calls, not
an atomic transaction. A concurrent edit in that interval remains possible.
On a write or verification error, the tool reports an MCP error with the
affected or acknowledged note IDs. Earlier writes may already be saved; no
automatic rollback or retry is performed. Inspect current values before
preparing another patch.

Global tag replacement, unused-tag cleanup, and changing an existing note to
another note type are intentionally deferred because they require additional
safety and data-preservation rules.

#### Safe Note deletion

`delete-notes-and-cards` now defaults to `dryRun: true`. Old calls that only
provide `noteIds` **no longer delete anything**. The tool accepts 1–100 explicit
IDs (duplicates are ignored), not search queries.

First request a preview:

```json
{
  "noteIds": [1234567890000, 1234567890001]
}
```

Review `profileName`, `impact`, `missingNoteIds`, `blockers`, and `warnings`.
`impact` reports exact Note/Card counts and one entry per loaded Note. Each
entry shows the first 3 ordered fields (raw HTML, up to 200 UTF-16 code units
per value) and up to 20 generated Card IDs. `fieldPreviewsTruncated` and
`cardIdsTruncated` identify shortened samples. Use `get-note-details` when
more content is needed to decide whether deletion is appropriate.

After the user approves the data loss, submit the **same Note IDs** with:

```json
{
  "noteIds": [1234567890000, 1234567890001],
  "dryRun": false,
  "expectedImpactHash": "<impactHash from the reviewed preview>",
  "confirmDeletion": true
}
```

Replace the placeholder with the actual 64-character lowercase hash. The
server rereads the selected Notes and compares their impact hash before
sending any deletion. The hash covers the active profile name, requested IDs,
Note IDs and Note Type names, modification timestamps, all tags, complete
field values including HTML/whitespace, field names/orders, and all generated
Card IDs. It covers data beyond the displayed samples. Reordering request
IDs, tag lists, field-object entries, or Card ID lists does not change it.
It is not a stored backup, authorization token, or guarantee of user approval.

Any changed selection or snapshot blocks the **whole batch**. Missing or
unloadable Notes are reported in `missingNoteIds`, make `impactHash: null`,
and block deletion of the other Notes too. Inspect a fresh preview rather than
automatically resubmitting a rejected operation with its new hash.

Successful application returns `applied: true`, `verified: true`, and
`deletedNotes` with the full reviewed Card IDs. Preview or blocked results
return both flags as `false` and an empty `deletedNotes`. A preview needs one
HTTP `multi` request (profile plus Note data); applying normally needs three
HTTP requests: current scope, deletion, and batched verification. Verification
uses explicit-ID native Note/Card searches, with Card queries split into
groups of 250 IDs, and checks the active profile again. Invalid `notesInfo`
objects are never used as proof of successful deletion.

Deleting a Note deletes **all** of its generated Cards, including Cards in
other decks, and their review history. Media files are not deleted. The hash
does not include Card scheduling, deck placement, review history, or shared
Note Type HTML/CSS. Changes to these alone do not invalidate it. Unselected
Notes are not part of the hash.

Read/compare/delete is not an atomic transaction: a concurrent edit after the
last read can still race. No MCP backup, automatic retry, or rollback is
performed. A write error can mean that deletion already reached Anki; a
verification error can occur after Anki acknowledged deletion. Both return
an MCP error describing the uncertain/acknowledged state. Inspect Anki before
retrying; never interpret an error as proof that nothing was deleted.

### Media tools

- `search-media-files` returns a sorted, bounded page of filenames matched by
  an AnkiConnect glob pattern.
- `get-media-file` returns verified size, MIME type, kind, and SHA-256 metadata.
  Small images and audio can also be returned as native MCP content when the
  client requests it.
- `store-media-file` imports bounded image, audio, video, or font bytes from
  base64, a public HTTPS URL, or an explicitly allowed local directory.
  Existing files are never overwritten: the default lets Anki create a unique
  filename, while `collisionPolicy: "reject"` refuses a collision.
- `find-media-references` scans note fields, Card Template HTML, and note-type
  CSS for exact references to one filename, returning a reference fingerprint
  when the scan is complete.
- `attach-media-to-notes` appends or prepends safe `<img>` or `[sound:...]`
  markup without replacing unrelated field HTML.
- `detach-media-from-notes` removes exact references from selected note fields
  without deleting the underlying file.
- `delete-media-file` performs a complete impact scan and requires the reviewed
  file hash, reference count, reference fingerprint, and explicit confirmation
  before moving a file to Anki's media trash.

In v1 mode, the server submits `media.store` once and polls its operation
status before verifying the stored bytes. The polling phase is bounded by
the configured request timeout. A lost status or timeout does not cancel
the accepted write; inspect Anki before retrying. Collision rejection uses
Anki's native error policy as well as the preflight check.

Media mutations that change note fields default to `dryRun: true`. The dry run
returns a SHA-256 hash of the complete current field value; pass it back as
`expectedFieldHash` when applying the same attachment or detachment. This
prevents an update from overwriting a field edited after the preview.

For deletion, first call `delete-media-file` with `dryRun: true` (the default).
Review its file metadata, reference locations, blockers, and warnings. To apply,
pass `dryRun: false`, `confirmDeletion: true`, and the preview's values:

- `file.sha256` as `expectedSha256`;
- `usage.totalReferenceCount` as `expectedReferenceCount`;
- `usage.referenceFingerprint` as `expectedReferenceFingerprint`.

If references remain, `confirmBrokenReferences: true` is also required. Applying
without the reference fingerprint is no longer accepted. The fingerprint
includes the filename and every detected reference's Note/field, template/side,
or CSS owner and occurrence count. Moving a reference can therefore block
deletion even when the total count stays unchanged. Scan order and unrelated
surrounding HTML do not affect it.

The fingerprint covers all detected locations **before** the response samples
are truncated. `referencesTruncated: true` limits the displayed detail, not hash
coverage. An incomplete scan (including missing `notesInfo` results or CSS scan
failures) returns `referenceFingerprint: null` and blocks deletion. Fingerprinting
adds local hashing, not extra AnkiConnect requests, and stores no backup or history.
These checks are not an atomic Anki transaction: a concurrent edit between the
final scan and deletion is still possible. Dynamically generated references
outside the scanner's detectable HTML/CSS syntax are not covered.

CSS scan failures are reported separately in `usage.cssScanFailureCount` and
`usage.cssScanFailures`. The latter contains the first diagnostic (with source
line/column) per affected Note Type, sampled to 100 Note Types. Compare its
length with `cssScanFailureCount` to detect truncated diagnostics. Known
references are still returned, but counts may omit references when
`scanComplete: false`; zero detected references is not proof of no usage.

The scanner checks recovered parser errors, opaque/unparsed content, and
unmatched or unterminated blocks, functions, strings, URLs, and comments. It
also parses custom-property values so `--background: url("image.png")` is
inspected. Even browser-tolerated EOF recovery or syntax unsupported by the
parser makes a scan incomplete. One failing Note Type blocks media deletion,
even when the target filename was not found in its CSS. Neither
`confirmDeletion` nor `confirmBrokenReferences` bypasses this check.
Speculative parser retries that successfully produce fully parsed syntax
(such as nested `@supports` conditions) do not count as failures.

Inspect the reported CSS issue with the user before changing any Note Type;
do not automatically rewrite unrelated styling just to unblock deletion.
After resolving the issue or adding parser support, obtain a fresh complete
preview. CSS is not rewritten by scanning, and these checks add no AnkiConnect
requests. The parser's tolerant recovery behavior is described in the
[css-tree parsing documentation](https://github.com/csstree/csstree/blob/master/docs/parsing.md#onparseerror).
CSS matching is limited to direct `url(...)` occurrences in shared Note Type
styles; it does not follow imported stylesheets or evaluate browser runtime
behavior. A complete scan is not a guarantee that every possible reference
syntax is supported.

The recommended note workflow is:

1. Store or locate the media file.
2. Use the exact returned filename.
3. Attach it to existing notes, or pass it through `mediaReferences` when
   validating and creating new notes.
4. Use `find-media-references` before replacing or deleting an asset.

Anki stores media in one flat `collection.media` folder. Static assets
referenced directly by Card Template HTML or note-type CSS must start with an
underscore, such as `_logo.png` or `_inter.woff2`, so Anki's media checker does
not treat them as unused. `store-media-file` enforces this rule when
`usage: "template-static"` is selected.

URL imports accept public HTTPS destinations only, reject credentials,
localhost and private IP addresses, follow a bounded number of redirects, and
enforce a 25 MiB download limit. Local paths are resolved through
`ANKI_MEDIA_IMPORT_DIRS` to prevent unrestricted filesystem access.

Automatic Anki collection backups do not include media files. Media deletion
therefore remains a destructive action even though Anki initially moves the
file into its media trash. The delete tool refuses to apply when the candidate
set is too large to complete its bounded reference scan or some candidates
cannot be loaded, or if shared Note Type CSS cannot be fully inspected.

## Adding an MCP tool

1. Add the implementation to the appropriate module in `mcp/tools/`.
2. Add typed AnkiConnect operations to the appropriate `anki-api/` domain
   client and call them through `invokeAnki`.
3. Define its input and output schemas with Zod.
4. Return readable `content` and machine-readable `structuredContent`.
5. Register the tool in its domain module or in `mcp/server.ts`.
6. Run the type check and build:

```bash
npm test
npm run typecheck
npm run build
```

Keep tool names and descriptions clear because MCP clients expose them directly
to language models.

## TypeScript

All application source files use TypeScript and are checked with strict
compiler settings. JavaScript source files are not included in the build.

When using the `NodeNext` module system, keep `.js` extensions in relative
imports inside TypeScript source files:

```ts
import { callAnki } from "../../anki-api/anki-request.js";
```

TypeScript resolves this import to the corresponding `.ts` source file and
preserves the `.js` extension required by Node.js in the compiled output.

## Troubleshooting

### The compiled entry point cannot be found

Run the build before starting the compiled server:

```bash
npm run build
```

### The server cannot connect to Anki

Check that:

- Anki is running;
- the AnkiConnect-compatible API is available;
- `ANKI_URL` is present and points to the correct endpoint.

Connection and API errors include a readable code:

| Code | Meaning / next check |
| --- | --- |
| `ANKI_CONFIGURATION_ERROR` | Missing/invalid URL or timeout; no HTTP request was sent. |
| `ANKI_INVALID_REQUEST` | Parameters cannot be serialized as JSON; no HTTP request was sent. |
| `ANKI_TIMEOUT` | Queue waiting or the HTTP exchange exceeded the request deadline. The message states whether sending had started. Check load/Anki responsiveness or adjust `ANKI_REQUEST_TIMEOUT_MS`. |
| `ANKI_REQUEST_CANCELLED` | A low-level caller cancelled the request. The message states whether sending had started. |
| `ANKI_NETWORK_ERROR` | Connection/TLS failure or an interrupted body. Check Anki, AnkiConnect, the endpoint, and any reported network code. |
| `ANKI_HTTP_ERROR` | Unexpected HTTP status, including redirects. Check the direct API URL, proxy, and authentication settings. |
| `ANKI_INVALID_JSON` | The endpoint returned invalid JSON, for example an HTML login page. |
| `ANKI_INVALID_RESPONSE` | The AnkiConnect envelope, `multi` replies, or v1 response did not match the expected contract. |
| `ANKI_V1_ERROR` | The v1 endpoint returned a JSON-RPC error. Inspect the stable error type and code; a stale cursor needs a fresh search. |

Transport messages omit the endpoint, request parameters, raw response content,
and native error causes. Legacy action errors still include the AnkiConnect
message; v1 errors expose only the method and stable error type/code.
After a request was started, treat failure as an **unknown outcome**, especially
for mutations or `multi`; inspect Anki instead of blindly repeating the action.

For internal TypeScript callers, `callAnki`, `invokeAnki`, and `invokeAnkiMulti`
accept optional `{ timeoutMs, signal }` request options. A per-call timeout takes
precedence over the environment/default. `AnkiRequestError` exposes `kind`,
`action`, `mayHaveExecuted`, `status`, and `timeoutMs`; `mayHaveExecuted: true`
means sending started, not proof that Anki executed the action. The optional
signal is a low-level API: MCP request cancellation is not automatically wired
to it, and cancelling a client request must not be treated as a rollback.

### The server appears to wait without printing anything

This is expected for an MCP server using `stdio`. It waits for protocol
messages from an MCP client.

## License

This project is licensed under the [MIT License](LICENSE).
