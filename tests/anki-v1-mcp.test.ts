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
        if (action === "createDeck") return Response.json({ result: 2, error: null });
        assert.fail(`Unexpected legacy action: ${action}`);
      }
      assert.equal(new URL(url).pathname, "/api/v1");
      const success = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "decks.list": return success([{ name: "Default", id: "1" }]);
        case "noteTypes.list": return success([{ name: "Basic", id: "100" }]);
        case "tags.list": return success(["noun"]);
        case "collection.get": return success({ session: "test-session" });
        case "notes.search":
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
          assert.deepEqual(params, { ids: ["1", "2"], session: "test-session" });
          return success({ items: [
            { index: 0, result: {
              id: "1", noteType: { id: "100", name: "Basic" }, tags: ["noun"],
              cardIds: ["101"], modifiedAt: "2023-11-14T22:13:20Z", fields: { Front: "<b>Cat</b>" },
            } },
            { index: 1, error: { code: 1001, message: "not found" } },
          ] });
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
      assert.deepEqual(calls.slice(-2), ["findNotes", "notesInfo"]);
    }
    const created = await client.callTool({ name: "create-deck", arguments: { name: "Fixture" } });
    assert.deepEqual(created.structuredContent, { deck: { id: 2, name: "Fixture" }, created: true });
    assert.deepEqual(calls.slice(-2), ["decks.list", "createDeck"]);

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
