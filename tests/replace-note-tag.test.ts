import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { replaceNoteTag, replaceNoteTagConfig } from "../mcp/tools/notes/replace-note-tag.js";

const name = "replace-note-tag";
const input = { noteIds: [13, 11, 12, 11], from: "inbox", to: "reviewed" };
const nativeRead = ["collection.get", "notes.getMany"];

async function direct(args: unknown) {
  const result = await replaceNoteTag(replaceNoteTagConfig.inputSchema.parse(args));
  return replaceNoteTagConfig.outputSchema.parse(result.structuredContent);
}

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
    session: "tag-session",
    tags: new Map([["11", ["Inbox", "keep"]], ["12", ["inbox::later", "keep"]], ["13", ["inbox", "Reviewed"]]]),
    calls: [] as string[],
    failures: null as "count" | "unrelated" | "source-remains" | null,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, params, id } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: state.session });
    }
    assert.equal(params.session, state.session);
    if (method === "notes.getMany") {
      assert.ok(Array.isArray(params.ids));
      return ok({ items: (params.ids as string[]).map((id, index) => {
        const tags = state.tags.get(id);
        return tags === undefined ? { index, error: { code: 1001, message: "missing note" } }
          : { index, result: {
            id, noteType: { id: "7", name: "Fixture" }, fields: { Front: "not included in preview" },
            tags, cardIds: [], modifiedAt: "2026-11-05T12:00:00Z",
          } };
      }) });
    }
    assert.equal(method, "tags.replace");
    assert.deepEqual(params, { noteIds: ["11", "13"], from: "inbox", to: "reviewed", session: state.session });
    if (state.failures === "count") return ok({ changedCount: 1 });
    state.tags.set("11", state.failures === "unrelated" ? ["Reviewed"] : ["Reviewed", "keep"]);
    state.tags.set("13", state.failures === "source-remains" ? ["inbox", "Reviewed"] : ["Reviewed"]);
    return ok({ changedCount: 2 });
  });
  return state;
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} replaces only reviewed full tags and never selects the whole collection`, async (t) => {
    const state = fixture(t);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "replace-tag-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    const tool = (await client.listTools()).tools.find((tool) => tool.name === name);
    assert.equal(tool?.annotations?.destructiveHint, true);
    const call = (args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    for (const args of [
      { from: "inbox", to: "reviewed" }, { ...input, allNotes: true }, { ...input, noteIds: [] },
      { ...input, noteIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { ...input, to: "INBOX" },
      { ...input, to: "two tags" }, { ...input, to: "inbox::" },
    ]) {
      assert.equal((await call(args)).isError, true);
    }
    assert.equal(state.calls.length, 0);
    const previewResult = await call(input);
    const preview = replaceNoteTagConfig.outputSchema.parse(previewResult.structuredContent);
    assert.ok(preview.dryRun && !preview.applied && !preview.verified && preview.impactHash);
    assert.deepEqual(preview.changes, [
      { noteId: 11, removes: ["Inbox"], targetAlreadyPresent: false },
      { noteId: 13, removes: ["inbox"], targetAlreadyPresent: true },
    ]);
    assert.deepEqual(preview.skippedNoteIds, [12]);
    assert.deepEqual(state.calls, nativeRead);
    const apply = { ...input, noteIds: [11, 12, 13], dryRun: false, confirmReplacement: true, expectedImpactHash: preview.impactHash };
    const unconfirmed = replaceNoteTagConfig.outputSchema.parse(
      (await call({ ...apply, confirmReplacement: false })).structuredContent,
    );
    assert.match(unconfirmed.blockers.join(" "), /Applying requires/u);
    state.tags.set("12", ["inbox::later", "keep", "inbox"]);
    const stale = replaceNoteTagConfig.outputSchema.parse((await call(apply)).structuredContent);
    assert.match(stale.blockers.join(" "), /changed/u);
    assert.equal(state.calls.includes("tags.replace"), false);
    state.tags.set("12", ["keep", "inbox::later"]);
    const saved = replaceNoteTagConfig.outputSchema.parse((await call(apply)).structuredContent);
    assert.ok(saved.applied && saved.verified);
    assert.deepEqual(state.calls.slice(-4), [...nativeRead, "tags.replace", "notes.getMany"]);
    assert.deepEqual(state.tags.get("12"), ["keep", "inbox::later"]);
    const replayed = replaceNoteTagConfig.outputSchema.parse((await call(apply)).structuredContent);
    assert.equal(replayed.applied, false);
    assert.equal(state.calls.filter((method) => method === "tags.replace").length, 1);
  });
}

test("missing Notes, a stale session, and a confirmed no-op do not write", async (t) => {
  const state = fixture(t);
  const missing = await direct({ ...input, noteIds: [11, 99] });
  assert.deepEqual(missing.missingNoteIds, [99]);
  assert.equal(missing.impactHash, null);
  assert.match(missing.blockers.join(" "), /No partial replacement/u);
  const preview = await direct(input);
  state.session = "other-session";
  const stale = await direct({ ...input, dryRun: false, confirmReplacement: true, expectedImpactHash: preview.impactHash });
  assert.match(stale.blockers.join(" "), /session changed/u);
  const noOpInput = { ...input, noteIds: [12] };
  const noOp = await direct(noOpInput);
  const applied = await direct({
    ...noOpInput, dryRun: false, confirmReplacement: true, expectedImpactHash: noOp.impactHash,
  });
  assert.equal(applied.verified, true);
  assert.equal(applied.applied, false);
  assert.equal(state.calls.includes("tags.replace"), false);
});

for (const failure of ["count", "unrelated", "source-remains"] as const) {
  test(`tag replacement reports a failed ${failure} check and never retries`, async (t) => {
    const state = fixture(t);
    const preview = await direct(input);
    state.failures = failure;
    await assert.rejects(direct({
      ...input, dryRun: false, confirmReplacement: true, expectedImpactHash: preview.impactHash,
    }), /may already have changed; inspect the selected Notes before retrying/u);
    assert.equal(state.calls.filter((method) => method === "tags.replace").length, 1);
  });
}

test("legacy mode refuses replacement before contacting Anki", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(direct(input), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, []);
});
