import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { createServer } from "../mcp/create-server.js";
import { noteCreationOutputSchema } from "../mcp/tools/notes/note-creation-schemas.js";
import { creationInput, mockNoteCreation } from "./helpers/note-creation-fixture.js";

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} retains structured creation evidence on execution errors`, async (t) => {
    const state = mockNoteCreation(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "note-creation-outcome-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 64);
    const tool = tools.find(({ name }) => name === "create-notes");
    assert.ok(tool?.outputSchema);
    assert.equal(tool.annotations?.idempotentHint, false);
    const validateOutput = new AjvJsonSchemaValidator().getValidator(tool.outputSchema as JsonSchemaType);
    assert.equal(typeof validateOutput, "function");
    assert.equal(state.requests.length, 0);
    const input = creationInput();
    const call = () => client.callTool({ name: "create-notes", arguments: input });
    const assertData = (response: Awaited<ReturnType<typeof call>>) => {
      const result = noteCreationOutputSchema.parse(response.structuredContent);
      const json = response.content.find((item) => item.type === "text" && item.text.startsWith("{"));
      assert.ok(json?.type === "text");
      assert.deepEqual(JSON.parse(json.text), result);
      return result;
    };
    const good = await call();
    assert.notEqual(good.isError, true);
    assert.equal(assertData(good).outcome, "complete");
    assert.equal(state.writes, 1);

    state.nullIndexes.add(1);
    const partial = await call();
    assert.equal(partial.isError, true);
    const partialData = assertData(partial);
    assert.equal(partialData.createdNoteCount, 2);
    assert.deepEqual(partialData.noteResults.map(({ status }) => status), ["created", "not-created", "created"]);
    assert.equal(state.writes, 2);

    state.nullIndexes.clear();
    state.readbackFailure = true;
    const unreadable = await call();
    assert.equal(unreadable.isError, true);
    const unreadableData = assertData(unreadable);
    assert.equal(unreadableData.createdNoteCount, 3);
    assert.deepEqual(unreadableData.createdNotes.map(({ noteId }) => noteId), [2100, 2101, 2102]);
    assert.ok(unreadableData.createdNotes.every(({ cardIds }) => cardIds === null));
    assert.equal(state.writes, 3);

    state.readbackFailure = false;
    state.creationFailure = "network-after";
    const lost = await call();
    assert.equal(lost.isError, true);
    const lostData = assertData(lost);
    assert.equal(lostData.createdNoteCount, null);
    assert.equal(lostData.outcome, "unknown");
    assert.ok(lostData.noteResults.every(({ status }) => status === "unknown"));
    assert.equal(state.notes.size, 11, "the lost reply did not roll back creation or trigger a second request");
    assert.equal(state.writes, 4);

    state.creationFailure = "";
    state.creationReply = [4100];
    const malformed = await call();
    assert.equal(malformed.isError, true);
    const malformedData = assertData(malformed);
    assert.equal(malformedData.outcome, "unknown");
    assert.deepEqual(malformedData.reportedNoteIds, [4100]);
    assert.deepEqual(malformedData.createdNotes, []);
    assert.equal(state.writes, 5);
    assert.equal((await client.listTools()).tools.length, 64, "errors preserve the MCP connection");
  });
}
