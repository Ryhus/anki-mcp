import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";

for (const mode of ["v1", "legacy"] as const) {
  test(`get-study-stats uses Anki day counts in ${mode}, bounds output and never writes`, async (t) => {
    const previous = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
    process.env.ANKI_URL = "http://127.0.0.1:8765";
    process.env.ANKI_API_MODE = mode;
    t.after(() => {
      for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const rows = [["2026-11-02", 17], ["2026-11-05", 9], ["2026-11-04", 0], ["2026-11-03", 4]] as const;
    const calls: string[] = [];
    let malformed = false;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const { method, action, id, params } = JSON.parse(String(init.body));
      calls.push(method ?? action);
      if (mode === "v1") {
        assert.equal(new URL(url).pathname, "/api/v1");
        const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
        if (method === "collection.get") return ok({ session: "s" });
        assert.deepEqual(params, { session: "s" });
        if (method === "statistics.getToday") {
          return ok({ count: malformed ? -1 : 9, day: "2026-11-05", nextDayAt: "2026-11-06T03:00:00Z" });
        }
        assert.equal(method, "statistics.getReviewDays");
        return ok(rows.map(([day, count]) => ({ day, count })));
      }
      assert.equal(action, "multi");
      assert.deepEqual(params.actions.map((entry: { action: string }) => entry.action), ["getNumCardsReviewedToday", "getNumCardsReviewedByDay"]);
      return Response.json({ result: [{ result: malformed ? -1 : 9, error: null }, { result: rows, error: null }], error: null });
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "study-stats-test", version: "0.0.0" });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    const listing = await client.listTools();
    assert.equal(listing.tools.find(({ name }) => name === "get-study-stats")?.annotations?.readOnlyHint, true);
    assert.deepEqual(calls, []);
    const request = { name: "get-study-stats", arguments: { limitDays: 2 } };
    assert.deepEqual((await client.callTool(request)).structuredContent, {
      reviewedToday: 9, todayDate: mode === "v1" ? "2026-11-05" : null,
      nextDayAt: mode === "v1" ? "2026-11-06T03:00:00Z" : null,
      reviewDays: [{ date: "2026-11-05", reviewCount: 9 }, { date: "2026-11-03", reviewCount: 4 }],
      hasMore: true,
    });
    assert.deepEqual(calls, mode === "v1" ? ["collection.get", "statistics.getToday", "statistics.getReviewDays"] : ["multi"]);
    malformed = true;
    assert.equal((await client.callTool(request)).isError, true);
  });
}
