import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getNoteTypeSchema, getNoteTypeSchemaConfig } from "../mcp/tools/note-types/get-note-type-schema.js";
import {
  setNoteTypeSortField, setNoteTypeSortFieldConfig,
} from "../mcp/tools/note-types/set-note-type-sort-field.js";

const input = { noteTypeId: 11, sortField: "Translation" };

async function inspect() {
  const reply = await getNoteTypeSchema({ modelName: "Vocabulary" });
  return getNoteTypeSchemaConfig.outputSchema.parse(reply.structuredContent).noteType;
}

async function setSortField(args: unknown) {
  const reply = await setNoteTypeSortField(setNoteTypeSortFieldConfig.inputSchema.parse(args));
  return setNoteTypeSortFieldConfig.outputSchema.parse(reply.structuredContent);
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
    calls: [] as string[], writes: [] as string[], session: "fixture-session", missing: false,
    type: {
      id: "11", name: "Vocabulary", fields: [{ name: "Word" }, { name: "Translation" }, { name: "Hint" }],
      sortField: "Word",
    },
    failedWrite: null as "ack" | "sort" | "order" | null,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const { method, action, params, id } = JSON.parse(String(init.body));
    state.calls.push(method ?? action);
    if (process.env.ANKI_API_MODE === "legacy") {
      assert.equal(new URL(url).pathname, "/");
      const legacy = (result: unknown) => Response.json({ result, error: null });
      switch (action) {
        case "modelNamesAndIds": return legacy({ Vocabulary: 11 });
        case "modelFieldNames": return legacy(state.type.fields.map(({ name }) => name));
        case "modelFieldsOnTemplates": return legacy({ "Card 1": [["Word"], ["Translation"]] });
        default: assert.fail(`Unexpected legacy action: ${action}`);
      }
    }
    assert.equal(new URL(url).pathname, "/api/v1");
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: state.session });
    }
    assert.equal(params.session, state.session);
    if (method === "noteTypes.get") {
      assert.deepEqual(params.noteType, "id" in params.noteType ? { id: "11" } : { name: "Vocabulary" });
      return state.missing
        ? Response.json({ jsonrpc: "2.0", id, error: { code: 1001, message: "not found" } })
        : ok(state.type);
    }
    if (method === "noteTypes.getTemplateUsage") {
      assert.deepEqual(params.noteType, { id: "11" });
      return ok([{ templateName: "Card 1", questionFields: ["Word"], answerFields: ["Word", "Translation"] }]);
    }
    assert.equal(method, "noteTypes.update");
    assert.deepEqual(params, {
      noteType: { id: "11" }, patch: { sortField: input.sortField }, session: state.session,
    });
    state.writes.push(params.patch.sortField);
    if (state.failedWrite !== "sort") state.type.sortField = params.patch.sortField;
    if (state.failedWrite === "order") state.type.fields.reverse();
    return ok({
      ...state.type, sortField: params.patch.sortField, id: state.failedWrite === "ack" ? "12" : state.type.id,
    });
  });
  return state;
}

test("schema inspection reads the native sort field, with null for legacy and the same field-order hash", async (t) => {
  const state = fixture(t);
  state.type.sortField = "Translation";
  const native = await inspect();
  assert.equal(native.sortField, "Translation");
  assert.deepEqual(native.cardTemplates, [{
    name: "Card 1", questionFields: ["Word"], answerFields: ["Translation"],
  }]);
  assert.deepEqual(state.calls, ["collection.get", "noteTypes.get", "noteTypes.getTemplateUsage"]);
  process.env.ANKI_API_MODE = "legacy";
  const legacy = await inspect();
  assert.deepEqual(legacy, { ...native, sortField: null });
  assert.deepEqual(state.calls.slice(-3).sort(), ["modelFieldNames", "modelFieldsOnTemplates", "modelNamesAndIds"]);
});

test("sort-field change requires confirmation and rechecks session, current sort field, and field order", async (t) => {
  const state = fixture(t);
  const before = await inspect();
  const preview = await setSortField(input);
  assert.equal(preview.beforeSortField, "Word");
  assert.equal(preview.applied, false);
  assert.ok(preview.impactHash);
  const apply = { ...input, dryRun: false, confirmChange: true, expectedImpactHash: preview.impactHash };
  for (const unconfirmed of [{ ...apply, confirmChange: false }, { ...apply, expectedImpactHash: undefined }]) {
    assert.match((await setSortField(unconfirmed)).blockers.join(" "), /Applying requires/u);
  }
  state.session = "new-session";
  assert.match((await setSortField(apply)).blockers.join(" "), /no longer matches/u);
  state.session = "fixture-session";
  state.type.sortField = "Hint";
  assert.match((await setSortField(apply)).blockers.join(" "), /no longer matches/u);
  state.type.sortField = "Word";
  state.type.fields.reverse();
  assert.match((await setSortField(apply)).blockers.join(" "), /no longer matches/u);
  state.type.fields.reverse();
  assert.deepEqual(state.writes, []);

  const applied = await setSortField(apply);
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  assert.deepEqual(state.calls.slice(-4), ["collection.get", "noteTypes.get", "noteTypes.update", "noteTypes.get"]);
  assert.deepEqual(await inspect(), { ...before, sortField: "Translation" });
  assert.equal((await setSortField(apply)).applied, false, "replaying the stale preview does not write");
  assert.deepEqual(state.writes, ["Translation"]);
});

test("missing types and non-exact fields block the change, and a confirmed no-op does not write", async (t) => {
  const state = fixture(t);
  for (const sortField of ["translation", " Translation", "Missing"]) {
    const invalid = await setSortField({ ...input, sortField });
    assert.equal(invalid.impactHash, null);
    assert.match(invalid.blockers.join(" "), /not an exact field name/u);
  }
  state.missing = true;
  assert.match((await setSortField(input)).blockers.join(" "), /No Note Type/u);
  state.missing = false;
  const noOp = { ...input, sortField: "Word" };
  const preview = await setSortField(noOp);
  const applied = await setSortField({
    ...noOp, dryRun: false, confirmChange: true, expectedImpactHash: preview.impactHash,
  });
  assert.equal(applied.applied, false);
  assert.equal(applied.verified, true);
  assert.deepEqual(state.writes, []);
});

for (const failure of ["ack", "sort", "order"] as const) {
  test(`sort-field update rejects wrong ${failure} and never retries`, async (t) => {
    const state = fixture(t);
    const preview = await setSortField(input);
    state.failedWrite = failure;
    await assert.rejects(setSortField({
      ...input, dryRun: false, confirmChange: true, expectedImpactHash: preview.impactHash,
    }), /may already have changed; inspect Anki before retrying/u);
    assert.deepEqual(state.writes, ["Translation"]);
  });
}

test("malformed native sort field fails closed and legacy cannot invoke the setter", async (t) => {
  const state = fixture(t);
  state.type.sortField = "Not a field";
  await assert.rejects(inspect(), { action: "noteTypes.get", kind: "invalid-response" });
  await assert.rejects(setSortField(input), { action: "noteTypes.get", kind: "invalid-response" });
  const before = [...state.calls];
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(setSortField(input), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, before);
  assert.deepEqual(state.writes, []);
});
