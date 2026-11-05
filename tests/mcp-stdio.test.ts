import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { startStdioServer, STDIO_MAX_BUFFER_SIZE } from "../mcp/stdio.js";
import { MEDIA_FILE_SIZE_LIMIT } from "../mcp/tools/media/shared-schemas.js";

const entry = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`stdio child process serves MCP ${version}`, { timeout: 15_000 }, async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", entry],
      cwd: projectRoot,
      env: { ANKI_URL: "http://127.0.0.1:1" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const client = new Client({ name: "stdio-tests", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: {
        mode: version === "2026-07-28" ? { pin: version } : "legacy",
      },
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    assert.equal((await client.listTools()).tools.length, 55);
    assert.match(stderr, /Anki MCP server running on stdio/u);
    assert.doesNotMatch(stderr, /Fatal MCP server error/u);
  });
}

test("stdio accepts a maximum-sized media payload without calling Anki", { timeout: 15_000 }, async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const errors: Error[] = [];
  const handle = startStdioServer({ stdin, stdout, onerror: (error) => errors.push(error) });
  // The same generic stream transport can connect the SDK client to these pipes.
  const transport = new StdioServerTransport(stdout, stdin, {
    maxBufferSize: STDIO_MAX_BUFFER_SIZE,
  });
  const client = new Client({ name: "large-media-test", version: "0.0.0" });
  t.after(async () => {
    await client.close();
    await handle.close();
    stdin.destroy();
    stdout.destroy();
  });
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("An invalid media request must not reach Anki");
  });
  await client.connect(transport);
  const data = Buffer.alloc(MEDIA_FILE_SIZE_LIMIT).toString("base64");
  assert.ok(Buffer.byteLength(data) > 10 * 1024 * 1024);
  const result = await client.callTool({
    name: "store-media-file",
    arguments: { filename: 42, source: { type: "base64", data } },
  });
  assert.equal(result.isError, true, "field validation should reject the filename, not the transport");
  assert.match(JSON.stringify(result.content), /filename/u);
  assert.deepEqual(errors, []);
  assert.equal((await client.listTools()).tools.length, 55);
});

test("stdio closes when the configured buffer limit is exceeded", { timeout: 5_000 }, async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const errorReceived = Promise.withResolvers<Error>();
  const handle = startStdioServer({ stdin, stdout, onerror: errorReceived.resolve });
  t.after(async () => {
    await handle.close();
    stdin.destroy();
    stdout.destroy();
  });
  stdin.write(Buffer.alloc(STDIO_MAX_BUFFER_SIZE + 1, "x"));
  const error = await errorReceived.promise;
  assert.match(error.message, /buffer|limit/iu);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stdin.listenerCount("data"), 0);
});

test("the server exits cleanly when stdin reaches EOF", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: projectRoot,
    env: { ...process.env, ANKI_URL: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const responses = lines[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "eof-test", version: "0.0.0" },
    },
  })}\n`);
  const first = await responses.next();
  assert.equal(first.done, false);
  const initialized = JSON.parse(first.value as string) as { id: number; result: { protocolVersion: string } };
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.doesNotMatch(stderr, /Fatal MCP server error/u);
});
