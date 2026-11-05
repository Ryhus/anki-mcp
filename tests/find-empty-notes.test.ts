import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { findV1EmptyNotesPage } from "../anki-api/v1/anki-v1-note-search.js";
import { createServer } from "../mcp/create-server.js";

function scripted(t: TestContext) {
  const saved = { ANKI_URL: process.env.ANKI_URL, ANKI_API_MODE: process.env.ANKI_API_MODE };
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  const steps: { method: string; params: Record<string, unknown>; result: unknown; errorCode?: number }[] = [];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.deepEqual(steps.map(({ method }) => method), []);
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1", "only native read requests are expected");
    const { method, params, id } = JSON.parse(String(init.body));
    const step = steps.shift();
    assert.ok(step, `Unexpected request: ${method}`);
    assert.equal(method, step.method);
    assert.deepEqual(params, step.params);
    return Response.json({
      jsonrpc: "2.0", id,
      ...(step.errorCode === undefined
        ? { result: step.result }
        : { error: { code: step.errorCode, message: "private upstream message" } }),
    });
  });
  return {
    fetchMock,
    page(params: Record<string, unknown>, result: unknown, errorCode?: number) {
      steps.push(
        { method: "collection.get", params: {}, result: { session: "empty-notes-session" } },
        { method: "notes.findEmpty", params: { ...params, session: "empty-notes-session" }, result,
          ...(errorCode === undefined ? {} : { errorCode }) },
      );
    },
    details(ids: string[], items: unknown[]) {
      steps.push({ method: "notes.getMany", params: { ids, session: "empty-notes-session" }, result: { items } });
    },
  };
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: empty Note scans page natively, with no writes or fallback`, async (t) => {
    const f = scripted(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "empty-notes-tests", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const name = "find-empty-notes";
    const tool = (await client.listTools()).tools.find((entry) => entry.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const call = (args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    for (const args of [{}, { criterion: "empty" }, { criterion: "noCards", limit: 101 }]) {
      assert.equal((await call(args)).isError, true);
    }
    assert.equal(f.fetchMock.mock.callCount(), 0);

    const input = { criterion: "noCards", query: "tag:inbox", limit: 2 };
    f.page(input, { ids: ["1", "2"], nextCursor: "next-page" });
    f.details(["1", "2"], [
      { index: 0, result: {
        id: "1", noteType: { id: "100", name: "Basic" }, tags: ["inbox"],
        cardIds: [], modifiedAt: "2023-11-14T22:13:20Z", fields: { Front: "<b>Cat</b>" },
      } },
      { index: 1, error: { code: 1001, message: "not found" } },
    ]);
    const { criterion, query } = input;
    const first = await call(input);
    assert.notEqual(first.isError, true);
    assert.deepEqual(first.structuredContent, {
      criterion, query, returned: 1, hasMore: true, nextCursor: "next-page", missingNoteIds: [2],
      notes: [{
        noteId: 1, modelName: "Basic", tags: ["inbox"], cardIds: [],
        modifiedAt: "2023-11-14T22:13:20.000Z", fieldPreviews: { Front: "Cat" },
      }],
    });

    const continuation = { ...input, cursor: "next-page" };
    f.page(continuation, { ids: [], nextCursor: null });
    assert.deepEqual((await call(continuation)).structuredContent, {
      criterion, query, returned: 0, hasMore: false, nextCursor: null, notes: [], missingNoteIds: [],
    });
    f.page(continuation, null, 1014);
    const stale = await call(continuation);
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /staleCursor/u);
    assert.doesNotMatch(JSON.stringify(stale.content), /private upstream message/u);

    for (const criterion of ["allFieldsEmpty", "allQuestionsEmpty"]) {
      f.page({ criterion, query: "", limit: 20 }, { ids: [], nextCursor: null });
      assert.deepEqual((await call({ criterion })).structuredContent, {
        criterion, query: "", returned: 0, hasMore: false, nextCursor: null, notes: [], missingNoteIds: [],
      });
    }
    const nativeCalls = f.fetchMock.mock.callCount();
    process.env.ANKI_API_MODE = "legacy";
    const disabled = await call(input);
    assert.equal(disabled.isError, true);
    assert.match(JSON.stringify(disabled.content), /requires ANKI_API_MODE=v1/u);
    assert.equal(f.fetchMock.mock.callCount(), nativeCalls);
  });
}

test("malformed empty Note pages are rejected before requesting any details", async (t) => {
  const f = scripted(t);
  for (const ids of [["1", "1"], ["1", "2", "3"], ["9007199254740992"]]) {
    f.page({ criterion: "noCards", query: "", limit: 2 }, { ids, nextCursor: null });
    await assert.rejects(findV1EmptyNotesPage("noCards", "", 2), { kind: "invalid-response", action: "notes.findEmpty" });
  }
  assert.equal(f.fetchMock.mock.callCount(), 6);
});
