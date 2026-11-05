import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, ProtocolError } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createServer } from "../mcp/create-server.js";
import { listDecksConfig } from "../mcp/tools/decks/list-decks.js";
import { getMediaFileConfig } from "../mcp/tools/media/get-media-file.js";
import { createNoteTypeConfig } from "../mcp/tools/note-types/create-note-type.js";
import { getNoteDetailsConfig } from "../mcp/tools/notes/get-note-details.js";
import { updateNoteFieldsConfig } from "../mcp/tools/notes/update-note-fields.js";

const EXPECTED_TOOLS = [
  "list-decks", "create-deck", "rename-deck", "get-deck-stats", "get-card-decks",
  "list-deck-presets", "get-deck-preset", "create-deck-preset", "update-deck-preset",
  "assign-deck-preset", "delete-deck-preset",
  "move-cards-to-deck", "delete-deck-and-cards", "search-cards",
  "get-card-details", "get-card-preview", "get-card-review-history", "predict-card-intervals", "get-card-due-status", "set-card-suspension",
  "set-card-flag", "reschedule-cards", "reset-cards-to-new",
  "start-card-relearning", "list-note-types", "get-note-type-schema",
  "get-note-type-design", "clone-note-type", "create-note-type", "rename-note-type",
  "set-note-type-sort-field", "delete-unused-note-type",
  "add-note-type-field", "rename-note-type-field", "reposition-note-type-field",
  "delete-note-type-field", "add-note-type-template", "rename-note-type-template",
  "reposition-note-type-template", "delete-note-type-template",
  "update-note-type-styling", "update-note-type-templates", "search-notes", "find-empty-notes",
  "get-note-details", "validate-note-drafts", "create-notes", "update-note-fields", "convert-notes-to-note-type",
  "edit-note-tags", "replace-note-tag", "list-tags", "delete-notes-and-cards", "search-media-files",
  "get-media-file", "store-media-file", "find-media-references",
  "attach-media-to-notes", "detach-media-from-notes", "delete-media-file", "get-study-stats", "get-study-summary",
].sort();

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const wav = Buffer.alloc(48);
wav.write("RIFF", 0);
wav.writeUInt32LE(40, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8_000, 24);
wav.writeUInt32LE(16_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(4, 40);

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`all tools and result contracts work on MCP ${version}`, async (t) => {
    const modern = version === "2026-07-28";
    const originalAnkiUrl = process.env.ANKI_URL;
    process.env.ANKI_URL = "http://127.0.0.1:8765";
    t.after(() => {
      if (originalAnkiUrl === undefined) delete process.env.ANKI_URL;
      else process.env.ANKI_URL = originalAnkiUrl;
    });
    const actions: string[] = [];
    let front = "<b>das Haus</b>";
    let failDeckLookup = false;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      const { action, params } = JSON.parse(String(init?.body)) as {
        action: string;
        params?: { filename?: string; note?: { fields: { Front: string } } };
      };
      actions.push(action);
      let result: unknown;
      switch (action) {
        case "deckNamesAndIds":
          return Response.json({
            result: failDeckLookup ? null : { Default: 1 },
            error: failDeckLookup ? "Mock Anki failure" : null,
          });
        case "notesInfo":
          result = [{
            noteId: 1, modelName: "Basic", tags: [], mod: 1_700_000_000,
            cards: [10], fields: { Front: { value: front, order: 0 } },
          }];
          break;
        case "modelNamesAndIds":
          result = { Basic: 1 };
          break;
        case "updateNoteFields":
          assert.ok(params?.note);
          front = params.note.fields.Front;
          result = null;
          break;
        case "retrieveMediaFile":
          result = params?.filename === "pixel.png" ? PNG : wav.toString("base64");
          break;
        default:
          throw new Error(`Unexpected Anki action: ${action}`);
      }
      return Response.json({ result, error: null });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "migration-tests", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: modern ? { pin: version } : "legacy" },
    });
    t.after(async () => {
      await client.close();
      await handle.close();
    });
    await client.connect(clientTransport);
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    assert.equal(client.getServerVersion()?.name, "anki-mcp-server");

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), EXPECTED_TOOLS);
    assert.equal(actions.length, 0, "registration and discovery must not call Anki");
    const validator = new AjvJsonSchemaValidator();
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} must declare an output schema`);
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        // The SDK's wire schema type is broader than the validator's input type.
        assert.equal(typeof validator.getValidator(schema as JsonSchemaType), "function");
      }
    }

    const decks = await client.callTool({ name: "list-decks" });
    assert.equal(decks.isError, undefined);
    const deckResult = listDecksConfig.outputSchema.parse(decks.structuredContent);
    assert.deepEqual(deckResult.decks, [
      { id: 1, name: "Default", parentName: null, depth: 0 },
    ]);
    assert.ok(decks.content.some((content) => content.type === "text"));

    const details = getNoteDetailsConfig.outputSchema.parse(
      (await client.callTool({
        name: "get-note-details", arguments: { noteIds: [1] },
      })).structuredContent,
    );
    const hash = details.notes[0]?.fields.Front?.hash;
    assert.ok(hash);
    const patch = { noteId: 1, fields: { Front: "<b>House</b>" } };
    const preview = updateNoteFieldsConfig.outputSchema.parse(
      (await client.callTool({
        name: "update-note-fields", arguments: { updates: [patch] },
      })).structuredContent,
    );
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false);
    assert.equal(actions.includes("updateNoteFields"), false);
    const readsBeforeInvalidCall = actions.length;
    const invalid = await client.callTool({
      name: "update-note-fields", arguments: { dryRun: false, updates: [patch] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(actions.length, readsBeforeInvalidCall);

    const invalidStaticMedia = await client.callTool({
      name: "store-media-file",
      arguments: {
        filename: "pixel.png", usage: "template-static",
        source: { type: "base64", data: PNG },
      },
    });
    assert.equal(invalidStaticMedia.isError, true);
    assert.equal(actions.length, readsBeforeInvalidCall);

    front += "<br>Manual edit";
    const stale = updateNoteFieldsConfig.outputSchema.parse(
      (await client.callTool({
        name: "update-note-fields",
        arguments: {
          dryRun: false, updates: [{ ...patch, expectedFieldHashes: { Front: hash } }],
        },
      })).structuredContent,
    );
    assert.equal(stale.applied, false);
    assert.equal(stale.rejectedUpdates.length, 1);
    assert.equal(actions.includes("updateNoteFields"), false);

    const currentHash = stale.changes[0]?.beforeFieldHash;
    assert.ok(currentHash);
    const proposed = `${front}<br>Translation: house`;
    const applied = updateNoteFieldsConfig.outputSchema.parse(
      (await client.callTool({
        name: "update-note-fields",
        arguments: {
          dryRun: false,
          updates: [{
            noteId: 1, fields: { Front: proposed },
            expectedFieldHashes: { Front: currentHash },
          }],
        },
      })).structuredContent,
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.verified, true);
    assert.equal(front, proposed);

    const noteTypePreview = createNoteTypeConfig.outputSchema.parse(
      (await client.callTool({
        name: "create-note-type",
        arguments: {
          modelName: "Migration preview", fields: ["Front", "Back"],
          templates: [{
            name: "Card 1", front: "{{Front}}", back: "{{FrontSide}}<hr>{{Back}}",
          }],
        },
      })).structuredContent,
    );
    assert.equal(noteTypePreview.dryRun, true);
    assert.equal(noteTypePreview.created, false);
    assert.equal(noteTypePreview.validation.valid, true);
    assert.equal(actions.includes("createModel"), false);

    for (const [filename, kind] of [["pixel.png", "image"], ["voice.wav", "audio"]] as const) {
      const media = await client.callTool({
        name: "get-media-file", arguments: { filename, includeContent: true },
      });
      const metadata = getMediaFileConfig.outputSchema.parse(media.structuredContent);
      assert.equal(metadata.contentIncluded, true);
      assert.equal(metadata.file?.kind, kind);
      assert.ok(media.content.some((content) => content.type === kind));
    }

    failDeckLookup = true;
    const failure = await client.callTool({ name: "list-decks" });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /Mock Anki failure/u);
    await assert.rejects(
      client.callTool({ name: "unknown-tool" }),
      (error: unknown) => error instanceof ProtocolError,
    );
  });
}
