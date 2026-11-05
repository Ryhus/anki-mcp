# Anki MCP

Anki MCP lets a local MCP client work with Anki Desktop through AnkiConnect. It
can search and create notes, manage decks and scheduling, edit card designs,
work with media, and import or export deck packages. Destructive workflows
such as deleting a deck show their impact before applying changes.

The client launches this server over **stdio**. AnkiConnect's HTTP address
is where the server talks to Anki; it is **not** an MCP URL. This project
does not expose a remote HTTP MCP endpoint.

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tools and workflows](#tools-and-workflows)
- [Troubleshooting](#troubleshooting)
- [Development and releases](#development-and-releases)

## Quick start

You need **Node.js 24 or newer**, npm, [Anki Desktop](https://apps.ankiweb.net/),
and an MCP client that can launch local stdio servers. Development and CI
use Node.js **24.15.0** from `.nvmrc`.

In Anki, install the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159)
using **Tools → Add-ons → Get Add-ons** and code `2055492159`, then restart
Anki and keep it open. Use an AnkiConnect build that serves API v1 for the
full tool set. See [Troubleshooting](#troubleshooting) for a connection check.

### Run from source

Clone the repository and check out the version you want to run:

```bash
git clone https://github.com/Ryhus/anki-mcp.git
cd anki-mcp
```

Use a release tag for a released version, or switch to `develop` for
unreleased development. If you use nvm, run `nvm install` and `nvm use`
from the checkout. Then install dependencies and build:

```bash
npm ci
npm run build
```

Configure your MCP client to start the compiled server. This is a common
stdio configuration shape; use the equivalent fields in your client:

```json
{
  "mcpServers": {
    "anki": {
      "command": "node",
      "args": ["/absolute/path/to/anki-mcp/dist/mcp/server.js"],
      "env": {
        "ANKI_URL": "http://127.0.0.1:8765",
        "ANKI_API_MODE": "v1"
      }
    }
  }
}
```

Replace the script path with your actual path. If the desktop app does not
inherit your shell's PATH, use the absolute path to the Node executable in
`command` and keep the script path in `args`.

### Run from npm once published

Once `@ryhus/anki-mcp@0.1.0` is published, a client can run the package's
`anki-mcp` executable without cloning or compiling the repository. The
example pins the version so updates do not change the server unexpectedly:

```json
{
  "mcpServers": {
    "anki": {
      "command": "npx",
      "args": ["--yes", "--package=@ryhus/anki-mcp@0.1.0", "anki-mcp"],
      "env": {
        "ANKI_URL": "http://127.0.0.1:8765",
        "ANKI_API_MODE": "v1"
      }
    }
  }
}
```

The client needs both `npx` and Node.js on its PATH. If a desktop client
cannot see your shell's Node installation, configure its PATH or use the
source setup with the absolute path to Node. On Windows, use `npx.cmd` if
your client requires the command shim. Until the package is published, use
the source setup above.

### Verify the connection

Keep Anki open and reload your MCP client after changing its configuration.
Start with a read-only request such as **“List my Anki decks without making
any changes.”** The client should call `list-decks`. In v1 mode,
`get-collection-info` also shows which profile and scheduler are active.
Check the profile before creating or editing anything.

## Configuration

Set variables in the MCP client's environment, as shown above. Alternatively,
the server reads a `.env` file from the **working directory of the server
process**, which may not be the directory containing the executable. In a
source checkout, `.env.example` is a starting point. Restart the server
after changing configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANKI_URL` | Required | AnkiConnect base HTTP(S) address, usually `http://127.0.0.1:8765`. Omit `/api/v1`; the server appends it in v1 mode. Redirects and credentials embedded in the URL are not supported. |
| `ANKI_API_MODE` | `legacy` | Use `v1` for the full tool set. `legacy` uses AnkiConnect API version 6 for older add-ons. There is no automatic fallback between modes. |
| `ANKI_REQUEST_TIMEOUT_MS` | `30000` | Deadline for an AnkiConnect HTTP exchange, including queue wait and response reading. Valid range: 1–300,000 ms. A tool making multiple requests can take longer. |
| `ANKI_MEDIA_IMPORT_DIRS` | Unset | Allow `store-media-file` to read local source files only under the configured directories. Separate paths with `:` on macOS/Linux or `;` on Windows. Base64 and public HTTPS sources do not need this setting. |
| `ANKI_PACKAGE_IMPORT_DIR` | Unset | Enable local `.apkg` imports from one existing, trusted absolute directory. |
| `ANKI_PACKAGE_EXPORT_DIR` | Unset | Enable local `.apkg` exports to one existing, trusted absolute directory. |

The package directories are independent. Both package tools require v1,
an explicit loopback endpoint (`localhost`, `127.0.0.1`, or `[::1]`), and
filesystem paths accessible to both Anki Desktop and the MCP process.
Allowlist dedicated folders, not your home directory.

The server advertises the same tools in both API modes, but tools marked
**v1** below require `ANKI_API_MODE=v1`. Keep AnkiConnect on a trusted
interface: the MCP server can change your collection through that endpoint.

### Previews, errors, and retries

- `dryRun: true` is a preview, not a test write. It is the default for tools
  that offer it, but **not every mutation has a preview**. Check the tool's
  contract and review actions before making writes.
- Apply only the proposal you reviewed, with the required hashes, counts,
  token, and confirmation flags. If the scope changed or the result is
  incomplete, get a new preview before applying. These safeguards are not
  authentication and do not make a sequence of reads and writes atomic.
- V1 multi-step workflows pin requests to one collection session. A profile
  switch can stop later steps; it does not undo an earlier write.
- A timeout or lost response can occur after Anki changed data. There is no
  automatic write retry, rollback, or backup. Inspect Anki before resending.
  Closing the MCP client or cancelling an HTTP exchange does not stop work
  already running in Anki.

## Tools and workflows

The server currently advertises **73 tools**. Use the client's `tools/list`
response for the complete input and output schemas. The IDs and names in the
examples are illustrative; obtain the actual IDs and names from Anki.

### Deck tools

- `list-decks` — lists deck IDs, full names, and hierarchy.
- `create-deck` — creates a named deck or returns the existing one.
- `rename-deck` (**v1**) — renames or moves a subtree while preserving deck
  and card IDs. The destination parent must already exist and be a normal
  deck. Preview `name` and `newName`, then apply with `dryRun: false`,
  `confirmRename: true`, and `expectedImpactHash`.
- `get-deck-stats` — reads scheduler counts for deck `names`, or all decks
  when omitted. In v1, a deck missing from the scheduler tree is reported
  with zero counts only when a native search confirms the subtree has no cards.
- `get-card-decks` — groups card IDs by current deck.
- `move-cards-to-deck` — moves selected cards, creating the target deck if needed.
- `delete-deck-and-cards` — previews deletion of a normal deck and its
  descendants. Apply only with the reviewed hash and explicit confirmation.

Use `::` between deck names, for example `Languages::German`. To preview a
deletion, pass `{"name":"Languages::German"}`. Review the whole scope and any
blockers before applying the same name with `dryRun: false`,
`confirmDeletion: true`, and the reviewed `expectedImpactHash`.

Deck deletion removes cards in the subtree and their history. A note with
cards outside the subtree survives; shared note types and media files are not
deleted. The tool blocks the built-in Default deck (ID `1`), filtered decks
or cards borrowed into them, and any scope it cannot completely inspect.
Review limits are 100 decks, 5,000 target cards, 1,000 affected notes, and
10,000 cards referenced by those notes. Truncated samples do not truncate
the hash. Success is reported only after readback verifies the reviewed
deletion and expected survivors.

#### Deck presets (v1)

- `list-deck-presets` — lists presets and how many decks use each one.
- `get-deck-preset` — reads settings and usage by preset ID or normal deck ID.
- `create-deck-preset` — creates an unassigned preset from native defaults,
  or clones a preset selected by `cloneFromPresetId`.
- `update-deck-preset` — previews a rename or settings patch and dependent decks.
- `assign-deck-preset` — previews assigning a preset to explicit normal
  deck IDs; descendants are not included automatically.
- `delete-deck-preset` — deletes an unused, non-Default preset without
  reassigning any decks.

Example `update-deck-preset` preview:

```json
{
  "presetId": 1,
  "settings": {
    "newPerDay": 20,
    "reviewsPerDay": 200,
    "desiredRetention": 0.9
  }
}
```

Apply an update or assignment with `dryRun: false`, the reviewed
`expectedImpactHash`, and `confirmChanges: true`. Deletion uses
`confirmDeletion: true` instead. A shared preset can affect every listed
deck. The tool does not request full FSRS rescheduling or predict individual
due dates.

Writable options include daily limits, learning/relearning steps, maximum
interval, FSRS desired retention, burying, display order, and audio behavior.
For example, `newMix: "afterReviews"` controls new/review mixing and
`disableAutoplay: true` disables automatic audio playback. `waitForAudio`
does not enable Auto Advance. Raw FSRS weights, new-card insertion order,
and global Anki preferences are not writable through these tools.
See [Anki's deck options](https://docs.ankiweb.net/manual/deck-options).

#### Deck packages (v1)

- `export-deck-package` — previews export of one normal deck and its
  descendants. For example, use
  `{"deckId":1234567890123,"fileName":"German.apkg"}`. Referenced media is
  included; scheduling and review history require `includeScheduling: true`.
  Deck presets are not exported. The preview covers at most 100 decks and
  does not snapshot card content. Each export writes to a new subdirectory
  and returns a verified path, byte count, and SHA-256 without overwriting
  another file.
- `import-deck-package` — previews a trusted regular `.apkg` file up to
  512 MiB inside `ANKI_PACKAGE_IMPORT_DIR`. Pass its absolute `localPath`.
  Preview checks the ZIP header and SHA-256; it does not parse the archive
  or predict the changes to individual notes. On apply the reviewed bytes
  are copied to a private temporary file. Anki can update existing notes or
  merge note types; it imports scheduling and deck presets when present.

Apply with `dryRun: false`, `expectedImpactHash`, and `confirmExport: true`
or `confirmImport: true`, respectively. Use only trusted deck packages. These
tools do not handle full-collection backups (`.colpkg` or `collection.apkg`)
or upload packages. On an unconfirmed result, Anki may still be working; a
partial export or temporary import copy can remain at the reported path.
See [Anki's guide to importing packaged decks](https://docs.ankiweb.net/manual/importing/packaged-decks).

### Note tools

- `search-notes` — searches by native Anki query and returns paginated field
  previews, tags, and generated card IDs.
- `find-empty-notes` (**v1**) — finds notes with no cards, empty fields, or
  empty rendered questions. It never deletes anything.
- `get-note-details` — reads full fields, per-field SHA-256 hashes, and metadata
  for selected notes.
- `validate-note-drafts` — checks note drafts without saving them.
- `create-notes` — validates and submits up to 50 drafts and reports note
  and generated card IDs when available.
- `update-note-fields` — previews or applies guarded changes to selected fields.
- `convert-notes-to-note-type` (**v1**) — previews mapping fields and cards
  to another Normal note type without duplicating the notes.
- `edit-note-tags` — adds and removes selected tags, preserving unrelated tags.
- `replace-note-tag` (**v1**) — replaces a whole tag on up to 100 explicit note
  IDs. Matching is case-insensitive, and replacing `inbox` does not replace
  `inbox::later`. Apply with `confirmReplacement: true` and `expectedImpactHash`.
- `list-tags` — lists collection tags with filtering and pagination.
- `delete-unused-tags` (**v1**) — previews collection-wide removal of
  unreferenced tag registrations. It does not remove tags from notes.
- `delete-notes-and-cards` — previews deletion of up to 100 explicit notes
  and all of their cards, including cards in other decks.

#### Search and inspect

Use native [Anki search syntax](https://docs.ankiweb.net/manual/searching).
For example, send this to `search-notes`:

```json
{"query":"deck:German tag:A1","limit":20}
```

`search-notes` and `search-cards` default to cursor pagination in v1.
Pass `nextCursor` back as `cursor` with the same query and limit; `null`
ends the search. `total` and `offset` are `null` for cursor pages. Restart
if the cursor expires, was already consumed, or the profile changes.
Request `pagination: "offset"` or an explicit `offset` for an exact total
and numeric pages, which may require scanning the complete match set.
Legacy mode supports only offset pagination.

For `find-empty-notes`, choose `noCards`, `allFieldsEmpty` (using Anki's
HTML-aware normalization), or `allQuestionsEmpty` (all possible questions
render empty). `{"criterion":"noCards","query":"tag:inbox","limit":20}`
is a read-only example. The tool uses cursors without an exact total.
A cardless note may still contain useful data. Inspect it before considering
deletion.

#### Create notes

Pass the same draft shape to `validate-note-drafts` and `create-notes`.
Use an existing deck and exact note type and field names:

```json
{
  "notes": [
    {
      "deckName": "Languages::German",
      "modelName": "Basic",
      "fields": {
        "Front": "das Haus",
        "Back": "the house"
      },
      "tags": ["german", "a1"]
    }
  ]
}
```

Use `get-note-type-schema` to find the field names. To add media already in
Anki, use the draft's `mediaReferences` with the exact `filename` and
`fieldName` rather than embedding unverified references. A failed validation
blocks the batch before creation; an accepted batch can still have mixed
outcomes. `create-notes` is a write and does not have a `dryRun` option.

Check `noteResults` by `inputIndex`. `created` has a verified note ID and
card IDs; `created-unverified` retains the acknowledged note ID even if
readback failed. `not-created` and `not-attempted` indicate a known
rejection or lack of execution. `unknown` means a note may already exist.
If any outcome is unknown, `createdNoteCount` is `null`, not zero.
`reportedNoteIds` from a malformed reply are not mapped to inputs and
are not proof of creation. Inspect acknowledged IDs and do not blindly
resend the whole batch after a partial or unknown result.

#### Update fields, convert, or delete

Preview a patch with `update-note-fields`:

```json
{
  "updates": [
    {
      "noteId": 1234567890123,
      "fields": {"Front":"<b>das Haus</b><br>Translation: house"}
    }
  ]
}
```

Each submitted field replaces its **complete value**, including HTML.
Preserve any markup you want to keep; unspecified fields are not changed.
To apply, set `dryRun: false` and add `expectedFieldHashes` to each update,
keyed by the submitted field name. Use `beforeFieldHash` from the preview
or the corresponding `hash` from `get-note-details`. A missing or stale
hash blocks the whole patch before the first write. Preview snippets may
be truncated; hashes cover the full field.

For `convert-notes-to-note-type`, select up to 50 note IDs from one Normal
note type and a `targetNoteTypeId`. Review Anki's field and template
mappings, dropped nonempty values, and retained, removed, or possible new
cards. Apply with `dryRun: false`, `expectedImpactHash`, and
`confirmConversion: true`. Also set `confirmDataLoss: true` or
`confirmCardCreation: true` when indicated. The tool blocks Cloze
conversions, filtered cards, empty mapped first fields, notes that would
retain no existing card, and scopes above 500 cards. A conversion can
require a full sync.

For `delete-notes-and-cards`, preview `{"noteIds":[1234567890123]}` and
apply the same IDs with `dryRun: false`, `expectedImpactHash`, and
`confirmDeletion: true`. Missing notes or a changed snapshot block the
whole batch. Deletion removes the notes, **all** their cards and those
cards' history, but not media files.

For `delete-unused-tags`, preview with `{}` and apply with the same hash
and deletion confirmation. Cleanup can remove an unused parent registration
while keeping tags on notes such as `parent::child`. It includes notes
without cards and refuses scans beyond 50,000 tagged notes or 1,000
registered tags.

### Card tools

- `search-cards` — searches cards with Anki queries such as
  `deck:German is:due`. Uses the same pagination options as note search.
- `get-card-details` — reads fields and normalized scheduling for selected
  cards. Set `includeRenderedContent: true` for rendered front and back HTML.
- `get-card-preview` — returns Anki-rendered HTML, shared CSS, and restricted
  standalone documents for an existing card.
- `get-card-review-history` — returns bounded, newest-first review history.
- `predict-card-intervals` (**v1**) — shows Anki's predicted Again, Hard, Good,
  and Easy intervals without submitting an answer.
- `get-card-due-status` (**v1**) — checks a card's due time and per-card
  availability; `includeLearnAhead: true` also considers learn-ahead.
- `set-card-suspension` — suspends or unsuspends selected cards.
- `set-card-flag` — sets or clears a supported flag.
- `reschedule-cards` — applies Anki's Set Due Date syntax.
- `reset-cards-to-new` — resets scheduling without promising to erase history.
- `start-card-relearning` — starts relearning for active Review cards.
  In v1 it submits an **Again** answer and can change the review history,
  repetition/lapse counts, or leech state.

Use a **card ID**, not a note ID, for card operations. The five scheduling,
suspension, and flag mutation tools above apply immediately after preflight,
not in dry-run mode. They check the reviewed IDs and read back the relevant
state; an error may still follow a partial write. Interval predictions are
not exact due dates. The due-status tool does not account for daily deck
limits or promise that a card is next. A new card can be available without
being due. A general-purpose reviewer or arbitrary scheduling-field editor
is not exposed.

#### Inspect a card's HTML and CSS

Find a representative card and pass this to `get-card-preview`:

```json
{"cardId":1234567890123,"side":"both","theme":"light"}
```

Use `front`, `back`, or `both` for `side`, and `light` or `dark` for
`theme`. Anki renders the existing card; this is not a renderer for unsaved
template drafts. The tool returns untrusted raw `html` and a restricted
`document` for each selected side, plus CSS. The combined UTF-8 size of CSS
and selected raw HTML is limited to 256 KiB.

Open `document` separately in a viewer that honors its Content Security
Policy, or use a sandboxed iframe without scripts, same-origin access, or
navigation permissions. Never insert the raw HTML or CSS into a privileged
application page. The restricted copy removes scripts, event handlers, and
media source URLs; retained CSS relies on the document's CSP to block
external loads. The tool does not fetch media or run a browser; it produces
no screenshot, and media, custom fonts, or interactive layouts may be absent.

### Note type tools

A note type defines ordered fields, card templates, and shared CSS. A
template determines how a note becomes a card. Editing a type affects
**every card of that type**, not just a selected note. In name-based inputs
such as `create-notes`, `modelName` means the note type name.

- `list-note-types` — lists existing note types.
- `get-note-type-schema` — reads ordered fields, template field usage, and
  the Browser sort field (`null` in legacy mode).
- `get-note-type-design` — reads template names/order, front and back HTML,
  shared CSS, and the design hash.
- `create-note-type` — previews and creates a Normal or Cloze definition.
  Cloze requires one template with a `{{cloze:Field}}` front reference.
- `clone-note-type` — copies a design and ordered fields, not notes or cards.
  V1 also preserves the Browser sort field.
- `rename-note-type` (**v1**) — renames one type by ID. Apply with
  `confirmRename: true` and `expectedImpactHash`.
- `set-note-type-sort-field` (**v1**) — changes the Browser sort field, not
  the field order or duplicate-check field. Apply with `confirmChange: true`
  and `expectedImpactHash`.
- `delete-unused-note-type` (**v1**) — deletes an unused type, never the
  last remaining type or one used even by a cardless note. Apply with
  `confirmDeletion: true` and `expectedImpactHash`.
- `add-note-type-field` — inserts a field, initially empty on existing notes.
- `rename-note-type-field` — renames a field while retaining its values.
- `reposition-note-type-field` — changes the zero-based field order.
- `delete-note-type-field` — previews permanent removal of a field and its values.
- `add-note-type-template` — appends a template that can generate new cards.
- `rename-note-type-template` — renames a template without changing its
  HTML or recreating cards.
- `reposition-note-type-template` — changes the zero-based template order.
- `delete-note-type-template` — previews deletion of a template and its cards.
- `update-note-type-styling` — replaces the shared CSS.
- `update-note-type-templates` — replaces selected complete front/back sides.
- `replace-note-type-text` (**v1**) — previews literal, case-sensitive
  replacement in front HTML (`question`), back HTML (`answer`), or `css`
  for explicit type IDs. Does not edit note-field values.

#### Design and schema changes

Start with `get-note-type-design` or `get-note-type-schema`. Preview the
change, review validation and impact, and apply the same proposal with
`dryRun: false`:

| Workflow | Required guards on apply |
| --- | --- |
| Styling and template changes | `expectedDesignHash`. |
| Add a template | `expectedDesignHash`, `expectedNoteCount`, `confirmCardCreation: true`. |
| Delete a template | `expectedDesignHash`, `expectedCardCount`, `expectedNotesLosingLastCardCount`, `confirmCardDeletion: true`, plus `confirmNoteDeletion: true` if notes can lose their last card. The last template cannot be deleted. |
| Add, rename, or move a field | `expectedSchemaHash`. |
| Delete a field | `expectedSchemaHash`, `expectedNonEmptyNoteCount`, and `confirmDataLoss: true`. A field still referenced by a template, or the last field, cannot be deleted. |
| Clone a type | In v1, `expectedCloneHash` from `cloneHash`. In legacy mode, `expectedSourceDesignHash` from `sourceDesignHash`. |
| Replace literal text | `expectedImpactHash` and `confirmReplacement: true`. Up to 20 selected note types and 100 templates. |

`create-note-type` accepts ordered `fields`, `templates`, and shared `css`
and defaults to preview. In v1 it also accepts a `sortField` from those
fields. Field order still determines which first field Anki uses for
duplicate checks. A cloned type can be styled independently; the clone
does not copy field descriptions or editor font settings.

For example, preview a shared CSS color change with `replace-note-type-text`:

```json
{
  "noteTypeIds": [1234567890123],
  "targets": ["css"],
  "find": "#666",
  "replace": "#555"
}
```

Preview reports matches per template side or CSS and validation issues.
The server checks field references and CSS syntax locally; Anki is the
final authority when writing. Read back the saved design and use
`get-card-preview` on real cards after applying. These tools do not store
backups. Removing fields or cards can lose data and review history.

### Media tools

- `search-media-files` — searches filenames by a glob such as `gehen*.mp3`
  and returns a sorted page without reading file contents.
- `get-media-file` — reads one exact filename and returns size, MIME type,
  kind, and SHA-256. `includeContent: true` also returns a supported image
  or audio file up to 5 MiB as native MCP content.
- `store-media-file` — imports an image, audio file, video, or font up to
  25 MiB from base64, public HTTPS, or an allowed local path. It does not
  overwrite files: choose `collisionPolicy: "reject"` to refuse a collision
  instead of allowing Anki to choose a unique name.
- `find-media-references` — finds exact references in note fields, template
  HTML, and shared CSS. It returns a fingerprint only for a complete scan.
- `attach-media-to-notes` — adds a reference to existing media to a field
  without replacing unrelated HTML.
- `detach-media-from-notes` — removes matching references from fields
  without deleting the media file.
- `delete-media-file` — previews references and moves the file to Anki's
  media trash only after confirmation.

Store or locate media first and use the exact returned filename. For a
new note, use `mediaReferences`. For an existing note, preview
`attach-media-to-notes`, for example:

```json
{
  "attachments": [
    {"noteId":1234567890123,"fieldName":"Audio","filename":"gehen.mp3"}
  ]
}
```

To apply an attachment or detachment, set `dryRun: false` and pass the
preview's `beforeFieldHash` as `expectedFieldHash` for each field.
For assets referenced directly in templates or shared CSS, use a leading
underscore, such as `_logo.png` or `_inter.woff2`, and
`usage: "template-static"` when storing them. This keeps Anki's media
checker from treating those assets as unused.
See [Anki's media guide](https://docs.ankiweb.net/manual/media).

URL imports reject credentials, private addresses, and non-HTTPS sources.
Local imports resolve the source against the configured allowlist. Use
HTTPS or an allowed local source when a client cannot send a large base64
request. V1 storage waits for native completion and verifies stored bytes;
a lost response does not prove that the file was not saved.

To apply a media deletion, use `dryRun: false`, `confirmDeletion: true`,
`expectedSha256` from `file.sha256`, `expectedReferenceCount` from
`usage.totalReferenceCount`, and `expectedReferenceFingerprint` from
`usage.referenceFingerprint`. If references remain, also set
`confirmBrokenReferences: true` after reviewing what can break.

The fingerprint covers detected locations and occurrence counts before
sampling. Incomplete scans, including missing notes or unparseable shared
CSS, block deletion even with confirmation. Check `scanComplete` and
`cssScanFailures`; zero detected references on an incomplete scan is not
proof that a file is unused. The scanner does not evaluate runtime-generated
references or follow imported stylesheets. Deleting media is destructive
even when Anki initially moves the file to its media trash.

### Collection tools (v1)

- `get-collection-info` — reads the active profile, scheduler (`sm2` or
  `fsrs`), and opaque session.
- `refresh-collection` — refreshes windows. `target: "cachesAndWindows"`
  also invalidates the supported note type cache. It does not sync, reopen,
  or repair the database.
- `sync-collection` — syncs with the server configured in Anki.
  `includeMedia` defaults to `true` but respects the profile's media sync
  setting. Choose the direction for a full sync yourself in Anki.
- `check-collection-integrity` — runs native **Tools → Check Database**.
  It can repair data and clear Undo history; it does not make a backup.
- `undo-collection-action` — undoes the current undoable action, which
  might be a manual edit. There is no preview of the actual entry and no
  way to select it by ID. Do not use Undo as automatic rollback.
- `get-collection-operation` — reads the status and eventual result of a
  submitted sync, integrity check, or Undo.
- `cancel-collection-operation` — requests cancellation by `operationId`
  for an operation started by this running MCP server.

Sync, integrity checks, and Undo first return a preview of the request and
profile. Apply the same options with `dryRun: false`, `confirm: true`, and
the one-use `confirmationToken` from the preview. It expires after
120 seconds. The preview does not contact the sync server, check the
database, or reveal the Undo entry. Do not edit or study between preview
and confirmation of Undo.

Submission returns an `operationId`, **not** a completed result. Check
it with `get-collection-operation` on the same running server. If the
state is `waitingForUser`, respond in Anki and check that same ID again.
A full sync may change the collection session, but the receipt still tracks
the original operation. If the acknowledgement is lost, inspect Anki
before restarting MCP; do not launch a second operation blindly.

If the user asks to stop a tracked operation, pass its `operationId` to
`cancel-collection-operation`. `requested: true` acknowledges the request,
not the outcome. A queued operation may be stopped before it starts; a
running operation may refuse cancellation or finish first. Check the
same ID until the status is known. Cancellation does not roll back changes
and should not be resent after a lost acknowledgement.

### Study statistics

- `get-study-stats` — reports review counts for today and recent days with
  activity across the collection. `limitDays` defaults to 30 active days,
  not calendar days. Today uses Anki's study-day boundary. V1 also returns
  `todayDate` and `nextDayAt`; legacy returns `null` for those fields.
- `get-study-summary` (**v1**) — reports totals for the collection (`{}`)
  or one `deckId` and its descendants. It includes card counts, notes linked
  to cards, recorded reviews, and review time across available history.
  Cardless notes do not count. Use `get-deck-stats` for current scheduler
  workload instead of interpreting historical totals as due counts.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Client cannot launch the server | Confirm Node.js 24+ is on the client's PATH. For a source checkout, run `npm run build` and verify the absolute path to `dist/mcp/server.js`. Before the first npm release, use the source setup. |
| Server appears to wait silently | This is expected for stdio. The client must launch it and send MCP messages. The process does not listen on an MCP HTTP port. |
| Connection refused or `ANKI_NETWORK_ERROR` | Keep Anki Desktop open, verify the AnkiConnect add-on is enabled, and check `ANKI_URL`. |
| `ANKI_CONFIGURATION_ERROR` | Check the URL, API mode, timeout, or required directory setting. Configuration errors do not send the invalid request. |
| HTTP error, invalid JSON, or invalid response | Check the direct AnkiConnect base endpoint and mode. Do not include `/api/v1` in `ANKI_URL`. A proxy login page or redirect is not an API response. |
| `ANKI_V1_ERROR` / `methodNotFound` | Check that AnkiConnect exposes v1 and supports the method. Use legacy only for tools that support it. |
| Stale session, cursor, hash, or token | Open the intended profile, repeat the read or preview, and review the new result before applying. |
| Timeout, disconnected client, or failed verification | Do not assume nothing happened. Check operation status or current Anki data before retrying. |

For a read-only v1 endpoint check, use the base address configured in your
client:

```bash
curl -fsS http://127.0.0.1:8765/api/v1 \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"collection.get","params":{}}'
```

All AnkiConnect exchanges in one server process share a four-request FIFO
limit. The request deadline includes queue time, connection, headers, and
body reading. It does not set the MCP client's overall timeout and is
separate from the public HTTPS media download deadline. HTTP aborts do not
automatically cancel an Anki operation.

## Development and releases

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies from the lockfile. |
| `npm run dev` | Run the TypeScript stdio entry point in watch mode. |
| `npm test` | Run unit, integration, and stdio tests without changing a real Anki collection. |
| `npm run typecheck` | Check application and test types without emitting files. |
| `npm run build` | Clean and compile application code into `dist/`; tests are not bundled. |
| `npm start` | Run `dist/mcp/server.js` after building. |
| `npm pack --dry-run` | Review the files that would be shipped to npm. Run after building. |

The server uses the MCP TypeScript SDK v2. Tests cover MCP protocol revisions
`2025-11-25` and `2026-07-28`, independent of the AnkiConnect API mode.
The stdio inbound buffer limit is 40 MiB, allowing up to 25 MiB of media
encoded as base64 plus JSON overhead. Clients can impose smaller limits.
Keep logs on stderr and reserve stdout for MCP messages.

```text
anki-api/              Typed AnkiConnect clients, v1 adapters, and HTTP transport
mcp/create-server.ts   Server factory and tool registration
mcp/tools/             Domain tools, schemas, and guard logic
mcp/server.ts          CLI entry point
mcp/stdio.ts           MCP transport and protocol compatibility
tests/                Unit, API, MCP, and stdio tests
dist/                 Generated application build
```

When adding a tool, put the native API call in `anki-api/` and the MCP
handler in the relevant `mcp/tools/` module. Define Zod input/output
schemas, register the tool in its domain, and test preview, apply, and error
behavior where applicable. Use `.js` extensions for relative imports in
TypeScript because the project uses NodeNext and emits Node.js ESM.

[GitHub Actions](https://github.com/Ryhus/anki-mcp/actions) runs install,
tests, type checking, build, and package inspection on pull requests
and pushes to `main` and `develop`. It does not publish automatically.

For maintainers preparing a release:

1. Run the same checks from a clean checkout and install the actual
   `npm pack` archive into a separate directory. Verify the `anki-mcp` bin
   and check that the archive includes only the built server, README,
   license, and package metadata.
2. Open a PR from `develop` to `main` and wait for the `Validate` check on
   the release code. Merge through the PR and tag the merged commit with
   the version from `package.json`, for example `v0.1.0`.
3. For an npm release, verify that `npm whoami` uses an account with
   publishing access to `@ryhus`. Publish from the verified release
   checkout; `npm publish --access public` makes the scoped package public.
   Verify that the pinned package command installs before announcing it.
   See [npm's scoped publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

## License

[MIT](LICENSE).
