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
```

`ANKI_URL` must point to the HTTP endpoint exposed by AnkiConnect. The example
uses its usual local address; change it if your AnkiConnect instance uses a
different host or port.

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

Runs the unit tests for local validation and transformation logic. These tests
do not require Anki to be running.

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
│   ├── notes/
│   │   ├── note-client.ts    # Typed AnkiConnect note operations
│   │   └── note-types.ts     # AnkiConnect note response types
│   └── note-types/
│       ├── note-type-client.ts # Typed note-type discovery and design operations
│       └── note-type-types.ts  # AnkiConnect note-type response types
├── mcp/
│   ├── server.ts             # MCP server entry point
│   ├── tools/
│   │   ├── cards/            # Card tool contracts and handlers
│   │   ├── decks/            # Deck tool contracts and handlers
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
- inspecting, cloning, and redesigning note types.

### Card tools

- `search-cards` searches with Anki query syntax and returns a bounded page of
  scheduling summaries.
- `get-card-details` returns note fields and normalized scheduling data for
  selected cards.
- `get-card-review-history` returns bounded, newest-first review history.
- `set-card-suspension` suspends or unsuspends cards.
- `set-card-flag` safely applies one of Anki's supported flag colors.
- `reschedule-cards` changes due dates with Anki's Set Due Date syntax.
- `reset-cards-to-new` resets card scheduling progress.
- `start-card-relearning` moves cards into the relearning state.

Low-level scheduling field and ease-factor setters are not exposed to MCP
clients. Answering cards is also deferred to a future user-driven review
workflow so an LLM cannot create review history on the user's behalf.

### Deck tools

- `list-decks` lists every deck with its ID and hierarchy metadata.
- `create-deck` creates a deck or returns the existing deck with the same name.
- `get-deck-stats` returns scheduler counts for selected or all decks.
- `get-card-decks` groups card IDs by their current deck.
- `move-cards-to-deck` moves cards and creates the target deck when necessary.
- `delete-deck-and-cards` permanently deletes one deck and all of its cards.

Low-level deck configuration ID operations are not exposed to MCP clients.
Deck option management will be added separately after its behavior has been
validated against current Anki versions.

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
- `get-note-details` returns complete ordered fields and metadata for selected
  notes.
- `validate-note-drafts` checks decks, note types, field names, empty-card
  rules, and duplicates without creating anything.
- `create-notes` validates and creates a bounded batch, then returns both note
  IDs and generated card IDs.
- `update-note-fields` applies partial field patches only after validating the
  complete batch.
- `edit-note-tags` adds and removes selected tags without replacing unrelated
  tags.
- `list-tags` returns a filtered, paginated view of collection tags.
- `delete-notes-and-cards` permanently deletes explicit note IDs and all cards
  generated from them.

Media attachment, global tag replacement, unused-tag cleanup, and changing an
existing note to another note type are intentionally deferred because they
require additional safety and data-preservation rules.

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

### The server appears to wait without printing anything

This is expected for an MCP server using `stdio`. It waits for protocol
messages from an MCP client.

## License

This project is licensed under the [MIT License](LICENSE).
