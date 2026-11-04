import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { updateNoteTypeStylingConfig } from "../mcp/tools/note-types/update-note-type-styling.js";
import { STYLE_MODEL_NAME, UPDATED_CSS, mockNoteTypeStyling, stylingHash } from "./helpers/note-type-styling-fixture.js";

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} keeps the CSS workflow and exposes verified results/errors`, async (t) => {
    const state = mockNoteTypeStyling(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "styling-verification-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 45);
    assert.equal(state.requests.length, 0);
    const preview = await client.callTool({ name: "update-note-type-styling", arguments: { modelName: STYLE_MODEL_NAME, css: UPDATED_CSS } });
    const proposed = updateNoteTypeStylingConfig.outputSchema.parse(preview.structuredContent);
    assert.equal(proposed.dryRun, true);
    assert.equal(proposed.applied, false);
    assert.equal(state.writes, 0);
    const beforeInvalid = state.requests.length;
    const invalid = await client.callTool({ name: "update-note-type-styling", arguments: { modelName: STYLE_MODEL_NAME, css: UPDATED_CSS, dryRun: false } });
    assert.equal(invalid.isError, true);
    assert.equal(state.requests.length, beforeInvalid);
    const applied = await client.callTool({ name: "update-note-type-styling", arguments: {
      modelName: STYLE_MODEL_NAME, css: UPDATED_CSS, dryRun: false, expectedDesignHash: proposed.beforeHash,
    } });
    assert.notEqual(applied.isError, true);
    const saved = updateNoteTypeStylingConfig.outputSchema.parse(applied.structuredContent);
    assert.equal(saved.applied, true);
    assert.equal(saved.afterHash, proposed.afterHash);
    assert.equal(saved.afterHash, stylingHash(state));
    assert.equal(state.writes, 1);
    state.noop = true;
    const unchanged = await client.callTool({ name: "update-note-type-styling", arguments: {
      modelName: STYLE_MODEL_NAME, css: ".card { color: red; }", dryRun: false, expectedDesignHash: saved.afterHash,
    } });
    assert.equal(unchanged.isError, true);
    assert.match(JSON.stringify(unchanged.content), /acknowledged.*verification failed.*No automatic retry/u);
    assert.equal(unchanged.structuredContent, undefined);
    assert.equal(state.writes, 2);
    state.noop = false;
    state.afterWrite = () => { state.failReadbackAction = "modelStyling"; };
    const unreadable = await client.callTool({ name: "update-note-type-styling", arguments: {
      modelName: STYLE_MODEL_NAME, css: ".card { color: green; }", dryRun: false, expectedDesignHash: saved.afterHash,
    } });
    assert.equal(unreadable.isError, true);
    assert.match(JSON.stringify(unreadable.content), /acknowledged.*verification failed.*CSS may already have changed/u);
    assert.equal(state.writes, 3);
    state.failReadbackAction = "";
    const observed = await client.callTool({ name: "get-note-type-design", arguments: { modelName: STYLE_MODEL_NAME } });
    assert.notEqual(observed.isError, true);
    assert.equal(state.css, ".card { color: green; }", "failed verification did not undo a successful write");
    assert.equal(state.writes, 3, "reading after an error does not retry or roll back");
    assert.equal((await client.listTools()).tools.length, 45);
  });
}
