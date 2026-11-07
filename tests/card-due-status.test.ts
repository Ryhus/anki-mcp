import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readCardDueStatus } from "../anki-api/v1/anki-v1-scheduling-client.js";
import { createServer } from "../mcp/create-server.js";

const toolName = "get-card-due-status";
const newCard = 1234567890123;
const dueCard = newCard + 1;
const futureCard = newCard + 2;
const learningCard = newCard + 3;
const missingCard = newCard + 4;

function fixture(t: TestContext) {
  const saved = { ANKI_URL: process.env.ANKI_URL, ANKI_API_MODE: process.env.ANKI_API_MODE };
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = {
    calls: [] as string[], lookups: [] as { cardId: string; includeLearnAhead: boolean }[],
    malformed: undefined as unknown,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, id, params } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: "due-status-session" });
    }
    assert.equal(method, "scheduling.getDue", "due status must never submit an answer or load history");
    const { cardId, includeLearnAhead } = params;
    assert.deepEqual(params, { cardId, includeLearnAhead, session: "due-status-session" });
    assert.equal(typeof cardId, "string");
    assert.equal(typeof includeLearnAhead, "boolean");
    state.lookups.push({ cardId, includeLearnAhead });
    if (state.malformed !== undefined) return ok(state.malformed);
    switch (Number(cardId)) {
      case newCard: return ok({ cardId, dueNow: false, available: true, learnAhead: false });
      case dueCard: return ok({ cardId, dueNow: true, available: true, learnAhead: false });
      case futureCard: return ok({ cardId, dueNow: false, available: false, learnAhead: false });
      case learningCard: return ok({ cardId, dueNow: false, available: includeLearnAhead, learnAhead: true });
      case missingCard: return Response.json({
        jsonrpc: "2.0", id, error: { code: 1001, message: "private card data" },
      });
      default: assert.fail("Unexpected card ID");
    }
  });
  return state;
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} keeps due time distinct from availability and forwards learn-ahead`, async (t) => {
    const state = fixture(t);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "card-due-status-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    assert.equal((await client.listTools()).tools.find(({ name }) => name === toolName)?.annotations?.readOnlyHint, true);
    const call = (args: Record<string, unknown>) => client.callTool({ name: toolName, arguments: args });
    for (const args of [{}, { cardId: 0 }, { cardId: "12" }, { cardId: newCard, includeLearnAhead: "yes" }, { cardId: newCard, rating: "good" }]) {
      assert.equal((await call(args)).isError, true);
    }
    assert.equal(state.calls.length, 0);
    const cases = [
      { cardId: newCard, dueNow: false, available: true, learnAhead: false },
      { cardId: dueCard, dueNow: true, available: true, learnAhead: false },
      { cardId: futureCard, dueNow: false, available: false, learnAhead: false },
      { cardId: learningCard, dueNow: false, available: false, learnAhead: true },
    ];
    for (const expected of cases) {
      const result = await call({ cardId: expected.cardId });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { ...expected, includeLearnAhead: false });
    }
    const early = await call({ cardId: learningCard, includeLearnAhead: true });
    assert.deepEqual(early.structuredContent, {
      cardId: learningCard, dueNow: false, available: true, learnAhead: true, includeLearnAhead: true,
    });
    const missing = await call({ cardId: missingCard });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /notFound/u);
    assert.doesNotMatch(JSON.stringify(missing.content), /private card data/u);
    assert.deepEqual(state.lookups, [
      ...cases.map(({ cardId }) => ({ cardId: String(cardId), includeLearnAhead: false })),
      { cardId: String(learningCard), includeLearnAhead: true },
      { cardId: String(missingCard), includeLearnAhead: false },
    ]);
    assert.deepEqual(state.calls, Array.from({ length: 6 }, () => ["collection.get", "scheduling.getDue"]).flat());
  });
}

test("malformed or uncorrelated due statuses fail closed", async (t) => {
  const state = fixture(t);
  const valid = { cardId: String(newCard), dueNow: false, available: true, learnAhead: false };
  for (const response of [
    { ...valid, cardId: String(dueCard) },
    { ...valid, dueNow: "false" },
    { ...valid, available: undefined },
    { ...valid, learnAhead: 0 },
  ]) {
    state.malformed = response;
    await assert.rejects(readCardDueStatus(newCard, false), { kind: "invalid-response", action: "scheduling.getDue" });
  }
  assert.equal(state.lookups.length, 4);
});

test("legacy mode cannot read due status and sends no request", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(readCardDueStatus(newCard, true), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, []);
});
