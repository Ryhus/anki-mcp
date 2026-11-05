import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} returns readable transport errors and stays usable after a deadline`, async (t) => {
    const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
    process.env.ANKI_URL = "http://127.0.0.1:8765/?token=private-token";
    process.env.ANKI_REQUEST_TIMEOUT_MS = "15";
    t.after(() => {
      for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    let failure: "timeout" | "http" | "invalid-json" | "invalid-response" | "network" | null = "timeout";
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      switch (failure) {
        case "timeout": return new Promise<Response>(() => {});
        case "http": return new Response("private-token", { status: 503 });
        case "invalid-json": return new Response("private-token");
        case "invalid-response": return Response.json({ secret: "private-token" });
        case "network": throw new TypeError("private-token");
        default: return Response.json({ result: { Default: 1 }, error: null });
      }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "transport-errors-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => {
      await client.close();
      await handle.close();
    });
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 62);
    assert.equal(requests, 0);
    for (const [kind, code] of [
      ["timeout", "ANKI_TIMEOUT"], ["http", "ANKI_HTTP_ERROR"],
      ["invalid-json", "ANKI_INVALID_JSON"], ["invalid-response", "ANKI_INVALID_RESPONSE"],
      ["network", "ANKI_NETWORK_ERROR"],
    ] as const) {
      failure = kind;
      const before: number = requests;
      const result = await client.callTool({ name: "list-decks" });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), new RegExp(code, "u"));
      assert.doesNotMatch(JSON.stringify(result), /private-token/u);
      assert.equal(requests - before, 1, "an error must not retry the request");
      failure = null;
      const recovered = await client.callTool({ name: "list-decks" });
      assert.notEqual(recovered.isError, true);
      assert.equal(requests - before, 2, "the next user request is independent");
    }
  });
}
