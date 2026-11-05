import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { setCardSuspensionConfig } from "../mcp/tools/cards/set-card-suspension.js";
import { setCardFlagConfig } from "../mcp/tools/cards/set-card-flag.js";
import { rescheduleCardsConfig } from "../mcp/tools/cards/reschedule-cards.js";
import { resetCardsToNewConfig } from "../mcp/tools/cards/reset-cards-to-new.js";
import { startCardRelearningConfig } from "../mcp/tools/cards/start-card-relearning.js";
import { mockCardMutations, writeRequests } from "./helpers/card-mutation-fixture.js";

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} reports verified Card mutations and honest failures`, async (t) => {
    const state = mockCardMutations(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "verified-card-mutations-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 66);
    assert.equal(state.requests.length, 0);
    for (const name of ["reset-cards-to-new", "start-card-relearning", "reschedule-cards"]) {
      assert.equal(tools.find((tool) => tool.name === name)?.annotations?.idempotentHint, false);
    }
    for (const [name, extra] of [
      ["set-card-suspension", { suspended: true }], ["set-card-flag", { flag: "green" }],
      ["reschedule-cards", { due: "1!" }], ["reset-cards-to-new", {}], ["start-card-relearning", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: { cardIds: [10, 999], ...extra } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /No Cards were changed/u);
      assert.equal(writeRequests(state).length, 0);
    }

    const flag = await client.callTool({ name: "set-card-flag", arguments: { cardIds: [10], flag: "green" } });
    assert.notEqual(flag.isError, true);
    assert.deepEqual(setCardFlagConfig.outputSchema.parse(flag.structuredContent).updatedCardIds, [10]);
    for (const suspended of [true, false]) {
      const response = await client.callTool({ name: "set-card-suspension", arguments: { cardIds: [10], suspended } });
      assert.notEqual(response.isError, true);
      assert.equal(setCardSuspensionConfig.outputSchema.parse(response.structuredContent).suspended, suspended);
    }
    const due = await client.callTool({ name: "reschedule-cards", arguments: { cardIds: [10], due: "1!" } });
    assert.notEqual(due.isError, true);
    assert.deepEqual(rescheduleCardsConfig.outputSchema.parse(due.structuredContent).rescheduledCardIds, [10]);
    state.relearnMode = "review";
    const relearn = await client.callTool({ name: "start-card-relearning", arguments: { cardIds: [10] } });
    assert.notEqual(relearn.isError, true);
    assert.deepEqual(startCardRelearningConfig.outputSchema.parse(relearn.structuredContent).reviewCardIds, [10]);
    const reset = await client.callTool({ name: "reset-cards-to-new", arguments: { cardIds: [10] } });
    assert.notEqual(reset.isError, true);
    assert.deepEqual(resetCardsToNewConfig.outputSchema.parse(reset.structuredContent).resetCardIds, [10]);

    state.noop = true;
    const before = writeRequests(state).length;
    const noop = await client.callTool({ name: "set-card-flag", arguments: { cardIds: [10], flag: "red" } });
    assert.equal(noop.isError, true);
    assert.match(JSON.stringify(noop.content), /verification failed.*Changes may already be applied/u);
    assert.equal(writeRequests(state).length, before + 1);
    state.noop = false;
    state.failFlagId = 20;
    const partial = await client.callTool({ name: "set-card-flag", arguments: { cardIds: [10, 20, 30], flag: "red" } });
    assert.equal(partial.isError, true);
    assert.match(JSON.stringify(partial.content), /Earlier writes acknowledged but not verified: 10.*Not attempted: 30/u);
    assert.equal(state.cards.get(30)!.flags, 0);
    assert.equal((await client.listTools()).tools.length, 66, "a failed operation does not close the connection");
  });
}
