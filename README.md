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

The `.env` file is excluded from Git.

## Development commands

### Start the development server

```bash
npm run dev
```

Runs the source entry point with `tsx` and watches the project for changes.
The server is restarted automatically after a source file changes.

The entry point is currently `mcp/server.js`. Change the `dev` script to
`mcp/server.ts` after that file is migrated to TypeScript.

### Check TypeScript types

```bash
npm run typecheck
```

Runs the TypeScript compiler without generating output. Use this command
frequently while changing types or migrating a file.

### Build the project

```bash
npm run build
```

Compiles the source tree into `dist/`. The generated directory mirrors the
source structure and includes source maps.

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
5. Run `npm run typecheck`.
6. Run `npm run build`.
7. Test the affected tools through an MCP client connected to the server.

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
│   └── anki-request.js       # HTTP client for AnkiConnect
├── mcp/
│   ├── server.js             # MCP server entry point and tool registration
│   ├── tools/
│   │   ├── card-tools.js     # Card-related operations
│   │   ├── deck-tools.js     # Deck-related operations
│   │   └── note-tools.js     # Note-related operations
│   └── utils/
│       └── formatting.js     # MCP response formatting
├── dist/                     # Generated build output
├── package.json
└── tsconfig.json
```

The server currently exposes tools for:

- creating, deleting, inspecting, and configuring decks;
- finding, inspecting, moving, suspending, and reviewing cards;
- creating, finding, updating, tagging, and deleting notes.

## Adding an MCP tool

1. Add the implementation to the appropriate module in `mcp/tools/`.
2. Call Anki through `callAnki` from `anki-api/anki-request`.
3. Return an MCP-compatible result, normally through `formatResult`.
4. Import and register the tool in `mcp/server`.
5. Define its input schema with Zod.
6. Run the type check and build:

```bash
npm run typecheck
npm run build
```

Keep tool names and descriptions clear because MCP clients expose them directly
to language models.

## TypeScript migration

The compiler currently has `allowJs` enabled and `checkJs` disabled. Existing
JavaScript files are copied into `dist/`, while migrated `.ts` files receive
strict type checking.

Migrate one module at a time:

1. Rename a `.js` source file to `.ts`.
2. Add explicit types for function parameters and AnkiConnect responses.
3. Resolve all errors reported by `npm run typecheck`.
4. Build and test the affected MCP tools.

When using the `NodeNext` module system, keep `.js` extensions in relative
imports inside TypeScript source files:

```ts
import { callAnki } from "../../anki-api/anki-request.js";
```

TypeScript resolves this import to the corresponding `.ts` source file and
preserves the `.js` extension required by Node.js in the compiled output.

After every source file has been migrated:

1. Update the `dev` script to use `mcp/server.ts`.
2. Set `allowJs` to `false` in `tsconfig.json`.
3. Run `npm run typecheck` and `npm run build`.

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
