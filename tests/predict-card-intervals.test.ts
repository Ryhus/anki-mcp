import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readCardIntervalPrediction } from "../anki-api/v1/anki-v1-scheduling-client.js";
import { createServer } from "../mcp/create-server.js";

const toolName = "predict-card-intervals";
const cardId = 1234567890123;
const answers = [
  { rating: "again", label: "<1 Min.", interval: { value: 60, unit: "seconds" } },
  { rating: "hard", label: "6 Min.", interval: { value: 360, unit: "seconds" } },
  { rating: "good", label: "1 Tag", interval: { value: 1, unit: "days" } },
  { rating: "easy", label: "Ende", interval: null },
];
const prediction = {
  cardId: String(cardId), source: "scheduler", stateToken: "private-answer-token", answers,
};
const callsForPrediction = ["collection.get", "scheduling.predict"];

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
  const state = { calls: [] as string[], result: prediction as unknown, missing: false };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, id, params } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: "prediction-session" });
    }
    assert.equal(method, "scheduling.predict", "prediction must never submit an answer");
    assert.deepEqual(params, { cardId: String(cardId), session: "prediction-session" });
    if (state.missing) return Response.json({
      jsonrpc: "2.0", id, error: { code: 1001, message: "private card data" },
    });
    return ok(state.result);
  });
  return state;
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} predicts four native intervals without answering or exposing the token`, async (t) => {
    const state = fixture(t);
    state.result = {
      ...prediction, answers: [...answers].reverse().map((entry) => ({ ...entry, stateToken: "nested-token" })),
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "interval-prediction-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    const { tools } = await client.listTools();
    assert.equal(tools.find(({ name }) => name === toolName)?.annotations?.readOnlyHint, true);
    const call = (args: Record<string, unknown>) => client.callTool({ name: toolName, arguments: args });
    for (const args of [{}, { cardId: 0 }, { cardId: "12" }, { cardId, rating: "again" }, { cardId: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.equal((await call(args)).isError, true);
    }
    assert.equal(state.calls.length, 0);
    const result = await call({ cardId });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { cardId, source: "scheduler", answers });
    assert.doesNotMatch(JSON.stringify(result), /stateToken|private-answer-token|nested-token/u);
    assert.deepEqual(state.calls, callsForPrediction);
    state.missing = true;
    const missing = await call({ cardId });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /notFound/u);
    assert.doesNotMatch(JSON.stringify(missing.content), /private card data/u);
    assert.deepEqual(state.calls, [...callsForPrediction, ...callsForPrediction]);
  });
}

test("incomplete, duplicate, invalid or uncorrelated predictions fail closed", async (t) => {
  const state = fixture(t);
  const invalid = [
    { ...prediction, cardId: "12" },
    { ...prediction, source: "reviewer" },
    { ...prediction, stateToken: "" },
    { ...prediction, answers: answers.slice(0, 3) },
    { ...prediction, answers: [...answers.slice(0, 3), answers[0]] },
    { ...prediction, answers: [{ ...answers[0], interval: { value: -1, unit: "seconds" } }, ...answers.slice(1)] },
    { ...prediction, answers: [{ ...answers[0], interval: { value: 1, unit: "minutes" } }, ...answers.slice(1)] },
  ];
  for (const result of invalid) {
    state.result = result;
    await assert.rejects(readCardIntervalPrediction(cardId), { kind: "invalid-response", action: "scheduling.predict" });
  }
  assert.deepEqual(state.calls, Array.from({ length: invalid.length }, () => callsForPrediction).flat());
});

test("legacy mode refuses prediction without making a request", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(readCardIntervalPrediction(cardId), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, []);
});
