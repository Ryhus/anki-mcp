import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: v1 reads and native cursors preserve the legacy offset contract`, async (t) => {
    const saved = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
    process.env.ANKI_URL = "http://127.0.0.1:8765/";
    process.env.ANKI_API_MODE = "v1";
    t.after(() => {
      for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
        const value = saved[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const calls: string[] = [];
    let continued = false;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const { action, method, params = {}, id } = JSON.parse(String(init.body)) as {
        action?: string; method?: string; params?: Record<string, unknown>; id?: string;
      };
      calls.push(method ?? action!);
      if (method === undefined) {
        assert.equal(new URL(url).pathname, "/");
        if (action === "findNotes") return Response.json({ result: [1, 2, 3], error: null });
        if (action === "notesInfo") {
          assert.deepEqual(params, { notes: [1] });
          return Response.json({ result: [{
            noteId: 1, modelName: "Basic", tags: ["noun"], cards: [101], mod: 1_700_000_000,
            fields: { Front: { value: "<b>Cat</b>", order: 0 } },
          }], error: null });
        }
        assert.fail(`Unexpected legacy action: ${action}`);
      }
      assert.equal(new URL(url).pathname, "/api/v1");
      const success = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "decks.list": return success([{ name: "Default", id: "1" }]);
        case "decks.create":
          assert.deepEqual(params, { name: "Fixture", session: "test-session" });
          return success({ name: "Fixture", id: "2", kind: "normal" });
        case "noteTypes.list": return success([{ name: "Basic", id: "100" }]);
        case "tags.list": return success(["noun"]);
        case "collection.get": return success({ session: "test-session" });
        case "notes.search":
          if (params.limit === 1_000) return success({ ids: ["1", "2", "3"], nextCursor: null });
          assert.deepEqual(params, {
            query: "", limit: 2, session: "test-session",
            ...(params.cursor === undefined ? {} : { cursor: "next-page" }),
          });
          if (params.cursor === undefined) return success({ ids: ["1", "2"], nextCursor: "next-page" });
          if (!continued) {
            continued = true;
            return success({ ids: [], nextCursor: null });
          }
          return Response.json({ jsonrpc: "2.0", id, error: { code: 1014, message: "expired" } });
        case "notes.getMany":
          assert.equal(params.session, "test-session");
          assert.deepEqual(params.ids, (params.ids as string[]).length === 1 ? ["1"] : ["1", "2"]);
          return success({ items: [
            { index: 0, result: {
              id: "1", noteType: { id: "100", name: "Basic" }, tags: ["noun"],
              cardIds: ["101"], modifiedAt: "2023-11-14T22:13:20Z", fields: { Front: "<b>Cat</b>" },
            } },
            ...((params.ids as string[]).length === 1 ? [] : [{ index: 1, error: { code: 1001, message: "not found" } }]),
          ] });
        case "noteTypes.get":
          assert.deepEqual(params, { noteType: { name: "Basic" }, session: "test-session" });
          return success({
            id: "100", name: "Basic", css: "", fields: [{ name: "Front" }],
            templates: [{ name: "Card 1", questionHtml: "{{Front}}", answerHtml: "{{FrontSide}}" }],
          });
        case "cards.search":
          assert.equal(params.session, "test-session");
          if (params.query === "") {
            assert.equal(params.limit, 2);
            return success(params.cursor === undefined ? { ids: ["101"], nextCursor: "card-page" } : { ids: [], nextCursor: null });
          }
          assert.equal(params.query, "cid:101 (is:new or is:due) -is:suspended -is:buried");
          return success({ ids: ["101"], nextCursor: null });
        case "cards.getMany":
          assert.deepEqual(params, { ids: ["101"], session: "test-session" });
          return success({ items: [{ index: 0, result: {
            id: "101", noteId: "1", deck: { id: "1", name: "Default" }, homeDeck: null,
            templateIndex: 0, flags: 0, modifiedAt: "2023-11-14T22:13:20Z",
            scheduling: {
              type: "new", queue: "new", due: { kind: "position", position: 0 },
              intervalDays: 0, remainingSteps: 0, repetitions: 0, lapses: 0, sm2EasePermille: 0,
            },
          } }] });
        default: assert.fail(`Unexpected v1 method: ${method}`);
      }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "anki-v1-tests", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 45);
    assert.deepEqual(calls, []);
    const decks = await client.callTool({ name: "list-decks" });
    assert.deepEqual(decks.structuredContent, { decks: [{ id: 1, name: "Default", parentName: null, depth: 0 }] });
    const types = await client.callTool({ name: "list-note-types" });
    assert.deepEqual(types.structuredContent, { noteTypes: [{ id: 100, name: "Basic" }] });
    const tags = await client.callTool({ name: "list-tags" });
    assert.deepEqual(tags.structuredContent, { prefix: "", total: 1, offset: 0, returned: 1, hasMore: false, tags: ["noun"] });

    const input = { query: "", limit: 2 };
    const first = await client.callTool({ name: "search-notes", arguments: input });
    assert.notEqual(first.isError, true);
    const note = {
      noteId: 1, modelName: "Basic", tags: ["noun"], cardIds: [101],
      fieldPreviews: { Front: "Cat" }, modifiedAt: "2023-11-14T22:13:20.000Z",
    };
    assert.deepEqual(first.structuredContent, {
      query: "", total: null, offset: null, returned: 1, hasMore: true, nextCursor: "next-page",
      notes: [note], missingNoteIds: [2],
    });
    assert.deepEqual(calls, ["decks.list", "noteTypes.list", "tags.list", "collection.get", "notes.search", "notes.getMany"]);
    const continuation = { name: "search-notes", arguments: { ...input, cursor: "next-page" } };
    const last = await client.callTool(continuation);
    assert.deepEqual(last.structuredContent, {
      query: "", total: null, offset: null, returned: 0, hasMore: false, nextCursor: null,
      notes: [], missingNoteIds: [],
    });
    assert.deepEqual(calls.slice(-2), ["collection.get", "notes.search"]);
    const beforeStale = calls.length;
    const stale = await client.callTool(continuation);
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /staleCursor/u);
    assert.deepEqual(calls.slice(beforeStale), ["collection.get", "notes.search"]);

    for (const paginationArgs of [{ pagination: "offset" }, { offset: 0 }]) {
      const offset = await client.callTool({ name: "search-notes", arguments: { query: "", limit: 1, ...paginationArgs } });
      assert.deepEqual(offset.structuredContent, {
        query: "", total: 3, offset: 0, returned: 1, hasMore: true, notes: [note], missingNoteIds: [],
      });
      assert.deepEqual(calls.slice(-4), ["collection.get", "notes.search", "notes.getMany", "noteTypes.get"]);
    }
    const cardPage = await client.callTool({ name: "search-cards", arguments: input });
    assert.notEqual(cardPage.isError, true);
    assert.deepEqual(cardPage.structuredContent, {
      query: "", total: null, offset: null, returned: 1, hasMore: true, nextCursor: "card-page",
      cards: [{
        cardId: 101, noteId: 1, deckName: "Default", modelName: "Basic", templateOrdinal: 0,
        state: "new", isDue: true, isSuspended: false, interval: { value: 0, unit: "days" },
        easePercent: null, repetitions: 0, lapses: 0, flag: "none",
      }],
      missingCardIds: [],
    });
    assert.deepEqual(calls.slice(-6), ["collection.get", "cards.search", "cards.getMany", "notes.getMany", "noteTypes.get", "cards.search"]);
    const lastCards = await client.callTool({ name: "search-cards", arguments: { ...input, cursor: "card-page" } });
    assert.deepEqual(lastCards.structuredContent, {
      query: "", total: null, offset: null, returned: 0, hasMore: false, nextCursor: null,
      cards: [], missingCardIds: [],
    });
    const created = await client.callTool({ name: "create-deck", arguments: { name: "Fixture" } });
    assert.deepEqual(created.structuredContent, { deck: { id: 2, name: "Fixture" }, created: true });
    assert.deepEqual(calls.slice(-3), ["collection.get", "decks.list", "decks.create"]);

    const beforeInvalid = calls.length;
    const conflict = await client.callTool({ name: "search-notes", arguments: { ...input, pagination: "cursor", offset: 1 } });
    assert.equal(conflict.isError, true);
    const mixed = await client.callTool({ name: "search-notes", arguments: { ...input, cursor: "next-page", offset: 0 } });
    assert.equal(mixed.isError, true);
    process.env.ANKI_API_MODE = "legacy";
    const disabled = await client.callTool({ name: "search-notes", arguments: { ...input, pagination: "cursor" } });
    assert.equal(disabled.isError, true);
    assert.match(JSON.stringify(disabled.content), /requires ANKI_API_MODE=v1/u);
    assert.equal(calls.length, beforeInvalid);
    const legacy = await client.callTool({ name: "search-notes", arguments: { query: "", limit: 1 } });
    assert.deepEqual(legacy.structuredContent, {
      query: "", total: 3, offset: 0, returned: 1, hasMore: true, notes: [note], missingNoteIds: [],
    });
    assert.deepEqual(calls.slice(beforeInvalid), ["findNotes", "notesInfo"]);
  });
}
