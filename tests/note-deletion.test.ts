import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AnkiNoteInfo } from "../anki-api/notes/note-types.js";
import { createServer } from "../mcp/create-server.js";
import { deleteNotesAndCards, deleteNotesAndCardsConfig } from "../mcp/tools/notes/delete-notes-and-cards.js";
import { noteDeletionInputSchema, noteDeletionOutputSchema } from "../mcp/tools/notes/note-deletion-schemas.js";
import { calculateNoteDeletionImpactHash } from "../mcp/tools/notes/note-deletion-utils.js";

test("Note deletion defaults to preview and requires both a valid impact hash and confirmation to apply", () => {
  assert.deepEqual(noteDeletionInputSchema.parse({ noteIds: [1] }), {
    noteIds: [1], dryRun: true, confirmDeletion: false,
  });
  for (const input of [
    { noteIds: [] }, { noteIds: ["1"] }, { noteIds: [0] },
    { noteIds: [1], dryRun: false },
    { noteIds: [1], dryRun: false, confirmDeletion: true },
    { noteIds: [1], dryRun: false, expectedImpactHash: "a".repeat(64) },
    { noteIds: [1], dryRun: false, confirmDeletion: true, expectedImpactHash: "invalid" },
    { noteIds: Array.from({ length: 101 }, (_, index) => index + 1) },
  ]) assert.equal(noteDeletionInputSchema.safeParse(input).success, false);
  assert.equal(noteDeletionInputSchema.safeParse({
    noteIds: [1], dryRun: false, confirmDeletion: true, expectedImpactHash: "a".repeat(64),
  }).success, true);
});

test("impact hashes ignore request, field-map, tag, and Card ordering, but bind the profile", () => {
  const first = note(1, [11, 10]);
  first.tags = ["second", "first"];
  const second = note(2, [20]);
  const hash = calculateNoteDeletionImpactHash("Default", [2, 1], [second, first]);
  const reordered = structuredClone(first);
  reordered.tags = ["first", "second", "first"];
  reordered.cards = [10, 11, 10];
  reordered.fields = Object.fromEntries(Object.entries(reordered.fields).reverse());
  assert.equal(hash, calculateNoteDeletionImpactHash("Default", [1, 2, 1], [reordered, second]));
  assert.notEqual(hash, calculateNoteDeletionImpactHash("Other profile", [1, 2], [reordered, second]));
  assert.notEqual(hash, calculateNoteDeletionImpactHash("Default", [1], [first]));
});

test("a dry run reports exact impact and bounded samples, without deleting or verifying", async (t) => {
  const anki = mockAnki(t);
  const selected = anki.notes.get(1)!;
  selected.fields.Front!.value = "<b>" + "x".repeat(300) + "</b>";
  selected.fields.Third = { value: "Third", order: 2 };
  selected.fields.Fourth = { value: "Hidden field", order: 3 };
  selected.cards = Array.from({ length: 25 }, (_, index) => index + 100);
  const before = structuredClone([...anki.notes]);
  const result = await deletion({ noteIds: [1, 1, 2] });
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.profileName, "Default");
  assert.match(result.impactHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(result.impact.requestedNoteCount, 2);
  assert.equal(result.impact.noteCount, 2);
  assert.equal(result.impact.cardCount, 26);
  assert.equal(Object.keys(result.impact.notes[0]!.fieldPreviews).length, 3);
  assert.equal(result.impact.notes[0]!.fieldPreviews.Front!.length, 200);
  assert.equal(result.impact.notes[0]!.fieldPreviewsTruncated, true);
  assert.equal(result.impact.notes[0]!.sampleCardIds.length, 20);
  assert.equal(result.impact.notes[0]!.cardIdsTruncated, true);
  assert.deepEqual(result.deletedNotes, []);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(anki.requests, ["multi"]);
  assert.deepEqual(anki.actions.map(({ action }) => action), ["getActiveProfile", "notesInfo"]);
  assert.deepEqual([...anki.notes], before);
});

test("applying the reviewed batch deletes exactly selected Notes and verifies their Cards", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.actions.length = 0;
  anki.requests.length = 0;
  const result = await apply(preview, [2, 1, 1]);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.deletedNotes, [
    { noteId: 2, deletedCardIds: [20] }, { noteId: 1, deletedCardIds: [10, 11] },
  ]);
  assert.deepEqual([...anki.notes.keys()], [3]);
  assert.deepEqual([...anki.cards], [30]);
  assert.deepEqual(anki.writes, [[2, 1]]);
  assert.deepEqual(anki.requests, ["multi", "deleteNotes", "multi"]);
  assert.deepEqual(anki.actions.map(({ action }) => action), [
    "getActiveProfile", "notesInfo", "deleteNotes", "getActiveProfile", "findNotes", "findCards",
  ]);
});

for (const [label, change] of [
  ["HTML-only change", (n: AnkiNoteInfo) => { n.fields.Front!.value = "<i>House 1</i>"; }],
  ["tag edit", (n: AnkiNoteInfo) => { n.tags.push("edited"); }],
  ["Note Type change", (n: AnkiNoteInfo) => { n.modelName = "Other"; }],
  ["field order change", (n: AnkiNoteInfo) => { n.fields.Front!.order = 2; }],
  ["modification timestamp change", (n: AnkiNoteInfo) => { n.mod += 1; }],
  ["same-count Card replacement", (n: AnkiNoteInfo) => { n.cards = [10, 99]; }],
  ["new generated Card", (n: AnkiNoteInfo) => { n.cards.push(99); }],
  ["removed generated Card", (n: AnkiNoteInfo) => { n.cards = [10]; }],
] as const) {
  test(`${label} blocks the entire reviewed Note batch`, async (t) => {
    const anki = mockAnki(t);
    const preview = await deletion();
    change(anki.notes.get(1)!);
    const result = await apply(preview);
    assertBlocked(result, anki);
    assert.notEqual(result.impactHash, preview.impactHash);
  });
}

for (const [label, change] of [
  ["field text beyond the preview", (n: AnkiNoteInfo) => { n.fields.Front!.value += "<br>Hidden beyond preview"; }],
  ["a field omitted from the sample", (n: AnkiNoteInfo) => { n.fields.Fourth!.value = "Changed hidden field"; }],
  ["a Card omitted from the sample", (n: AnkiNoteInfo) => { n.cards[24] = 999; }],
] as const) {
  test(`changes to ${label} still invalidate the full impact hash`, async (t) => {
    const anki = mockAnki(t);
    const selected = anki.notes.get(1)!;
    selected.fields.Front!.value = "x".repeat(1_000);
    selected.fields.Third = { value: "Third", order: 2 };
    selected.fields.Fourth = { value: "Hidden", order: 3 };
    selected.cards = Array.from({ length: 25 }, (_, index) => index + 100);
    const preview = await deletion({ noteIds: [1] });
    change(selected);
    const result = await apply(preview, [1]);
    assert.deepEqual(result.impact, preview.impact);
    assert.notEqual(result.impactHash, preview.impactHash);
    assertBlocked(result, anki);
  });
}

test("the exported handler also refuses apply without confirmation or a reviewed hash", async (t) => {
  const anki = mockAnki(t);
  for (const args of [
    { noteIds: [1, 2], dryRun: false, confirmDeletion: true },
    { noteIds: [1, 2], dryRun: false, confirmDeletion: false },
  ]) {
    const result = noteDeletionOutputSchema.parse((await deleteNotesAndCards(args)).structuredContent);
    assertBlocked(result, anki);
  }
});

test("a changed selection with the same Note/Card counts cannot reuse a preview", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion({ noteIds: [2] });
  const result = await apply(preview, [3]);
  assert.equal(result.impact.cardCount, preview.impact.cardCount);
  assertBlocked(result, anki);
});

test("profile changes invalidate review even if Note IDs and contents match", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.profileName = "Other profile";
  assertBlocked(await apply(preview), anki);
});

test("missing, disappeared, or malformed selected Notes block all deletion and suppress the hash", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.notes.delete(2);
  const disappeared = await apply(preview);
  assert.equal(disappeared.impactHash, null);
  assert.deepEqual(disappeared.missingNoteIds, [2]);
  assertBlocked(disappeared, anki);
  const missing = await deletion({ noteIds: [1, 999] });
  assert.equal(missing.impactHash, null);
  assert.deepEqual(missing.missingNoteIds, [999]);
  assert.deepEqual(missing.deletedNotes, []);
  anki.notesInfoOverride = [{ ...note(1, [10]), fields: null }];
  assert.equal((await deletion({ noteIds: [1] })).impactHash, null);
  assert.equal(anki.writes.length, 0);
});

test("an unselected Note edit does not invalidate the selected batch", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion({ noteIds: [1] });
  anki.notes.get(3)!.fields.Front!.value = "Unselected edit";
  const result = await apply(preview, [1]);
  assert.equal(result.applied, true);
  assert.equal(anki.notes.get(3)!.fields.Front!.value, "Unselected edit");
});

test("invalid profile or Note-info responses cannot create a usable deletion plan", async (t) => {
  const anki = mockAnki(t);
  anki.profileOverride = null;
  await assert.rejects(deletion(), /valid active profile/u);
  anki.profileOverride = undefined;
  anki.notesInfoOverride = null;
  await assert.rejects(deletion(), /valid notesInfo result/u);
  assert.equal(anki.writes.length, 0);
});

test("invalid Card IDs and inconsistent Card ownership fail before deletion", async (t) => {
  const anki = mockAnki(t);
  anki.notes.get(1)!.cards = [-1];
  await assert.rejects(deletion(), /invalid Card ID/u);
  anki.notes.get(1)!.cards = [10];
  anki.notes.get(2)!.cards = [10];
  await assert.rejects(deletion(), /multiple selected Notes/u);
  assert.equal(anki.writes.length, 0);
});

test("empty or invalid field data and mismatched profile metadata cannot be reviewed", async (t) => {
  const anki = mockAnki(t);
  const selected = anki.notes.get(1)!;
  selected.profile = "Other profile";
  await assert.rejects(deletion(), /different profile/u);
  delete selected.profile;
  selected.fields.Front!.order = -1;
  await assert.rejects(deletion(), /incomplete or invalid fields/u);
  selected.fields = {};
  await assert.rejects(deletion(), /incomplete or invalid fields/u);
  assert.equal(anki.writes.length, 0);
});

test("a Note with no generated Cards is deleted without an unrestricted Card query", async (t) => {
  const anki = mockAnki(t);
  anki.notes.get(1)!.cards.forEach((id) => anki.cards.delete(id));
  anki.notes.get(1)!.cards = [];
  const result = await apply(await deletion({ noteIds: [1] }), [1]);
  assert.equal(result.applied, true);
  assert.equal(result.impact.cardCount, 0);
  assert.equal(result.verified, true);
  assert.equal(anki.actions.some(({ action }) => action === "findCards"), false);
});

test("verification splits large Card scopes into bounded ID-only searches", async (t) => {
  const anki = mockAnki(t);
  const ids = Array.from({ length: 501 }, (_, index) => index + 100);
  anki.notes.get(1)!.cards.forEach((id) => anki.cards.delete(id));
  anki.notes.get(1)!.cards = ids;
  ids.forEach((id) => anki.cards.add(id));
  const result = await apply(await deletion({ noteIds: [1] }), [1]);
  assert.equal(result.verified, true);
  const queries = anki.actions.filter(({ action }) => action === "findCards");
  assert.equal(queries.length, 3);
  for (const { params } of queries) {
    assert.ok(String(params.query).split(" or ").length <= 250);
  }
});

for (const mode of ["noop", "keep-cards", "partial"] as const) {
  test(`verification refuses success after a ${mode} deletion response`, async (t) => {
    const anki = mockAnki(t);
    const preview = await deletion();
    anki.deleteMode = mode;
    await assert.rejects(apply(preview), /acknowledged.*verification failed.*already be deleted/u);
    assert.equal(anki.writes.length, 1);
  });
}

for (const mode of ["throw-before", "throw-after"] as const) {
  test(`${mode} write failures report uncertain deletion without retries`, async (t) => {
    const anki = mockAnki(t);
    const preview = await deletion();
    anki.deleteMode = mode;
    await assert.rejects(apply(preview), /Could not confirm deletion.*may already be deleted.*no automatic retry/u);
    assert.equal(anki.writes.length, 1);
    assert.equal(anki.actions.some(({ action }) => action === "findNotes"), false);
    assert.equal(anki.notes.has(1), mode === "throw-before");
  });
}

test("verification read failures and profile switches report acknowledged deletion, not success", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.failVerification = true;
  await assert.rejects(apply(preview), /acknowledged.*verification failed.*read unavailable/u);
  assert.equal(anki.writes.length, 1);
});

test("a profile switch during verification cannot masquerade as empty search results", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.switchProfileOnDelete = true;
  await assert.rejects(apply(preview), /verification failed.*profile changed/u);
  assert.equal(anki.writes.length, 1);
});

test("invalid verification data is not treated as proof of absence", async (t) => {
  const anki = mockAnki(t);
  const preview = await deletion();
  anki.verificationOverride = null;
  await assert.rejects(apply(preview), /verification failed.*invalid deletion verification/u);
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} enforces Note deletion preview, review, and verified application`, async (t) => {
    const anki = mockAnki(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "note-deletion-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find(({ name }) => name === "delete-notes-and-cards");
    assert.equal(tool?.annotations?.destructiveHint, true);
    const call = async (args: Record<string, unknown>) => noteDeletionOutputSchema.parse(
      (await client.callTool({ name: "delete-notes-and-cards", arguments: args })).structuredContent,
    );
    const preview = await call({ noteIds: [1, 2] });
    assert.equal(preview.dryRun, true);
    assert.equal(anki.writes.length, 0);
    const requestCount = anki.requests.length;
    for (const args of [{ noteIds: [1, 2], dryRun: false }, {
      noteIds: [1, 2], dryRun: false, confirmDeletion: true,
    }]) {
      assert.equal((await client.callTool({ name: "delete-notes-and-cards", arguments: args })).isError, true);
    }
    assert.equal(anki.requests.length, requestCount);
    anki.notes.get(1)!.fields.Back!.value = "A concurrent edit";
    const stale = await call({ noteIds: [1, 2], dryRun: false, confirmDeletion: true, expectedImpactHash: preview.impactHash });
    assertBlocked(stale, anki);
    const fresh = await call({ noteIds: [1, 2] });
    const deleted = await call({ noteIds: [1, 2], dryRun: false, confirmDeletion: true, expectedImpactHash: fresh.impactHash });
    assert.equal(deleted.applied, true);
    assert.equal(deleted.verified, true);
    assert.deepEqual([...anki.notes.keys()], [3]);
    assert.equal(anki.writes.length, 1);
  });
}

async function deletion(input: Record<string, unknown> = {}) {
  return noteDeletionOutputSchema.parse((await deleteNotesAndCards(
    noteDeletionInputSchema.parse({ noteIds: [1, 2], ...input }),
  )).structuredContent);
}

type DeletionResult = Awaited<ReturnType<typeof deletion>>;

async function apply(preview: DeletionResult, noteIds = [1, 2]) {
  assert.ok(preview.impactHash);
  return deletion({ noteIds, dryRun: false, expectedImpactHash: preview.impactHash, confirmDeletion: true });
}

function assertBlocked(result: DeletionResult, anki: { writes: number[][] }) {
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.deepEqual(result.deletedNotes, []);
  assert.ok(result.blockers.length > 0);
  assert.equal(anki.writes.length, 0);
}

function note(noteId: number, cards: number[]): AnkiNoteInfo {
  return {
    noteId, modelName: "Basic", mod: 1_700_000_000, tags: [], cards,
    fields: {
      Front: { value: `<b>House ${noteId}</b>`, order: 0 },
      Back: { value: "Home", order: 1 },
    },
  };
}

function mockAnki(t: TestContext) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  type DeleteMode = "normal" | "noop" | "keep-cards" | "partial" | "throw-before" | "throw-after";
  interface Action { action: string; params?: Record<string, unknown> }
  const state = {
    profileName: "Default", profileOverride: undefined as unknown,
    notesInfoOverride: undefined as unknown, verificationOverride: undefined as unknown,
    notes: new Map([[1, note(1, [10, 11])], [2, note(2, [20])], [3, note(3, [30])]]),
    cards: new Set([10, 11, 20, 30]),
    requests: [] as string[], actions: [] as Array<{ action: string; params: Record<string, unknown> }>,
    writes: [] as number[][], deleteMode: "normal" as DeleteMode,
    failVerification: false, switchProfileOnDelete: false,
  };
  function execute(action: string, params: Record<string, unknown>): unknown {
    if (action === "multi") {
      return (params.actions as Action[]).map((nested) => {
        try { return { result: execute(nested.action, nested.params ?? {}), error: null }; }
        catch (error) { return { result: null, error: error instanceof Error ? error.message : String(error) }; }
      });
    }
    state.actions.push({ action, params });
    if (action === "getActiveProfile") return state.profileOverride !== undefined ? state.profileOverride : state.profileName;
    if (action === "notesInfo") {
      return state.notesInfoOverride !== undefined ? state.notesInfoOverride :
        (params.notes as number[]).map((id) => state.notes.get(id) ?? {});
    }
    if (action === "deleteNotes") {
      const ids = params.notes as number[];
      state.writes.push([...ids]);
      if (state.deleteMode === "throw-before") throw new Error("No reply");
      if (state.deleteMode === "noop") return null;
      for (const id of state.deleteMode === "partial" ? ids.slice(0, 1) : ids) {
        const selected = state.notes.get(id);
        if (state.deleteMode !== "keep-cards") selected?.cards.forEach((card) => state.cards.delete(card));
        state.notes.delete(id);
      }
      if (state.switchProfileOnDelete) state.profileName = "Switched profile";
      if (state.deleteMode === "throw-after") throw new Error("Reply lost after deleting");
      return null;
    }
    if (action === "findNotes" || action === "findCards") {
      const kind = action === "findNotes" ? "nid" : "cid";
      const query = String(params.query);
      assert.match(query, new RegExp(`^${kind}:\\d+(?: or ${kind}:\\d+)*$`, "u"));
      if (state.failVerification) throw new Error("read unavailable");
      if (state.verificationOverride !== undefined) return state.verificationOverride;
      return query.split(" or ").map((part) => Number(part.slice(4))).filter((id) =>
        action === "findNotes" ? state.notes.has(id) : state.cards.has(id));
    }
    throw new Error(`Unexpected Anki action: ${action}`);
  }
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Action;
    state.requests.push(request.action);
    try { return Response.json({ result: execute(request.action, request.params ?? {}), error: null }); }
    catch (error) { return Response.json({ result: null, error: error instanceof Error ? error.message : String(error) }); }
  });
  return state;
}
