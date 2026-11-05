# Anki MCP

Use Anki Desktop from a local MCP client. Search, create, and edit notes;
manage decks and cards; preview card HTML/CSS; and work with media and
`.apkg` deck packages.

## Quick start

1. Install **Node.js 24 or newer** with npm.
2. In [Anki Desktop](https://apps.ankiweb.net/), install
   [AnkiConnect](https://ankiweb.net/shared/info/2055492159) via
   **Tools → Add-ons → Get Add-ons** with code `2055492159`.
   Restart Anki and keep it open.
3. Add the following **local stdio server** to your MCP client. This example
   works once `@ryhus/anki-mcp@0.1.0` is published on npm; no clone or global
   install is needed.

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

If your client has a form, put only `npx` in **Command**, enter the three
**Arguments** separately, and add the two **Environment variables** shown
above. `ANKI_URL` is the AnkiConnect address, not a remote MCP URL.

Reload the client and ask: **“List my Anki decks without changing anything.”**

## Try it

- “Find German notes tagged `a1` that mention `Haus`.”
- “Draft three vocabulary notes for my German deck. Show me the drafts before creating them.”
- “Show me the front and back HTML of this card without changing it.”
- “Preview an export of my German deck without review history.”

## Settings

- `ANKI_API_MODE=v1` enables the full tool set with a compatible AnkiConnect
  build. For an older add-on, use `legacy` for the supported subset.
- To enable local `.apkg` import or export, set `ANKI_PACKAGE_IMPORT_DIR`
  or `ANKI_PACKAGE_EXPORT_DIR` to an existing, trusted absolute folder.
  Each is enabled separately and requires local AnkiConnect v1.
- To import media from disk, allowlist its source folder with
  `ANKI_MEDIA_IMPORT_DIRS`. Public HTTPS and base64 sources do not need
  this setting.

Review previews before approving destructive changes. Not every tool offers
a preview. The server does not make backups or automatically retry writes;
after an error, check Anki before repeating the action.

## Troubleshooting

- **The client cannot find `npx`:** make sure both Node and npm are on the
  client's PATH. On Windows, use `npx.cmd` if your client needs the shim.
- **Anki is unreachable:** check that Anki is open and AnkiConnect is enabled.
  Use the base address in `ANKI_URL` without `/api/v1`.
- **The package is not found:** check that the pinned version has been
  published and that your client can reach the npm registry.

[MIT License](LICENSE).
