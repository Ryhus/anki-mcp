import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { assignDeckPresetConfig } from "../mcp/tools/decks/assign-deck-preset.js";
import { deleteDeckPresetConfig } from "../mcp/tools/decks/delete-deck-preset.js";
import { updateDeckPresetConfig } from "../mcp/tools/decks/update-deck-preset.js";

const stamp = "2026-11-05T12:00:00Z";

function fixture(t: TestContext) {
  const old = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = old[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const presets = new Map(["1", "2", "3"].map((id, index) => [id, {
    id, name: ["Default", "Shared", "Unused"][index]!,
    settings: {
      newPerDay: 10, reviewsPerDay: 100, desiredRetention: Math.fround(0.90), buryNew: false,
      newGatherOrder: "deck", newSortOrder: "template", newMix: "mixed", dayLearningMix: "mixed", reviewOrder: "day",
      disableAutoplay: false, skipQuestionOnAnswerReplay: false, waitForAudio: true,
    },
    modifiedAt: stamp,
  }]));
  const decks = [
    { id: "1", name: "Default", kind: "normal", presetId: "1" },
    { id: "11", name: "Target", kind: "normal", presetId: "2" },
    { id: "12", name: "Target::Child", kind: "normal", presetId: "2" },
    { id: "13", name: "Filtered", kind: "filtered", presetId: null },
  ];
  const operations = new Map<string, { method: string; result: unknown }>();
  const calls: string[] = [];
  const writes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = { presets, decks, calls, writes, partial: false, loseStatus: false, ignoredSetting: null as string | null };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, params, id } = JSON.parse(String(init.body));
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const failed = (code: number) => Response.json({ jsonrpc: "2.0", id, error: { code, message: "private payload" } });
    calls.push(method);
    if (method === "collection.get") return ok({ session: "s", profile: "Fixture" });
    if (method === "operations.get") {
      assert.deepEqual(Object.keys(params), ["operationId"]);
      if (state.loseStatus) return failed(1001);
      const operation = operations.get(params.operationId)!;
      return ok({ ...operation, operationId: params.operationId, session: "s", state: "succeeded" });
    }
    assert.equal(params.session, "s");
    if (method === "decks.list") return ok(decks);
    if (method === "deckPresets.list") return ok([...presets.values()].map(({ id, name }) => ({ id, name })));
    if (method === "deckPresets.get") {
      const preset = presets.get(params.preset.id);
      return preset === undefined ? failed(1001) : ok(preset);
    }
    writes.push({ method, params });
    if (method === "deckPresets.create") {
      const original = presets.get(params.cloneFrom?.id ?? "1")!;
      const preset = { ...original, id: "10", name: params.name, settings: { ...original.settings } };
      presets.set("10", preset);
      return ok(preset);
    }
    const operationId = String(writes.length);
    let result: unknown;
    if (method === "deckPresets.update") {
      assert.equal(params.rescheduleFsrs, false);
      const preset = presets.get(params.preset.id)!;
      if (params.name !== undefined) preset.name = params.name;
      Object.assign(preset.settings, Object.fromEntries(
        Object.entries(params.settings ?? {}).filter(([key]) => key !== state.ignoredSetting),
      ));
      if (params.settings?.desiredRetention !== undefined) preset.settings.desiredRetention = Math.fround(params.settings.desiredRetention);
      result = preset;
    } else if (method === "deckPresets.assign") {
      assert.equal(params.rescheduleFsrs, false);
      result = { items: params.decks.map(({ id }: { id: string }, index: number) => {
        if (index === 1 && state.partial) return { index, error: { code: 1009, message: "private payload" } };
        decks.find((deck) => deck.id === id)!.presetId = params.preset.id;
        return { index, result: { changed: true } };
      }) };
    } else {
      assert.equal(method, "deckPresets.delete");
      assert.equal(params.replacement, undefined);
      assert.ok(!decks.some(({ presetId }) => presetId === params.preset.id));
      presets.delete(params.preset.id);
      result = { changed: true };
    }
    operations.set(operationId, { method, result });
    return ok({ operationId, method, session: "s" });
  });
  return state;
}

async function connect(t: TestContext, protocol: "2025-11-25" | "2026-07-28") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(createServer, { transport: b });
  const client = new Client({ name: "preset-test", version: "0.0.0" }, {
    supportedProtocolVersions: [protocol],
    versionNegotiation: { mode: protocol === "2026-07-28" ? { pin: protocol } : "legacy" },
  });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(a);
  return (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
}

for (const protocol of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${protocol} lists, clones, previews, applies and verifies deck presets`, async (t) => {
    const state = fixture(t);
    const call = await connect(t, protocol);
    const list = await call("list-deck-presets");
    assert.deepEqual(list.structuredContent, {
      total: 3, hasMore: false,
      presets: [{ id: 1, name: "Default", assignedDeckCount: 1 }, { id: 2, name: "Shared", assignedDeckCount: 2 }, { id: 3, name: "Unused", assignedDeckCount: 0 }],
    });
    const read = await call("get-deck-preset", { deckId: 11 });
    assert.notEqual(read.isError, true);
    assert.match(JSON.stringify(read.structuredContent), /"assignedDeckCount":2/u);
    assert.equal((await call("get-deck-preset", { deckId: 13 })).isError, true);
    const clone = await call("create-deck-preset", { name: "Copy", cloneFromPresetId: 2 });
    assert.notEqual(clone.isError, true);
    assert.deepEqual(state.presets.get("10")?.settings, state.presets.get("2")?.settings);
    assert.ok(!state.decks.some(({ presetId }) => presetId === "10"));
    assert.equal((await call("create-deck-preset", { name: "copy" })).isError, true);

    const patch = { presetId: 2, settings: { newPerDay: 20, desiredRetention: 0.92 } };
    const preview = updateDeckPresetConfig.outputSchema.parse((await call("update-deck-preset", patch)).structuredContent);
    assert.deepEqual(preview.affectedDecks.map(({ id }) => id), [11, 12]);
    assert.ok(preview.impactHash);
    state.decks[2]!.presetId = "1";
    const args = { ...patch, dryRun: false, confirmChanges: true, expectedImpactHash: preview.impactHash };
    const stale = updateDeckPresetConfig.outputSchema.parse((await call("update-deck-preset", args)).structuredContent);
    assert.equal(stale.applied, false);
    assert.equal(state.writes.length, 1);
    state.decks[2]!.presetId = "2";
    const saved = updateDeckPresetConfig.outputSchema.parse((await call("update-deck-preset", args)).structuredContent);
    assert.equal(saved.verified, true);
    assert.equal(state.presets.get("2")?.settings.desiredRetention, Math.fround(0.92));
    const raw = await call("update-deck-preset", { presetId: 2, settings: { fsrsParameters6: [1] } });
    assert.equal(raw.isError, true);
    assert.equal(state.writes.length, 2);

    const assignment = { presetId: 10, deckIds: [11] };
    const blocked = assignDeckPresetConfig.outputSchema.parse((await call("assign-deck-preset", { presetId: 10, deckIds: [11, 13] })).structuredContent);
    assert.equal(blocked.impactHash, null);
    const planned = assignDeckPresetConfig.outputSchema.parse((await call("assign-deck-preset", assignment)).structuredContent);
    const assigned = await call("assign-deck-preset", { ...assignment, dryRun: false, expectedImpactHash: planned.impactHash, confirmChanges: true });
    assert.equal(assignDeckPresetConfig.outputSchema.parse(assigned.structuredContent).verified, true);
    assert.equal(state.decks[1]?.presetId, "10");
    assert.equal(state.decks[2]?.presetId, "2", "child decks are not implicitly reassigned");

    for (const presetId of [1, 2, 10]) {
      const denied = deleteDeckPresetConfig.outputSchema.parse((await call("delete-deck-preset", { presetId })).structuredContent);
      assert.equal(denied.impactHash, null);
      assert.ok(denied.blockers.length > 0);
    }
    const unused = deleteDeckPresetConfig.outputSchema.parse((await call("delete-deck-preset", { presetId: 3 })).structuredContent);
    const deleted = await call("delete-deck-preset", { presetId: 3, dryRun: false, expectedImpactHash: unused.impactHash, confirmDeletion: true });
    assert.equal(deleteDeckPresetConfig.outputSchema.parse(deleted.structuredContent).verified, true);
    assert.equal(state.presets.has("3"), false);
    assert.deepEqual(state.writes.map(({ method }) => method), ["deckPresets.create", "deckPresets.update", "deckPresets.assign", "deckPresets.delete"]);
  });
}

const displayAndAudio = {
  newGatherOrder: "deckThenRandomNotes", newSortOrder: "randomNoteThenTemplate",
  newMix: "afterReviews", dayLearningMix: "beforeReviews", reviewOrder: "intervalAscending",
  disableAutoplay: true, skipQuestionOnAnswerReplay: true, waitForAudio: false,
};

for (const protocol of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${protocol} previews and verifies only the reviewed display and audio changes`, async (t) => {
    const state = fixture(t);
    const call = await connect(t, protocol);
    const name = "update-deck-preset";
    for (const settings of [
      { newGatherOrder: "random" }, { newSortOrder: "deck" }, { dayLearningMix: "afterNew" },
      { reviewOrder: "ascending" }, { disableAutoplay: "true" }, { waitForAudio: 0 },
      { newInsertOrder: "random" }, { fsrs: true }, { answerAction: "again" },
    ]) {
      assert.equal((await call(name, { presetId: 2, settings })).isError, true);
    }
    assert.equal(state.calls.length, 0);

    const patch = { presetId: 2, settings: { ...displayAndAudio, newPerDay: 10 } };
    const update = async (args: Record<string, unknown>) =>
      updateDeckPresetConfig.outputSchema.parse((await call(name, args)).structuredContent);
    const before = { ...state.presets.get("2")!.settings };
    const preview = await update(patch);
    assert.ok(preview.dryRun && !preview.applied && preview.impactHash);
    assert.deepEqual(preview.affectedDecks.map(({ id }) => id), [11, 12]);
    assert.deepEqual(Object.fromEntries(preview.settingChanges.map(({ key, after }) => [key, after])), displayAndAudio);
    for (const { key, before: previous } of preview.settingChanges) {
      assert.equal(previous, before[key as keyof typeof before]);
    }
    assert.equal(state.writes.length, 0);

    const apply = { ...patch, dryRun: false, confirmChanges: true, expectedImpactHash: preview.impactHash };
    const preset = state.presets.get("2")!;
    preset.settings.waitForAudio = false;
    const stale = await update(apply);
    assert.equal(stale.applied, false);
    assert.match(stale.blockers.join(" "), /changed since the preview/u);
    assert.equal(state.writes.length, 0);
    preset.settings.waitForAudio = true;

    const saved = await update(apply);
    assert.ok(saved.applied && saved.verified);
    assert.deepEqual(state.writes, [{ method: "deckPresets.update", params: {
      preset: { id: "2" }, settings: displayAndAudio, rescheduleFsrs: false, session: "s",
    } }]);
    assert.deepEqual(preset.settings, { ...before, ...displayAndAudio });
    assert.deepEqual(state.calls.slice(-4), ["deckPresets.update", "operations.get", "deckPresets.get", "decks.list"]);

    const same = await update(patch);
    assert.deepEqual(same.settingChanges, []);
    const noOp = await update({ ...apply, expectedImpactHash: same.impactHash });
    assert.ok(!noOp.applied && noOp.verified);
    assert.equal(state.writes.length, 1);
  });
}

test("an acknowledged display/audio update with mismatched readback does not report success", async (t) => {
  const state = fixture(t);
  const call = await connect(t, "2026-07-28");
  const patch = { presetId: 2, settings: { newMix: "afterReviews", disableAutoplay: true } };
  const preview = updateDeckPresetConfig.outputSchema.parse((await call("update-deck-preset", patch)).structuredContent);
  state.ignoredSetting = "disableAutoplay";
  const result = await call("update-deck-preset", {
    ...patch, dryRun: false, confirmChanges: true, expectedImpactHash: preview.impactHash,
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /may already be applied/u);
  assert.equal(state.writes.length, 1);
  assert.equal(state.presets.get("2")?.settings.newMix, "afterReviews");
  assert.equal(state.presets.get("2")?.settings.disableAutoplay, false);
});

test("a partial assignment or missing operation result reports uncertainty without retrying", async (t) => {
  const state = fixture(t);
  const call = await connect(t, "2026-07-28");
  const input = { presetId: 3, deckIds: [11, 12] };
  const preview = assignDeckPresetConfig.outputSchema.parse((await call("assign-deck-preset", input)).structuredContent);
  state.partial = true;
  const failed = await call("assign-deck-preset", { ...input, dryRun: false, confirmChanges: true, expectedImpactHash: preview.impactHash });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /may already be applied/u);
  assert.doesNotMatch(JSON.stringify(failed.content), /private payload/u);
  assert.deepEqual(state.decks.slice(1, 3).map(({ presetId }) => presetId), ["3", "2"]);

  const update = { presetId: 2, settings: { newPerDay: 15 } };
  const changed = updateDeckPresetConfig.outputSchema.parse((await call("update-deck-preset", update)).structuredContent);
  state.loseStatus = true;
  const lost = await call("update-deck-preset", { ...update, dryRun: false, confirmChanges: true, expectedImpactHash: changed.impactHash });
  assert.equal(lost.isError, true);
  assert.match(JSON.stringify(lost.content), /may already be applied/u);
  assert.deepEqual(state.writes.map(({ method }) => method), ["deckPresets.assign", "deckPresets.update"]);
});
