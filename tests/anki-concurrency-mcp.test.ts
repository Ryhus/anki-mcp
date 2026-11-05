import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { prepareNoteDrafts } from "../mcp/tools/notes/note-draft-validator.js";
import { noteDraftSchema } from "../mcp/tools/notes/shared-schemas.js";
import { loadAnkiMediaFiles } from "../mcp/tools/media/media-loader.js";

function delayedAnki(t: TestContext, handle: (action: string, params: Record<string, unknown>) => unknown) {
  const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_REQUEST_TIMEOUT_MS = "5000";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const stats = { active: 0, maximum: 0, actions: [] as string[] };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { action, params = {} } = JSON.parse(String(init?.body)) as { action: string; params: Record<string, unknown> };
    stats.active += 1; stats.maximum = Math.max(stats.maximum, stats.active); stats.actions.push(action);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const response = Response.json({ result: handle(action, params), error: null });
    const json = response.json.bind(response);
    t.mock.method(response, "json", async () => { try { return await json(); } finally { stats.active -= 1; } });
    return response;
  });
  return stats;
}

test("50 different Note Types in draft preparation share the global HTTP cap", async (t) => {
  const models = Object.fromEntries(Array.from({ length: 50 }, (_unused, index) => [`Model ${index}`, index + 1]));
  const stats = delayedAnki(t, (action, params) => {
    switch (action) {
      case "deckNamesAndIds": return { Fixture: 1 };
      case "modelNamesAndIds": return models;
      case "modelFieldNames": return ["Front", "Back"];
      case "canAddNotesWithErrorDetail": return (params.notes as unknown[]).map(() => ({ canAdd: true }));
      default: assert.fail(`Unexpected action ${action}`);
    }
  });
  const result = await prepareNoteDrafts(Object.keys(models).map((modelName) => noteDraftSchema.parse({
    deckName: "Fixture", modelName, fields: { Front: modelName, Back: "Back" },
  })));
  assert.equal(result.validations.length, 50);
  assert.ok(result.validations.every(({ canCreate }) => canCreate));
  assert.equal(stats.actions.filter((action) => action === "modelFieldNames").length, 50);
  assert.equal(stats.maximum, 4);
  assert.equal(stats.active, 0);
});

test("parallel Media retrieval uses the same four request permits without dropping missing files", async (t) => {
  const stats = delayedAnki(t, (action) => { assert.equal(action, "retrieveMediaFile"); return false; });
  const names = Array.from({ length: 30 }, (_unused, index) => `file-${index}.png`);
  const media = await loadAnkiMediaFiles([...names, names[0]!]);
  assert.equal(media.size, 30);
  assert.ok([...media.values()].every((value) => value === null));
  assert.equal(stats.actions.length, 30);
  assert.equal(stats.maximum, 4);
  assert.equal(stats.active, 0);
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`two MCP ${version} server factories share the process-wide limiter`, async (t) => {
    const stats = delayedAnki(t, (action) => {
      if (action === "deckNamesAndIds") return { Default: 1 };
      if (action === "modelNamesAndIds") return { Basic: 1 };
      assert.fail(`Unexpected action ${action}`);
    });
    const clients: Client[] = [];
    for (let index = 0; index < 2; index += 1) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const handle = serveStdio(createServer, { transport: serverTransport });
      const client = new Client({ name: `concurrency-test-${index}`, version: "0.0.0" }, {
        supportedProtocolVersions: [version],
        versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
      });
      t.after(async () => { await client.close(); await handle.close(); });
      await client.connect(clientTransport);
      assert.equal((await client.listTools()).tools.length, 61);
      clients.push(client);
    }
    assert.equal(stats.actions.length, 0);
    const results = await Promise.all(Array.from({ length: 20 }, (_unused, index) => clients[index % 2]!.callTool({
      name: index % 3 === 0 ? "list-note-types" : "list-decks",
    })));
    assert.ok(results.every((result) => result.isError !== true));
    assert.equal(stats.actions.length, 20);
    assert.equal(stats.maximum, 4, "the limit is not four per factory or per tool");
    assert.equal(stats.active, 0);
  });
}
