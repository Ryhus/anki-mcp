import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { calculateNoteFieldHash } from "../mcp/tools/notes/note-field-utils.js";
import { updateNoteFields, updateNoteFieldsConfig } from "../mcp/tools/notes/update-note-fields.js";

const secret = "private-v1-note-field-fixture";
type Fault = "stale-write" | "wrong-ack" | "lost-second-reply" | "stale-readback" | "mismatch-readback";

function fixture(t: TestContext, fault?: Fault) {
  const saved = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765/";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const notes = new Map(["1", "2", "3"].map((id) => [id, {
    id, noteType: { id: "100", name: "Basic" },
    fields: { Front: `<b>Note ${id}</b>`, Back: `Unrelated ${id}` },
    tags: ["keep"], cardIds: [`10${id}`], modifiedAt: "2026-11-05T12:00:00Z",
  }]));
  const methods: string[] = [];
  const writes: Array<{ id: string; patch: Record<string, string>; session: string }> = [];
  let sessionNumber = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1", "must not issue a legacy fallback");
    const request = JSON.parse(String(init.body)) as {
      jsonrpc: string; id: string; method: string;
      params: { session: string; ids?: string[]; id?: string; patch?: { fields: Record<string, string> } };
    };
    const { method, params } = request;
    methods.push(method);
    assert.equal(request.jsonrpc, "2.0");
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: request.id, result });
    const stale = () => Response.json({
      jsonrpc: "2.0", id: request.id,
      error: { code: 1005, message: secret, data: { type: "staleSession" } },
    });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: `session-${++sessionNumber}` });
    }
    assert.equal(params.session, `session-${sessionNumber}`);
    if (method === "notes.getMany") {
      if (writes.length > 0 && fault === "stale-readback") return stale();
      return ok({ items: params.ids!.map((id, index) => {
        const note = notes.get(id);
        if (note === undefined) return { index, error: { code: 1001, message: "not found" } };
        if (writes.length > 0 && fault === "mismatch-readback") {
          return { index, result: { ...note, fields: { ...note.fields, Front: "Concurrent edit" } } };
        }
        return { index, result: note };
      }) });
    }
    assert.equal(method, "notes.update");
    const { id, patch } = params;
    assert.ok(id && patch);
    assert.deepEqual(Object.keys(patch), ["fields"]);
    writes.push({ id, patch: patch.fields, session: params.session });
    if (fault === "stale-write") return stale();
    const note = notes.get(id)!;
    Object.assign(note.fields, patch.fields);
    if (fault === "wrong-ack") return ok({ ...note, id: "2" });
    if (fault === "lost-second-reply" && id === "2") throw new TypeError(secret);
    return ok(note);
  });
  return { notes, methods, writes };
}

async function update(input: unknown) {
  const args = updateNoteFieldsConfig.inputSchema.parse(input);
  return updateNoteFieldsConfig.outputSchema.parse((await updateNoteFields(args)).structuredContent);
}

function patch(id: number, value = "Changed") {
  return {
    noteId: id, fields: { front: value },
    expectedFieldHashes: { FRONT: calculateNoteFieldHash(`<b>Note ${id}</b>`) },
  };
}

test("v1 preview and apply preserve exact field hashes, unrelated HTML and tags", async (t) => {
  const anki = fixture(t);
  const value = "<b>Katze</b><br>猫";
  const preview = await update({ updates: [{ noteId: 1, fields: { front: value } }] });
  assert.equal(preview.applied, false);
  assert.equal(preview.changes[0]?.beforeFieldHash, calculateNoteFieldHash("<b>Note 1</b>"));
  assert.deepEqual(anki.methods, ["collection.get", "notes.getMany"]);
  assert.deepEqual(anki.writes, []);

  const result = await update({
    dryRun: false,
    updates: [{ noteId: 1, fields: { front: value }, expectedFieldHashes: { Front: preview.changes[0]!.beforeFieldHash } }],
  });
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.updatedNotes, [{ noteId: 1, updatedFields: ["Front"] }]);
  assert.deepEqual(anki.writes, [{ id: "1", patch: { Front: value }, session: "session-2" }]);
  assert.deepEqual(anki.notes.get("1")?.fields, { Front: value, Back: "Unrelated 1" });
  assert.deepEqual(anki.notes.get("1")?.tags, ["keep"]);
  assert.deepEqual(anki.methods.slice(2), ["collection.get", "notes.getMany", "notes.update", "notes.getMany"]);

  const unchanged = await update({
    dryRun: false, updates: [{ noteId: 1, fields: { Front: value }, expectedFieldHashes: { Front: calculateNoteFieldHash(value) } }],
  });
  assert.equal(unchanged.verified, true);
  assert.deepEqual(unchanged.updatedNotes, []);
  assert.deepEqual(anki.methods.slice(6), ["collection.get", "notes.getMany"]);
  assert.equal(anki.writes.length, 1);
});

test("a stale field or missing note blocks the entire v1 batch before a write", async (t) => {
  const anki = fixture(t);
  anki.notes.get("2")!.fields.Front = "<i>Note 2</i>";
  const result = await update({ dryRun: false, updates: [patch(1), patch(2), patch(99)] });
  assert.equal(result.applied, false);
  assert.equal(result.rejectedUpdates[0]?.noteId, 2);
  assert.deepEqual(result.missingNoteIds, [99]);
  assert.deepEqual(anki.methods, ["collection.get", "notes.getMany"]);
  assert.deepEqual(anki.writes, []);
});

for (const fault of ["stale-write", "wrong-ack", "lost-second-reply", "stale-readback", "mismatch-readback"] as const) {
  test(`v1 field update handles ${fault} without replay or false success`, async (t) => {
    const anki = fixture(t, fault);
    const updates = [patch(1), patch(2), patch(3)];
    const readbackFault = fault.endsWith("readback");
    await assert.rejects(
      update({ dryRun: false, updates: readbackFault ? updates.slice(0, 1) : updates }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        if (readbackFault) assert.match(error.message, /verification failed.*acknowledged for note IDs: 1/u);
        else assert.match(error.message, /later updates were not attempted/u);
        if (fault === "lost-second-reply") assert.match(error.message, /Previously acknowledged note IDs: 1/u);
        if (fault === "stale-write" || fault === "stale-readback") assert.match(error.message, /staleSession/u);
        return true;
      },
    );
    assert.deepEqual(anki.methods, [
      "collection.get", "notes.getMany", "notes.update",
      ...(fault === "lost-second-reply" ? ["notes.update"] : []),
      ...(readbackFault ? ["notes.getMany"] : []),
    ]);
    assert.deepEqual(anki.writes.map(({ id }) => id), fault === "lost-second-reply" ? ["1", "2"] : ["1"]);
    assert.equal(anki.notes.get("3")?.fields.Front, "<b>Note 3</b>");
    if (fault === "stale-write") assert.equal(anki.notes.get("1")?.fields.Front, "<b>Note 1</b>");
  });
}
