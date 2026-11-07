import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type CollectionContext, undoMethod } from "../anki-api/collection/collection-client.js";
import { createServer } from "../mcp/create-server.js";
import { cancelCollectionOperationConfig } from "../mcp/tools/collection/cancel-collection-operation.js";
import {
  checkCollectionIntegrityConfig, syncCollectionConfig, undoCollectionActionConfig,
} from "../mcp/tools/collection/guarded-tools.js";
import { CollectionOperationRegistry, confirmationLifetimeSeconds } from "../mcp/tools/collection/operation-registry.js";
import {
  getCollectionInfoConfig, getCollectionOperationConfig, refreshCollectionConfig,
} from "../mcp/tools/collection/read-tools.js";

const infoTool = "get-collection-info";
const refreshTool = "refresh-collection";
const syncTool = "sync-collection";
const checkTool = "check-collection-integrity";
const undoTool = "undo-collection-action";
const statusTool = "get-collection-operation";
const cancelTool = "cancel-collection-operation";
type NativeState = {
  operationId: string; method: string; session: string; state: string;
  result?: unknown; error?: { code: number; message: string };
};

function fixture(t: TestContext) {
  const env = { ANKI_URL: "http://127.0.0.1:8765", ANKI_API_MODE: "v1" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = {
    session: "test-session", profile: "Fixture", scheduler: "fsrs",
    records: new Map<string, NativeState>(),
    calls: [] as { method: string; params: Record<string, unknown> }[],
    submitted: [] as string[],
    rejectSubmission: false,
    loseAcknowledgement: false,
    loseCancellationAcknowledgement: false,
    rejectCancellation: false,
    blockCollectionReads: false,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).href, "http://127.0.0.1:8765/api/v1");
    const { id, method, params } = JSON.parse(String(init.body));
    state.calls.push({ method, params });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const error = (code: number) => Response.json({ jsonrpc: "2.0", id, error: { code, message: "private native context" } });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return state.blockCollectionReads ? error(1010)
        : ok({ session: state.session, profile: state.profile, scheduler: state.scheduler });
    }
    if (method === "operations.get") {
      assert.deepEqual(Object.keys(params), ["operationId"], "a status query must not pin the current collection");
      const record = state.records.get(params.operationId);
      return record === undefined ? error(1001) : ok(record);
    }
    if (method === "operations.cancel") {
      assert.deepEqual(Object.keys(params), ["operationId"], "cancellation is application-scoped");
      const record = state.records.get(params.operationId);
      if (record === undefined) return error(1001);
      if (["succeeded", "failed", "cancelled"].includes(record.state)) return ok({ requested: false });
      if (state.rejectCancellation) return error(1006);
      if (record.state === "queued") {
        record.state = "cancelled";
        record.error = { code: 1007, message: "cancelled in queue" };
      }
      return ok({ requested: state.loseCancellationAcknowledgement ? "invalid" : true });
    }
    assert.equal(params.session, state.session);
    if (method === "collection.refresh") {
      assert.deepEqual(Object.keys(params).sort(), ["session", "target"]);
      return ok({ changed: true });
    }
    assert.ok(["collection.sync", "collection.checkIntegrity", "collection.undo"].includes(method), method);
    assert.deepEqual(Object.keys(params).sort(), method === "collection.sync" ? ["includeMedia", "session"] : ["session"]);
    if (state.rejectSubmission) return error(1003);
    state.submitted.push(method);
    const operationId = `operation-${state.submitted.length}`;
    const handle = { operationId, method, session: state.session };
    state.records.set(operationId, { ...handle, state: "queued" });
    return ok(state.loseAcknowledgement ? { ...handle, session: "wrong-session" } : handle);
  });
  return state;
}

async function connect(t: TestContext, version: "2025-11-25" | "2026-07-28" = "2026-07-28") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(createServer, { transport: b });
  const client = new Client({ name: "collection-test", version: "0.0.0" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(a);
  return {
    client,
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }),
  };
}

const approve = (confirmationToken: string) => ({ dryRun: false, confirm: true, confirmationToken });

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: collection info, window refresh, and full sync status survive a session change`, async (t) => {
    const state = fixture(t);
    const { client, call } = await connect(t, version);
    const { tools } = await client.listTools();
    assert.equal(tools.find(({ name }) => name === syncTool)?.annotations?.openWorldHint, true);
    assert.equal(tools.find(({ name }) => name === refreshTool)?.annotations?.readOnlyHint, false);
    assert.equal(tools.find(({ name }) => name === statusTool)?.annotations?.readOnlyHint, true);
    assert.equal(state.calls.length, 0);
    const info = getCollectionInfoConfig.outputSchema.parse((await call(infoTool)).structuredContent);
    assert.deepEqual(info, { profile: state.profile, scheduler: state.scheduler, session: state.session });
    for (const target of ["windows", "cachesAndWindows"] as const) {
      const refreshed = refreshCollectionConfig.outputSchema.parse(
        (await call(refreshTool, target === "windows" ? {} : { target })).structuredContent,
      );
      assert.deepEqual(refreshed, { profile: state.profile, target, refreshed: true });
      assert.deepEqual(state.calls.at(-1), { method: "collection.refresh", params: { target, session: state.session } });
    }
    const defaultSync = syncCollectionConfig.outputSchema.parse((await call(syncTool)).structuredContent);
    assert.equal(defaultSync.includeMedia, true);
    const preview = syncCollectionConfig.outputSchema.parse((await call(syncTool, { includeMedia: false })).structuredContent);
    assert.equal(preview.state, "preview");
    assert.equal(preview.expiresInSeconds, confirmationLifetimeSeconds);
    assert.ok(preview.confirmationToken && preview.operationId === null);
    assert.deepEqual(state.submitted, []);
    const apply = { includeMedia: false, ...approve(preview.confirmationToken) };
    const callsBefore = state.calls.length;
    assert.equal((await call(syncTool, { ...apply, confirm: false })).isError, true);
    assert.equal((await call(syncTool, { dryRun: false, confirm: true })).isError, true);
    assert.equal((await call(syncTool, { ...apply, direction: "download" })).isError, true);
    assert.equal(state.calls.length, callsBefore);
    assert.equal((await call(syncTool, { ...apply, includeMedia: true })).isError, true);
    assert.equal((await call(checkTool, approve(preview.confirmationToken))).isError, true);
    state.session = "other-session";
    assert.equal((await call(syncTool, apply)).isError, true);
    state.session = info.session;
    assert.deepEqual(state.submitted, []);
    const sent = syncCollectionConfig.outputSchema.parse((await call(syncTool, apply)).structuredContent);
    assert.equal(sent.state, "submitted");
    assert.ok(sent.operationId && sent.confirmationToken === null);
    assert.deepEqual(state.calls.at(-1), { method: "collection.sync", params: { includeMedia: false, session: info.session } });
    const statusArgs = { operationId: sent.operationId };
    const status = async () => getCollectionOperationConfig.outputSchema.parse((await call(statusTool, statusArgs)).structuredContent);
    assert.equal((await status()).state, "queued");
    const record = state.records.get(sent.operationId)!;
    state.blockCollectionReads = true;
    record.state = "waitingForUser";
    const waiting = await call(statusTool, statusArgs);
    assert.equal(getCollectionOperationConfig.outputSchema.parse(waiting.structuredContent).state, "waitingForUser");
    assert.match(JSON.stringify(waiting.content), /Anki.*Upload, Download, or Cancel/u);
    assert.match(JSON.stringify((await call(syncTool)).content), /still being tracked/u);
    assert.equal((await call(undoTool)).isError, true);
    assert.equal((await call(refreshTool)).isError, true);
    record.state = "running";
    assert.equal((await status()).state, "running");
    state.session = "session-after-full-sync";
    record.state = "succeeded";
    record.result = { collectionComplete: true, mediaComplete: false };
    const complete = await status();
    assert.equal(complete.state, "succeeded");
    assert.deepEqual(complete.result, { collectionComplete: true, mediaComplete: false });
    const readCount = state.calls.length;
    assert.deepEqual(await status(), complete);
    assert.equal(state.calls.length, readCount);
    state.blockCollectionReads = false;
    assert.equal((await call(syncTool, apply)).isError, true);
    assert.deepEqual(state.submitted, ["collection.sync"]);
  });

  test(`MCP ${version}: cancellation acknowledges one request for a known queued operation`, async (t) => {
    const state = fixture(t);
    const { client, call } = await connect(t, version);
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === cancelTool);
    assert.equal(tool?.annotations?.readOnlyHint, false);
    assert.equal(tool?.annotations?.idempotentHint, false);
    assert.equal((await call(cancelTool, { operationId: "foreign" })).isError, true);
    assert.equal(state.calls.length, 0);
    const preview = checkCollectionIntegrityConfig.outputSchema.parse((await call(checkTool)).structuredContent);
    assert.ok(preview.confirmationToken);
    const started = checkCollectionIntegrityConfig.outputSchema.parse(
      (await call(checkTool, approve(preview.confirmationToken))).structuredContent,
    );
    assert.ok(started.operationId);
    const args = { operationId: started.operationId };
    const [first, second] = await Promise.all([call(cancelTool, args), call(cancelTool, args)]);
    const replies = [first, second];
    assert.equal(replies.filter(({ isError }) => isError).length, 1);
    const result = replies.find(({ isError }) => !isError)!;
    const ack = cancelCollectionOperationConfig.outputSchema.parse(result.structuredContent);
    assert.deepEqual(ack, { ...args, method: "collection.checkIntegrity", profile: state.profile, requested: true });
    assert.match(JSON.stringify(result.content), /acknowledged.*get-collection-operation/u);
    assert.equal((await call(checkTool)).isError, true, "an acknowledgement must not release the active operation");
    const status = getCollectionOperationConfig.outputSchema.parse((await call(statusTool, args)).structuredContent);
    assert.equal(status.state, "cancelled");
    const callsBefore = state.calls.length;
    const finished = cancelCollectionOperationConfig.outputSchema.parse((await call(cancelTool, args)).structuredContent);
    assert.equal(finished.requested, false);
    assert.equal(state.calls.length, callsBefore, "no request for a cached terminal operation");
    assert.equal((await call(checkTool)).isError, undefined);
    assert.equal(state.calls.filter(({ method }) => method === "operations.cancel").length, 1);
  });
}

test("integrity returns the native report; Undo only returns the actual entry after completion", async (t) => {
  const state = fixture(t);
  const { call } = await connect(t);
  const preUndo = undoCollectionActionConfig.outputSchema.parse((await call(undoTool)).structuredContent);
  assert.ok(preUndo.confirmationToken && preUndo.warnings.some((warning) => /cannot preview/u.test(warning)));
  const check = checkCollectionIntegrityConfig.outputSchema.parse((await call(checkTool)).structuredContent);
  assert.ok(check.confirmationToken && check.warnings.some((warning) => /clear Anki's Undo history/u.test(warning)));
  assert.deepEqual(state.submitted, []);
  const sent = checkCollectionIntegrityConfig.outputSchema.parse((await call(checkTool, approve(check.confirmationToken))).structuredContent);
  assert.ok(sent.operationId);
  Object.assign(state.records.get(sent.operationId)!, { state: "succeeded", result: { problems: ["Example database report"], repaired: false } });
  const checked = getCollectionOperationConfig.outputSchema.parse((await call(statusTool, { operationId: sent.operationId })).structuredContent);
  assert.deepEqual(checked.result, { problems: ["Example database report"], repaired: false });
  assert.equal((await call(undoTool, approve(preUndo.confirmationToken))).isError, true, "another submission invalidates older previews");

  const fresh = undoCollectionActionConfig.outputSchema.parse((await call(undoTool)).structuredContent);
  assert.ok(fresh.confirmationToken);
  const [one, two] = await Promise.all([
    call(undoTool, approve(fresh.confirmationToken)),
    call(undoTool, approve(fresh.confirmationToken)),
  ]);
  assert.equal([one, two].filter(({ isError }) => isError).length, 1);
  const undone = undoCollectionActionConfig.outputSchema.parse([one, two].find(({ isError }) => !isError)?.structuredContent);
  assert.ok(undone.operationId);
  Object.assign(state.records.get(undone.operationId)!, { state: "succeeded", result: { label: "Manual Edit", changed: true } });
  const done = getCollectionOperationConfig.outputSchema.parse((await call(statusTool, { operationId: undone.operationId })).structuredContent);
  assert.deepEqual(done.result, { label: "Manual Edit", changed: true });
  assert.equal((await call(undoTool, approve(fresh.confirmationToken))).isError, true);
  assert.deepEqual(state.submitted, ["collection.checkIntegrity", "collection.undo"]);
});

test("operation status validates its origin, native record, and failure, without resending writes", async (t) => {
  const state = fixture(t);
  const { call } = await connect(t);
  const unknown = await call(statusTool, { operationId: "foreign" });
  assert.equal(unknown.isError, true);
  assert.equal(state.calls.length, 0);
  const preview = undoCollectionActionConfig.outputSchema.parse((await call(undoTool)).structuredContent);
  assert.ok(preview.confirmationToken);
  const sent = undoCollectionActionConfig.outputSchema.parse((await call(undoTool, approve(preview.confirmationToken))).structuredContent);
  assert.ok(sent.operationId);
  const args = { operationId: sent.operationId };
  const record = state.records.get(sent.operationId)!;
  record.session = "other-session";
  assert.equal((await call(statusTool, args)).isError, true);
  record.session = state.session;
  record.state = "succeeded";
  record.result = { collectionComplete: true, mediaComplete: true };
  assert.equal((await call(statusTool, args)).isError, true);
  assert.equal((await call(undoTool)).isError, true);
  delete record.result;
  record.state = "failed";
  record.error = { code: 1009, message: "private native context" };
  const failed = await call(statusTool, args);
  assert.match(JSON.stringify(failed.content), /nothing to undo/u);
  assert.doesNotMatch(JSON.stringify(failed), /private native context/u);
  const status = getCollectionOperationConfig.outputSchema.parse(failed.structuredContent);
  assert.equal(status.state, "failed");
  assert.equal(status.result, null);
  assert.equal(status.error?.code, 1009);

  const retryPreview = undoCollectionActionConfig.outputSchema.parse((await call(undoTool)).structuredContent);
  assert.ok(retryPreview.confirmationToken);
  const second = undoCollectionActionConfig.outputSchema.parse((await call(undoTool, approve(retryPreview.confirmationToken))).structuredContent);
  assert.ok(second.operationId);
  state.records.delete(second.operationId);
  const lost = getCollectionOperationConfig.outputSchema.parse((await call(statusTool, { operationId: second.operationId })).structuredContent);
  assert.equal(lost.state, "unknown");
  assert.equal(lost.result, null);
  assert.deepEqual(state.submitted, ["collection.undo", "collection.undo"]);
});

test("a rejected write can be reviewed again, but an unconfirmed submission blocks further mutations", async (t) => {
  const state = fixture(t);
  const { call } = await connect(t);
  const preview = async () => {
    const result = syncCollectionConfig.outputSchema.parse((await call(syncTool)).structuredContent);
    assert.ok(result.confirmationToken);
    return result.confirmationToken;
  };
  state.rejectSubmission = true;
  const first = await preview();
  assert.match(JSON.stringify((await call(syncTool, approve(first))).content), /editorConflict/u);
  assert.deepEqual(state.submitted, []);
  state.rejectSubmission = false;
  state.loseAcknowledgement = true;
  const second = await preview();
  const uncertain = await call(syncTool, approve(second));
  assert.equal(uncertain.isError, true);
  assert.match(JSON.stringify(uncertain.content), /may already be working.*No retry/u);
  assert.match(JSON.stringify((await call(checkTool)).content), /restart MCP/u);
  assert.equal((await call(syncTool, approve(second))).isError, true);
  assert.deepEqual(state.submitted, ["collection.sync"]);
  assert.equal((await call(infoTool)).isError, undefined, "read-only collection information remains available");
});

test("cancellation does not require an active session and can lose the race with completion", async (t) => {
  const state = fixture(t);
  const { call } = await connect(t);
  const preview = syncCollectionConfig.outputSchema.parse((await call(syncTool)).structuredContent);
  assert.ok(preview.confirmationToken);
  const started = syncCollectionConfig.outputSchema.parse((await call(syncTool, approve(preview.confirmationToken))).structuredContent);
  assert.ok(started.operationId);
  const args = { operationId: started.operationId };
  const record = state.records.get(started.operationId)!;
  record.state = "waitingForUser";
  state.blockCollectionReads = true;
  state.session = "changed-session";
  const ack = cancelCollectionOperationConfig.outputSchema.parse((await call(cancelTool, args)).structuredContent);
  assert.equal(ack.requested, true);
  assert.deepEqual(state.calls.at(-1), { method: "operations.cancel", params: args });
  assert.equal(getCollectionOperationConfig.outputSchema.parse((await call(statusTool, args)).structuredContent).state, "waitingForUser");
  Object.assign(record, { state: "succeeded", result: { collectionComplete: true, mediaComplete: true } });
  assert.equal(getCollectionOperationConfig.outputSchema.parse((await call(statusTool, args)).structuredContent).state, "succeeded");
  assert.deepEqual(state.submitted, ["collection.sync"]);
});

test("native cancellation rejection, terminal replies, and lost acknowledgements are distinct", async (t) => {
  const state = fixture(t);
  const { call } = await connect(t);
  async function startUndo() {
    const preview = undoCollectionActionConfig.outputSchema.parse((await call(undoTool)).structuredContent);
    assert.ok(preview.confirmationToken);
    const started = undoCollectionActionConfig.outputSchema.parse((await call(undoTool, approve(preview.confirmationToken))).structuredContent);
    assert.ok(started.operationId);
    return { operationId: started.operationId };
  }
  const first = await startUndo();
  const record = state.records.get(first.operationId)!;
  record.state = "running";
  state.rejectCancellation = true;
  const unsupported = await call(cancelTool, first);
  assert.equal(unsupported.isError, true);
  assert.match(JSON.stringify(unsupported.content), /unsupportedCapability/u);
  assert.equal(getCollectionOperationConfig.outputSchema.parse((await call(statusTool, first)).structuredContent).state, "running");
  state.rejectCancellation = false;
  Object.assign(record, { state: "succeeded", result: { changed: true, label: "Edit" } });
  assert.equal(cancelCollectionOperationConfig.outputSchema.parse((await call(cancelTool, first)).structuredContent).requested, false);
  assert.equal(getCollectionOperationConfig.outputSchema.parse((await call(statusTool, first)).structuredContent).state, "succeeded");

  const second = await startUndo();
  state.loseCancellationAcknowledgement = true;
  const lost = await call(cancelTool, second);
  assert.equal(lost.isError, true);
  assert.match(JSON.stringify(lost.content), /No retry was performed/u);
  const again = await call(cancelTool, second);
  assert.equal(again.isError, true);
  assert.match(JSON.stringify(again.content), /no duplicate request was sent/u);
  assert.equal(getCollectionOperationConfig.outputSchema.parse((await call(statusTool, second)).structuredContent).state, "cancelled");
  assert.equal(state.calls.filter(({ method }) => method === "operations.cancel").length, 3);
});

test("confirmations expire and are scoped to one running server", async () => {
  let time = 0;
  const registry = new CollectionOperationRegistry(() => time);
  const other = new CollectionOperationRegistry(() => time);
  const ctx: CollectionContext = {
    session: "session", profile: "Fixture", options: {},
    async request() { throw new Error("An expired or foreign confirmation must never send an RPC"); },
  };
  const proposal = { method: undoMethod } as const;
  const token = registry.issue(ctx, proposal);
  await assert.rejects(other.submit(ctx, proposal, token), /stale, expired/u);
  time = confirmationLifetimeSeconds * 1000;
  await assert.rejects(registry.submit(ctx, proposal, token), /stale, expired/u);
});

test("collection tools reject legacy mode without contacting Anki", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  const { call } = await connect(t);
  for (const tool of [infoTool, refreshTool, syncTool, checkTool, undoTool, statusTool, cancelTool]) {
    const result = await call(tool, tool === statusTool || tool === cancelTool ? { operationId: "test" } : {});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /ANKI_API_MODE=v1/u);
  }
  assert.equal(state.calls.length, 0);
});
