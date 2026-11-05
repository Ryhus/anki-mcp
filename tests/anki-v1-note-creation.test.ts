import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { createNotes } from "../mcp/tools/notes/create-notes.js";
import { noteCreationOutputSchema } from "../mcp/tools/notes/note-creation-schemas.js";
import { interpretV1NoteCreationReply } from "../mcp/tools/notes/note-creation-v1-results.js";
import { creationInput } from "./helpers/note-creation-fixture.js";

const privateText = "private-v1-creation-response";
const accepted = (index: number) => ({
  index, result: { noteId: String(100 + index), cardIds: [String(200 + index)] },
});
const rejected = (index: number, code: number) => ({ index, error: { code, message: privateText } });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function fixture(t: TestContext) {
  const previous = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765/";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = {
    calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
    validation: undefined as unknown,
    creation: undefined as unknown,
    failure: "" as "" | "lost" | "stale-write" | "stale-readback",
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1", "no legacy fallback");
    const { id, method, params } = JSON.parse(String(init.body)) as {
      id: string; method: string; params: Record<string, unknown>;
    };
    state.calls.push({ method, params });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const stale = () => Response.json({ jsonrpc: "2.0", id, error: rejected(0, 1005).error });
    if (method === "collection.get") return ok({ session: "pinned" });
    assert.equal(params.session, "pinned");
    switch (method) {
      case "decks.list": return ok([{ id: "1", name: "Fixture" }, { id: "2", name: "Scope" }]);
      case "noteTypes.list": return ok([{ id: "100", name: "Basic" }]);
      case "noteTypes.get": return ok({
        id: "100", name: "Basic", fields: [{ name: "Front" }, { name: "Back" }],
        templates: [{ name: "Card 1", questionHtml: "{{Front}}", answerHtml: "{{Back}}" }], css: "",
      });
      case "media.get": return ok({ filename: params.filename, data: png });
      case "notes.validateMany": return ok(state.validation ?? {
        items: (params.notes as unknown[]).map((_note, index) => ({
          index, result: { valid: true, issues: [], duplicateNoteIds: [] },
        })).reverse(),
      });
      case "notes.createMany":
        assert.equal(params.atomic, false);
        if (state.failure === "lost") throw new TypeError(privateText);
        if (state.failure === "stale-write") return stale();
        return ok(state.creation ?? { items: (params.notes as unknown[]).map((_note, index) => accepted(index)).reverse() });
      case "notes.getMany":
        if (state.failure === "stale-readback") return stale();
        return ok({ items: (params.ids as string[]).map((id, index) => ({
          index, result: {
            id, noteType: { id: "100", name: "Basic" }, fields: { Front: "fixture" },
            tags: [], cardIds: [String(Number(id) + 100)], modifiedAt: "2026-11-05T12:00:00Z",
          },
        })) });
      default: assert.fail(`Unexpected method ${method}`);
    }
  });
  return state;
}

test("v1 pins all preparation, media, validation, creation, and verification to one session", async (t) => {
  const state = fixture(t);
  const input = creationInput();
  input.notes[0]!.options = {
    allowDuplicate: false, duplicateScope: "deck", duplicateScopeDeckName: "Scope",
    checkChildren: true, checkAllModels: true,
  };
  input.notes[0]!.mediaReferences = [{ filename: "pixel.png", fieldName: "back", placement: "append" }];
  const result = noteCreationOutputSchema.parse((await createNotes(input)).structuredContent);
  assert.equal(result.outcome, "complete");
  assert.deepEqual(result.createdNotes.map(({ inputIndex, noteId }) => [inputIndex, noteId]), [[0, 100], [1, 101], [2, 102]]);
  assert.deepEqual(state.calls.map(({ method }) => method), [
    "collection.get", "decks.list", "noteTypes.list", "media.get", "noteTypes.get",
    "notes.validateMany", "notes.createMany", "notes.getMany",
  ]);
  const validation = state.calls.find(({ method }) => method === "notes.validateMany")!.params;
  const creation = state.calls.find(({ method }) => method === "notes.createMany")!.params;
  assert.deepEqual(creation.notes, validation.notes);
  assert.deepEqual((creation.notes as unknown[])[0], {
    deck: { name: "Fixture" }, noteType: { name: "Basic" },
    fields: { Front: "Front 0", Back: '<b>Back</b><img src="pixel.png">' },
    tags: ["fixture"],
    duplicates: { allow: false, scope: "deck", deck: { name: "Scope" }, includeChildren: true, acrossNoteTypes: true },
    rejectEmptyQuestions: true,
  });
});

for (const malformed of [false, true]) {
  test(`v1 ${malformed ? "malformed validation" : "duplicate validation"} prevents any creation`, async (t) => {
    const state = fixture(t);
    const duplicate = { index: 1, result: { valid: false, issues: [{ type: "duplicate", message: privateText }], duplicateNoteIds: ["99"] } };
    const good = { index: malformed ? 1 : 0, result: { valid: true, issues: [], duplicateNoteIds: [] } };
    state.validation = { items: [duplicate, good] };
    const result = noteCreationOutputSchema.parse((await createNotes(creationInput(2))).structuredContent);
    assert.equal(result.outcome, "not-attempted");
    assert.equal(result.createdNoteCount, 0);
    assert.equal(state.calls.at(-1)?.method, "notes.validateMany");
    if (!malformed) assert.match(result.validations[1]?.error ?? "", /matching Note/u);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText, "u"));
  });
}

for (const [failure, expected] of [["lost", "unknown"], ["stale-write", "not-attempted"], ["stale-readback", "incomplete"]] as const) {
  test(`v1 creation ${failure} preserves the proper outcome without replay`, async (t) => {
    const state = fixture(t);
    state.failure = failure;
    const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
    assert.equal(result.outcome, expected);
    assert.equal(result.createdNoteCount, failure === "lost" ? null : failure === "stale-write" ? 0 : 3);
    assert.equal(state.calls.filter(({ method }) => method === "notes.createMany").length, 1);
    assert.equal(state.calls.filter(({ method }) => method === "notes.getMany").length, failure === "stale-readback" ? 1 : 0);
    if (failure === "stale-readback") assert.deepEqual(result.createdNotes.map(({ noteId, cardIds }) => [noteId, cardIds]), [[100, null], [101, null], [102, null]]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText, "u"));
  });
}

test("v1 malformed or duplicate indexes and IDs retain bounded evidence without guessing", () => {
  for (const items of [
    [accepted(0)],
    [accepted(0), accepted(0)],
    [accepted(0), { index: 1, result: accepted(0).result }],
    [accepted(0), accepted(2)],
    [accepted(0), { index: 1, result: { noteId: "101", cardIds: [privateText] } }],
    [accepted(0), { index: 1, result: { noteId: "9007199254740993", cardIds: [] } }],
    Array.from({ length: 80 }, (_, index) => accepted(index)),
  ]) {
    const result = interpretV1NoteCreationReply({ items }, 2);
    assert.equal(result.valid, false);
    assert.ok(result.noteResults.every(({ status, noteId }) => status === "unknown" && noteId === null));
    assert.ok(result.reportedNoteIds.includes(100));
    assert.equal(result.reportedNoteIdsTruncated, items.length > 50);
    assert.ok(result.reportedNoteIds.length <= 50);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText, "u"));
  }
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: v1 partial rejection and uncertain item keep verified siblings`, async (t) => {
    const state = fixture(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "v1-create-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(clientTransport);
    for (const code of [1002, -32603]) {
      state.creation = { items: [accepted(2), rejected(1, code), accepted(0)] };
      const response = await client.callTool({ name: "create-notes", arguments: creationInput() });
      const result = noteCreationOutputSchema.parse(response.structuredContent);
      assert.equal(response.isError, true);
      assert.equal(result.createdNoteCount, code === 1002 ? 2 : null);
      assert.deepEqual(result.noteResults.map(({ status }) => status), [
        "created", code === 1002 ? "not-created" : "unknown", "created",
      ]);
      assert.deepEqual(result.createdNotes.map(({ inputIndex, noteId }) => [inputIndex, noteId]), [[0, 100], [2, 102]]);
      assert.deepEqual(state.calls.at(-1)?.params.ids, ["100", "102"]);
      assert.doesNotMatch(JSON.stringify(response), new RegExp(privateText, "u"));
    }
    assert.equal(state.calls.filter(({ method }) => method === "notes.createMany").length, 2);
  });
}
