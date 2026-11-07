import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renameNoteType, renameNoteTypeConfig } from "../mcp/tools/note-types/rename-note-type.js";

const input = { noteTypeId: 11, newName: "German Verbs" };

async function call(args: unknown) {
  const result = await renameNoteType(renameNoteTypeConfig.inputSchema.parse(args));
  return renameNoteTypeConfig.outputSchema.parse(result.structuredContent);
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
    types: new Map([["11", "Basic"], ["12", "Cloze"]]),
    session: "fixture-session",
    calls: [] as string[],
    writes: [] as { id: string; name: string }[],
    badAck: false,
    skipSave: false,
    lookupError: null as number | null,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1", "only native requests are expected");
    const { method, params, id } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number) => Response.json({ jsonrpc: "2.0", id, error: { code, message: "private" } });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: state.session });
    }
    assert.equal(params.session, state.session);
    if (method === "noteTypes.get") {
      if (state.lookupError !== null) return fail(state.lookupError);
      const ref = params.noteType;
      if (ref.id !== undefined) {
        assert.equal(ref.id, "11");
        const name = state.types.get(ref.id);
        return name === undefined ? fail(1001) : ok({ id: ref.id, name });
      }
      const type = [...state.types].find(([, name]) => name.toLowerCase() === ref.name.toLowerCase());
      return type === undefined ? fail(1001) : ok({ id: type[0], name: type[1] });
    }
    assert.equal(method, "noteTypes.update");
    const { name } = params.patch;
    assert.deepEqual(params, { noteType: { id: "11" }, patch: { name }, session: state.session });
    state.writes.push({ id: params.noteType.id, name });
    if (!state.skipSave) state.types.set("11", name);
    return ok({ id: state.badAck ? "12" : "11", name });
  });
  return state;
}

test("rename previews by ID, requires fresh confirmation, and verifies one name-only write", async (t) => {
  const state = fixture(t);
  const preview = await call(input);
  assert.deepEqual(state.calls, ["collection.get", "noteTypes.get", "noteTypes.get"]);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.beforeName, "Basic");
  assert.equal(preview.applied, false);
  assert.ok(preview.impactHash);

  const apply = { ...input, dryRun: false, confirmRename: true, expectedImpactHash: preview.impactHash };
  for (const unconfirmed of [{ ...apply, confirmRename: false }, { ...apply, expectedImpactHash: undefined }]) {
    assert.match((await call(unconfirmed)).blockers.join(" "), /Applying requires/u);
  }
  state.session = "another-session";
  assert.match((await call(apply)).blockers.join(" "), /no longer matches/u);
  state.session = "fixture-session";
  state.types.set("11", "Renamed in Anki");
  assert.match((await call(apply)).blockers.join(" "), /no longer matches/u);
  state.types.set("11", "Basic");
  assert.match((await call({ ...apply, newName: "Different proposal" })).blockers.join(" "), /no longer matches/u);
  state.types.set("13", "GERMAN VERBS");
  assert.match((await call(apply)).blockers.join(" "), /already uses/u);
  state.types.delete("13");
  assert.deepEqual(state.writes, []);

  const result = await call(apply);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(state.calls.slice(-5), [
    "collection.get", "noteTypes.get", "noteTypes.get", "noteTypes.update", "noteTypes.get",
  ]);
  assert.deepEqual(state.writes, [{ id: "11", name: "German Verbs" }]);
  assert.equal((await call(apply)).applied, false, "replaying the old preview does not write");
  assert.equal(state.writes.length, 1);
});

test("missing and conflicting Note Types are blocked; a no-op never writes and case-only renames work", async (t) => {
  const state = fixture(t);
  assert.match((await call({ ...input, newName: "cloze" })).blockers.join(" "), /already uses/u);
  state.types.delete("11");
  const missing = await call(input);
  assert.equal(missing.impactHash, null);
  assert.match(missing.blockers.join(" "), /No Note Type was found/u);
  state.types.set("11", "Basic");
  const noOpInput = { ...input, newName: "Basic" };
  const noOp = await call(noOpInput);
  const result = await call({ ...noOpInput, dryRun: false, confirmRename: true, expectedImpactHash: noOp.impactHash });
  assert.equal(result.verified, true);
  assert.equal(result.applied, false);
  assert.deepEqual(state.writes, []);
  const caseInput = { ...input, newName: "basic" };
  const preview = await call(caseInput);
  assert.equal((await call({
    ...caseInput, dryRun: false, confirmRename: true, expectedImpactHash: preview.impactHash,
  })).applied, true);
  assert.deepEqual(state.writes, [{ id: "11", name: "basic" }]);
});

for (const failure of ["badAck", "skipSave"] as const) {
  test(`rename reports uncertain outcome after ${failure} and never retries`, async (t) => {
    const state = fixture(t);
    state[failure] = true;
    const preview = await call(input);
    await assert.rejects(call({
      ...input, dryRun: false, confirmRename: true, expectedImpactHash: preview.impactHash,
    }), /may already have changed; inspect Anki before retrying/u);
    assert.equal(state.writes.length, 1);
  });
}

test("lookup failures other than notFound fail closed; legacy sends no request", async (t) => {
  const state = fixture(t);
  state.lookupError = 1010;
  await assert.rejects(call(input), /busy/u);
  assert.deepEqual(state.calls, ["collection.get", "noteTypes.get"]);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(call(input), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, ["collection.get", "noteTypes.get"]);
  assert.deepEqual(state.writes, []);
});

test("new names reject input Anki could alter and normalize Unicode before preview", () => {
  const { inputSchema } = renameNoteTypeConfig;
  for (const newName of ["", " Basic", "Basic ", 'A"B', "A\nB", "A\uD800"]) {
    assert.equal(inputSchema.safeParse({ ...input, newName }).success, false);
  }
  assert.equal(inputSchema.parse({ ...input, newName: "Cafe\u0301" }).newName, "Café");
});
