import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { deleteUnusedNoteType, deleteUnusedNoteTypeConfig } from "../mcp/tools/note-types/delete-unused-note-type.js";

const input = { noteTypeId: 11 };
const writeMethod = "noteTypes.deleteUnused";

async function call(args: unknown) {
  const result = await deleteUnusedNoteType(deleteUnusedNoteTypeConfig.inputSchema.parse(args));
  return deleteUnusedNoteTypeConfig.outputSchema.parse(result.structuredContent);
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
    session: "fixture-session", calls: [] as string[],
    type: {
      id: "11", name: "Old design", kind: "normal", css: ".card {}",
      fields: [{ name: "Word", sticky: false }], sortField: "Word",
      templates: [{ name: "Card 1", questionHtml: "{{Word}}", answerHtml: "{{FrontSide}}" }],
      modifiedAt: "2026-11-05T12:00:00Z",
    },
    present: true, other: true, ids: [] as string[], cursor: null as string | null,
    failure: null as "conflict" | "ack" | "readback" | "other-missing" | null,
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
    switch (method) {
      case "noteTypes.list":
        return ok([
          ...(state.present ? [{ id: state.type.id, name: state.type.name }] : []),
          ...(state.other ? [{ id: "12", name: "Retain" }] : []),
        ]);
      case "noteTypes.get":
        assert.deepEqual(params, { noteType: { id: "11" }, session: state.session });
        return ok(state.type);
      case "notes.search":
        assert.deepEqual(params, { query: "mid:11", limit: 1, session: state.session });
        return ok({ ids: state.ids, nextCursor: state.cursor });
      case writeMethod:
        assert.deepEqual(params, { noteTypes: [{ id: "11" }], session: state.session });
        if (state.failure === "conflict") return ok({
          items: [{ index: 0, error: { code: 1008, message: "note appeared after preflight" } }],
        });
        if (state.failure === "ack") return ok({ items: [{ index: 0, result: { changed: false } }] });
        if (state.failure !== "readback") state.present = false;
        if (state.failure === "other-missing") state.other = false;
        return ok({ items: [{ index: 0, result: { changed: true } }] });
      default: assert.fail(`Unexpected RPC: ${method}`);
    }
  });
  return state;
}

test("deletion binds the reviewed definition and session, then removes one ID and verifies the remaining inventory", async (t) => {
  const state = fixture(t);
  const preview = await call(input);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.hasNotes, false);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.noteType, { id: 11, name: "Old design", kind: "normal" });
  assert.ok(preview.impactHash);
  const reads = ["collection.get", "noteTypes.list", "noteTypes.get", "notes.search"];
  assert.deepEqual(state.calls, reads);

  const apply = { ...input, dryRun: false, confirmDeletion: true, expectedImpactHash: preview.impactHash };
  for (const unconfirmed of [{ ...apply, confirmDeletion: false }, { ...apply, expectedImpactHash: undefined }]) {
    assert.match((await call(unconfirmed)).blockers.join(" "), /Applying requires/u);
  }
  state.session = "different-session";
  assert.match((await call(apply)).blockers.join(" "), /no longer matches/u);
  state.session = "fixture-session";
  state.type.css = ".card { color: red }";
  assert.match((await call(apply)).blockers.join(" "), /no longer matches/u);
  state.type.css = ".card {}";
  state.type.fields[0]!.sticky = true;
  assert.match((await call(apply)).blockers.join(" "), /no longer matches/u);
  state.type.fields[0] = { sticky: false, name: "Word" };
  assert.equal((await call(input)).impactHash, preview.impactHash, "object key order does not change the review hash");
  state.ids = ["99"];
  assert.match((await call(apply)).blockers.join(" "), /still uses/u);
  state.ids = [];
  assert.equal(state.calls.includes(writeMethod), false);

  const applied = await call(apply);
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  assert.deepEqual(state.calls.slice(-6), [...reads, writeMethod, "noteTypes.list"]);
  assert.equal((await call(apply)).applied, false, "replay does not delete another type");
  assert.equal(state.calls.filter((method) => method === writeMethod).length, 1);
});

test("any matching Note is sufficient to block deletion; missing and last types are blocked", async (t) => {
  const state = fixture(t);
  state.ids = ["99"];
  state.cursor = "more";
  const used = await call(input);
  assert.equal(used.hasNotes, true);
  assert.equal(used.impactHash, null);
  assert.match(used.blockers.join(" "), /At least one Note/u);
  state.ids = [];
  state.cursor = null;
  state.other = false;
  const last = await call(input);
  assert.equal(last.hasNotes, false);
  assert.equal(last.impactHash, null);
  assert.match(last.blockers.join(" "), /last Note Type/u);
  const missing = await call({ noteTypeId: 13 });
  assert.equal(missing.hasNotes, null);
  assert.match(missing.blockers.join(" "), /No Note Type was found/u);
  assert.equal(state.calls.includes(writeMethod), false);
});

for (const failure of ["conflict", "ack", "readback", "other-missing"] as const) {
  test(`native ${failure} does not report deletion success or retry`, async (t) => {
    const state = fixture(t);
    const preview = await call(input);
    state.failure = failure;
    await assert.rejects(call({
      ...input, dryRun: false, confirmDeletion: true, expectedImpactHash: preview.impactHash,
    }), /may already have been deleted; inspect Anki before retrying/u);
    assert.equal(state.calls.filter((method) => method === writeMethod).length, 1);
  });
}

test("ambiguous usage results fail closed and legacy sends no request", async (t) => {
  const state = fixture(t);
  state.cursor = "unexpected-empty-page";
  await assert.rejects(call(input), { kind: "invalid-response", action: "notes.search" });
  const before = [...state.calls];
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(call(input), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, before);
  assert.equal(state.calls.includes(writeMethod), false);
});
