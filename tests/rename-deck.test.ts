import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { planDeckRename, renameDeck, renameDeckConfig } from "../mcp/tools/decks/rename-deck.js";
import type { ManagedDeck } from "../anki-api/decks/deck-management-client.js";

const original: ManagedDeck[] = [
  { id: 11, name: "Source", kind: "normal", presetId: 2 },
  { id: 12, name: "Source::Child", kind: "normal", presetId: 1 },
  { id: 13, name: "Parent", kind: "normal", presetId: 1 },
  { id: 14, name: "Filtered", kind: "filtered", presetId: null },
];

test("rename impact covers the full subtree and rejects missing parents, collisions and cycles", () => {
  const clean = planDeckRename("Profile", original, "Source", "Parent::Renamed");
  assert.ok(clean.impactHash);
  assert.deepEqual(clean.changes, [
    { deckId: 11, beforeName: "Source", afterName: "Parent::Renamed" },
    { deckId: 12, beforeName: "Source::Child", afterName: "Parent::Renamed::Child" },
  ]);
  assert.equal(planDeckRename("Profile", [...original].reverse(), "Source", "Parent::Renamed").impactHash, clean.impactHash);
  assert.notEqual(planDeckRename("Other Profile", original, "Source", "Parent::Renamed").impactHash, clean.impactHash);
  for (const name of ["Missing::Renamed", "Source::Child::New", "pARENT", "Filtered::Renamed"]) {
    assert.equal(planDeckRename("Profile", original, "Source", name).impactHash, null);
  }
  assert.equal(planDeckRename("Profile", [...original, {
    id: 99, name: "Parent::Renamed::child", kind: "normal", presetId: 1,
  }], "Source", "Parent::Renamed").impactHash, null);
  assert.ok(planDeckRename("Profile", original, "Source", "source").impactHash, "case-only rename is allowed");
});

function fixture(t: TestContext) {
  const saved = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = { decks: original.map((deck) => ({ ...deck })), calls: [] as string[], skipChild: false };
  const native = ({ id, presetId, ...rest }: ManagedDeck) => ({ id: String(id), presetId: presetId === null ? null : String(presetId), ...rest });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, params, id } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") return ok({ profile: "Profile", session: "s" });
    assert.equal(params.session, "s");
    if (method === "decks.list") return ok(state.decks.map(native));
    assert.equal(method, "decks.update");
    assert.deepEqual(params, { deck: { id: "11" }, name: "Parent::Renamed", session: "s" });
    state.decks[0]!.name = params.name;
    if (!state.skipChild) state.decks[1]!.name = params.name + "::Child";
    return ok(native(state.decks[0]!));
  });
  return state;
}

const input = { name: "Source", newName: "Parent::Renamed" };
async function call(args: unknown) {
  return renameDeckConfig.outputSchema.parse((await renameDeck(renameDeckConfig.inputSchema.parse(args))).structuredContent);
}

test("preview and stale impact checks precede the single native rename; readback verifies identities", async (t) => {
  const state = fixture(t);
  const preview = await call(input);
  assert.deepEqual(state.calls, ["collection.get", "decks.list"]);
  assert.ok(preview.impactHash);
  state.decks[1]!.presetId = 7;
  const apply = { ...input, dryRun: false, confirmRename: true, expectedImpactHash: preview.impactHash };
  const stale = await call(apply);
  assert.equal(stale.applied, false);
  assert.match(stale.blockers.join(" "), /changed since the preview/u);
  assert.equal(state.calls.includes("decks.update"), false);
  state.decks[1]!.presetId = 1;
  assert.equal((await call({ ...apply, confirmRename: false })).applied, false);
  const result = await call(apply);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(state.calls.slice(-4), ["collection.get", "decks.list", "decks.update", "decks.list"]);
  assert.equal(state.calls.filter((method) => method === "decks.update").length, 1);
});

test("a wrong descendant path never reports verified success or retries", async (t) => {
  const state = fixture(t);
  state.skipChild = true;
  const preview = await call(input);
  await assert.rejects(call({ ...input, dryRun: false, confirmRename: true, expectedImpactHash: preview.impactHash }), /may already have changed/u);
  assert.equal(state.calls.filter((method) => method === "decks.update").length, 1);
});

test("rename is unavailable in legacy mode without sending any request", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(call(input), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, []);
});
