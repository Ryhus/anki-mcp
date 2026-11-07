import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readStudySummary } from "../anki-api/statistics/study-stats-client.js";
import { createServer } from "../mcp/create-server.js";

const toolName = "get-study-summary";
const deckId = 1234567890123;
const collection = {
  cardCount: 15, noteCount: 10, reviewCount: 120, reviewTimeMs: 240_000,
  newCount: 3, learningCount: 2, reviewCardCount: 7, suspendedCount: 1,
};
const empty = {
  cardCount: 0, noteCount: 0, reviewCount: 0, reviewTimeMs: 0,
  newCount: 0, learningCount: 0, reviewCardCount: 0, suspendedCount: 0,
};

function configure(t: TestContext, mode: "legacy" | "v1") {
  const saved = { ANKI_URL: process.env.ANKI_URL, ANKI_API_MODE: process.env.ANKI_API_MODE };
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = mode;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} reads collection and deck summaries without writing or guessing scope`, async (t) => {
    configure(t, "v1");
    const calls: string[] = [];
    let summary: Record<string, unknown> = collection;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/v1");
      const { method, id, params } = JSON.parse(String(init.body));
      calls.push(method);
      const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      if (method === "collection.get") {
        assert.deepEqual(params, {});
        return ok({ session: "summary-session" });
      }
      assert.equal(method, "statistics.getSummary");
      if (params.deck === undefined) {
        assert.deepEqual(params, { session: "summary-session" });
        return ok(summary);
      }
      const { id: deck } = params.deck;
      assert.deepEqual(params, { deck: { id: deck }, session: "summary-session" });
      if (deck === String(deckId)) return ok(empty);
      assert.equal(deck, "99");
      return Response.json({ jsonrpc: "2.0", id, error: { code: 1001, message: "private deck information" } });
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "study-summary-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    assert.equal((await client.listTools()).tools.find(({ name }) => name === toolName)?.annotations?.readOnlyHint, true);
    const call = (args?: Record<string, unknown>) =>
      client.callTool({ name: toolName, ...(args === undefined ? {} : { arguments: args }) });
    for (const args of [{ deckId: 0 }, { deckId: "99" }, { deckName: "Missing" }, { deckId: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.equal((await call(args)).isError, true);
    }
    assert.deepEqual(calls, [], "invalid deck selectors must not fall back to the whole collection");
    assert.deepEqual((await call()).structuredContent, { scope: { kind: "collection" }, summary: collection });
    assert.deepEqual((await call({ deckId })).structuredContent, {
      scope: { kind: "deck", deckId, includesSubdecks: true }, summary: empty,
    });
    const missing = await call({ deckId: 99 });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /notFound/u);
    assert.doesNotMatch(JSON.stringify(missing.content), /private deck information/u);

    for (const invalid of [
      { ...collection, cardCount: -1 },
      { ...collection, reviewTimeMs: 0.5 },
      { ...collection, suspendedCount: undefined },
    ]) {
      summary = invalid;
      const malformed = await call();
      assert.equal(malformed.isError, true);
      assert.match(JSON.stringify(malformed.content), /ANKI_INVALID_RESPONSE/u);
    }
    assert.deepEqual(calls, Array.from({ length: 6 }, () => ["collection.get", "statistics.getSummary"]).flat());
  });
}

test("legacy mode cannot run study summaries and sends no request", async (t) => {
  configure(t, "legacy");
  const request = t.mock.method(globalThis, "fetch", () => assert.fail("No request expected"));
  await assert.rejects(readStudySummary(), /requires ANKI_API_MODE=v1/u);
  assert.equal(request.mock.callCount(), 0);
});
