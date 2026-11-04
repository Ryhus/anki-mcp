import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AnkiNoteInfo } from "../anki-api/notes/note-types.js";
import { createServer } from "../mcp/create-server.js";
import { deleteDeckAndCards } from "../mcp/tools/decks/delete-deck-and-cards.js";
import { deckDeletionInputSchema, deckDeletionOutputSchema, DECK_DELETION_LIMITS } from "../mcp/tools/decks/deck-deletion-schemas.js";

test("deck deletion defaults to preview and validates explicit reviewed application", () => {
  assert.deepEqual(deckDeletionInputSchema.parse({ name: "Target" }), { name: "Target", dryRun: true, confirmDeletion: false });
  for (const input of [{ name: "" }, { name: 1 }, { name: "Target", dryRun: false }, {
    name: "Target", dryRun: false, confirmDeletion: true,
  }, { name: "Target", dryRun: false, expectedImpactHash: "a".repeat(64) }, {
    name: "Target", dryRun: false, confirmDeletion: true, expectedImpactHash: "invalid",
  }]) assert.equal(deckDeletionInputSchema.safeParse(input).success, false);
});

test("preview includes descendants and distinguishes deleted Notes from surviving siblings", async (t) => {
  const anki = mockAnki(t);
  const result = await preview();
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.impactComplete, true);
  assert.match(result.impactHash ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.impact.sampleDecks, [{ id: 10, name: "Target" }, { id: 11, name: "Target::Child" }]);
  assert.equal(result.impact.deckCount, 2);
  assert.equal(result.impact.cardCount, 2);
  assert.equal(result.impact.affectedNoteCount, 2);
  assert.equal(result.impact.deletedNoteCount, 1);
  assert.equal(result.impact.survivingNoteCount, 1);
  assert.equal(result.impact.preservedCardCount, 1);
  assert.deepEqual(result.impact.sampleNotes, [
    { noteId: 1, modelName: "Basic", willBeDeleted: true, deletedCardCount: 1, preservedCardCount: 0 },
    { noteId: 2, modelName: "Basic", willBeDeleted: false, deletedCardCount: 1, preservedCardCount: 1 },
  ]);
  assert.deepEqual(result.deletedDecks, []);
  assert.equal(result.deletedDeck, null);
  assert.equal(result.deletedCards, false);
  assert.equal(anki.writes.length, 0);
  assert.equal(anki.cards.size, 4);
  assert.equal(anki.decks.size, 5);
});

test("reviewed deletion removes the complete subtree, not sibling Cards or similar names", async (t) => {
  const anki = mockAnki(t);
  const result = await apply(await preview());
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.deletedDecks.map(({ id }) => id), [10, 11]);
  assert.equal(result.deletedDeck?.id, 10);
  assert.equal(result.deletedCards, true);
  assert.deepEqual([...anki.cards.keys()], [201, 300]);
  assert.deepEqual([...anki.notes.keys()], [2, 3]);
  assert.deepEqual(anki.notes.get(2)?.cards, [201]);
  assert.equal(anki.decks.has("Targetish"), true);
  assert.deepEqual(anki.writes, [["Target"]]);
});

test("empty normal decks have complete zero impact and no unqualified verification searches", async (t) => {
  const anki = mockAnki(t);
  anki.decks.set("Empty", 40);
  const inspected = await preview({ name: "Empty" });
  assert.equal(inspected.impact.cardCount, 0);
  assert.equal(inspected.impact.deletedNoteCount, 0);
  assert.equal(inspected.impactComplete, true);
  const result = await apply(inspected, "Empty");
  assert.equal(result.verified, true);
  assert.equal(anki.cards.size, 4);
  assert.ok(anki.actions.filter(({ action }) => action === "findNotes").length === 0);
});

for (const name of ["current", "filtered", '*quoted_"\\ deck']) {
  test(`numeric deck queries avoid interpreting the literal name ${JSON.stringify(name)}`, async (t) => {
    const anki = mockAnki(t);
    anki.decks.delete("Target"); anki.decks.delete("Target::Child");
    anki.decks.set(name, 10); anki.decks.set(`${name}::Child`, 11);
    const result = await apply(await preview({ name }), name);
    assert.equal(result.verified, true);
    for (const { action, params } of anki.actions) {
      if (action === "findCards" || action === "findNotes") assert.match(String(params.query), /^(?:did|cid|nid):\d+(?:,\d+)*$/u);
    }
  });
}

for (const [label, change] of [
  ["new child deck", (a: MockAnki) => { a.decks.set("Target::New", 45); }],
  ["same-name root replacement", (a: MockAnki) => { a.decks.set("Target", 99); }],
  ["child rename", (a: MockAnki) => { a.decks.delete("Target::Child"); a.decks.set("Target::Renamed", 11); }],
  ["Note HTML edit", (a: MockAnki) => { a.notes.get(1)!.fields.Front!.value += "<br>Changed"; }],
  ["shared Note tag edit", (a: MockAnki) => { a.notes.get(2)!.tags.push("edited"); }],
  ["Card moved between descendants", (a: MockAnki) => { a.cards.get(100)!.deckId = 11; }],
  ["sibling removed outside the tree", (a: MockAnki) => { a.cards.delete(201); a.notes.get(2)!.cards = [200]; }],
] as const) {
  test(`${label} invalidates the reviewed deck hash`, async (t) => {
    const anki = mockAnki(t);
    const reviewed = await preview();
    change(anki);
    const result = await apply(reviewed);
    assertBlocked(result, anki);
    assert.notEqual(result.impactHash, reviewed.impactHash);
  });
}

test("same-count Card replacement beyond samples still invalidates the hash", async (t) => {
  const anki = mockAnki(t);
  const ids = Array.from({ length: 25 }, (_, index) => 100 + index);
  ids.forEach((id) => anki.cards.set(id, { noteId: 1, deckId: 10 }));
  anki.notes.get(1)!.cards = ids;
  const reviewed = await preview();
  anki.cards.delete(124); anki.cards.set(199, { noteId: 1, deckId: 10 });
  anki.notes.get(1)!.cards[24] = 199;
  const result = await apply(reviewed);
  assert.deepEqual(result.impact, reviewed.impact);
  assertBlocked(result, anki);
});

test("a renamed empty descendant beyond samples still invalidates the hash", async (t) => {
  const anki = mockAnki(t);
  for (let i = 0; i < 21; i++) anki.decks.set(`Target::Extra ${i}`, 40 + i);
  const reviewed = await preview();
  anki.decks.delete("Target::Extra 20"); anki.decks.set("Target::Hidden rename", 60);
  const result = await apply(reviewed);
  assert.deepEqual(result.impact, reviewed.impact);
  assertBlocked(result, anki);
});

test("unrelated edits and map ordering do not invalidate the selected subtree", async (t) => {
  const anki = mockAnki(t);
  const reviewed = await preview();
  anki.notes.get(3)!.fields.Front!.value = "Unrelated edit";
  anki.decks.set("Unrelated", 80);
  anki.decks = new Map([...anki.decks].reverse());
  const result = await apply(reviewed);
  assert.equal(result.verified, true);
  assert.equal(anki.notes.get(3)!.fields.Front!.value, "Unrelated edit");
});

test("missing decks and Default ID 1 are blocked, including renamed/nested Default", async (t) => {
  const anki = mockAnki(t);
  const missing = await preview({ name: "Missing" });
  assert.equal(missing.exists, false);
  assert.equal(missing.impactHash, null);
  assertBlocked(missing, anki);
  const builtIn = await preview({ name: "Default" });
  assertBlocked(builtIn, anki);
  assert.match(builtIn.blockers.join(" "), /ID 1/u);
  anki.decks.delete("Default"); anki.decks.set("Target::Renamed Default", 1);
  assertBlocked(await preview(), anki);
});

test("filtered, unknown, and unreadable deck kinds cannot yield an apply hash", async (t) => {
  const anki = mockAnki(t);
  for (const config of [{ dyn: true }, { dyn: 1 }, {}, false]) {
    anki.configs.set("Target::Child", config);
    const result = await preview();
    assertBlocked(result, anki);
    assert.equal(result.impactHash, null);
    assert.match(result.blockers.join(" "), /filtered|kind/u);
  }
  anki.configError = true;
  assertBlocked(await preview(), anki);
});

test("Cards borrowed into a filtered deck outside the tree block destructive review", async (t) => {
  const anki = mockAnki(t);
  anki.decks.set("Filtered", 30);
  anki.cards.set(100, { noteId: 1, deckId: 30, originalDeckId: 10 });
  const result = await preview();
  assert.equal(result.impact.cardCount, 2);
  assert.equal(result.impactHash, null);
  assert.match(result.blockers.join(" "), /outside|filtered/u);
  assertBlocked(result, anki);
});

test("missing Note data, placement data, or owning Notes fail closed", async (t) => {
  const anki = mockAnki(t);
  anki.omitPlacements = true;
  assertBlocked(await preview(), anki);
  anki.omitPlacements = false;
  anki.notesOverride = [{}];
  const missing = await preview();
  assert.equal(missing.impact.deletedNoteCount, null);
  assert.equal(missing.impactHash, null);
  assertBlocked(missing, anki);
  anki.notesOverride = undefined;
  anki.noteIdsOverride = [];
  assertBlocked(await preview(), anki);
});

test("a missing outside sibling is detected before deleting the shared Note's last real Card", async (t) => {
  const anki = mockAnki(t);
  anki.cards.delete(201); // stale notesInfo still claims this outside sibling exists
  const result = await preview();
  assert.match(result.blockers.join(" "), /siblings disappeared/u);
  assertBlocked(result, anki);
});

test("profile changes invalidate review even when object IDs still match", async (t) => {
  const anki = mockAnki(t);
  const reviewed = await preview();
  anki.profile = "Other profile";
  assertBlocked(await apply(reviewed), anki);
});

test("the exported handler also refuses unconfirmed deletion", async (t) => {
  const anki = mockAnki(t);
  const reviewed = await preview();
  const result = deckDeletionOutputSchema.parse((await deleteDeckAndCards({
    name: "Target", dryRun: false, expectedImpactHash: reviewed.impactHash!, confirmDeletion: false,
  })).structuredContent);
  assertBlocked(result, anki);
});

test("the total referenced-Card limit includes outside siblings", async (t) => {
  const anki = mockAnki(t);
  anki.notes.get(1)!.cards = [100, ...Array.from({ length: DECK_DELETION_LIMITS.referencedCards }, (_, index) => 10_000 + index)];
  const result = await preview();
  assert.equal(result.impactComplete, false);
  assert.equal(result.impactHash, null);
  assert.match(result.blockers.join(" "), /review limit/u);
  assertBlocked(result, anki);
});

test("verification chunks large scopes and preserves outside siblings", async (t) => {
  const anki = mockAnki(t);
  const ids = Array.from({ length: 501 }, (_, index) => index + 1_000);
  anki.cards.delete(100);
  ids.forEach((id) => anki.cards.set(id, { deckId: 10, noteId: 1 }));
  anki.notes.get(1)!.cards = ids;
  const result = await apply(await preview());
  assert.equal(result.verified, true);
  assert.ok(anki.cards.has(201));
  const searches = anki.actions.filter(({ action, params }) => action === "findCards" && String(params.query).startsWith("cid:"));
  assert.ok(searches.length >= 3);
  searches.forEach(({ params }) => assert.ok(String(params.query).split(":")[1]!.split(",").length <= 250));
});

test("a hierarchy change between read phases cannot yield a complete impact", async (t) => {
  const anki = mockAnki(t);
  anki.onAction = (action) => {
    if (action === "deckNamesAndIds" && anki.actions.filter((a) => a.action === action).length === 2) anki.decks.set("Target::Added during review", 55);
  };
  const result = await preview();
  assert.equal(result.impactHash, null);
  assertBlocked(result, anki);
});

test("a Card entering a previously empty deck between read phases blocks zero-impact deletion", async (t) => {
  const anki = mockAnki(t);
  anki.decks.set("Empty", 40);
  let searches = 0;
  anki.onAction = (action) => {
    const latest = anki.actions.at(-1)!;
    if (action === "findCards" && latest.params.query === "did:40" && ++searches === 2) anki.cards.get(100)!.deckId = 40;
  };
  const result = await preview({ name: "Empty" });
  assert.equal(result.impactHash, null);
  assert.match(result.blockers.join(" "), /target Card set changed/u);
  assertBlocked(result, anki);
});

for (const [kind, count] of [["decks", DECK_DELETION_LIMITS.decks + 1], ["cards", DECK_DELETION_LIMITS.cards + 1], ["notes", DECK_DELETION_LIMITS.notes + 1]] as const) {
  test(`exceeding the ${kind} full-review limit blocks deletion`, async (t) => {
    const anki = mockAnki(t);
    if (kind === "decks") for (let i = 0; i < count; i++) anki.decks.set(`Target::Extra ${i}`, 100 + i);
    else {
      anki.cards.clear(); anki.notes.clear();
      for (let i = 0; i < count; i++) {
        const cardId = 1_000 + i;
        anki.cards.set(cardId, { noteId: i + 1, deckId: 10 });
        anki.notes.set(i + 1, note(i + 1, [cardId]));
      }
    }
    const result = await preview();
    assert.equal(result.impactHash, null);
    assert.match(result.blockers.join(" "), /review limit/u);
    assertBlocked(result, anki);
  });
}

for (const mode of ["noop", "keep-decks", "keep-cards", "keep-orphan", "drop-sibling", "drop-shared-note"] as const) {
  test(`${mode} backend behavior cannot report verified deck deletion`, async (t) => {
    const anki = mockAnki(t);
    const reviewed = await preview(); anki.deleteMode = mode;
    await assert.rejects(apply(reviewed), /acknowledged.*verification failed/u);
    assert.equal(anki.writes.length, 1);
  });
}

for (const mode of ["throw-before", "throw-after"] as const) {
  test(`${mode} deletion failure reports uncertain state without retries`, async (t) => {
    const anki = mockAnki(t);
    const reviewed = await preview(); anki.deleteMode = mode;
    await assert.rejects(apply(reviewed), /Could not confirm deletion.*may already be deleted.*No automatic retry/u);
    assert.equal(anki.writes.length, 1);
  });
}

test("profile switches and read failures after acknowledgment are not success", async (t) => {
  const anki = mockAnki(t);
  const reviewed = await preview(); anki.switchOnDelete = true;
  await assert.rejects(apply(reviewed), /verification failed.*profile changed/u);
});

test("verification search errors do not trigger retries", async (t) => {
  const anki = mockAnki(t);
  const reviewed = await preview(); anki.failVerification = true;
  await assert.rejects(apply(reviewed), /verification failed.*read unavailable/u);
  assert.equal(anki.writes.length, 1);
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} enforces reviewed deck deletion and sibling preservation`, async (t) => {
    const anki = mockAnki(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "deck-deletion-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const call = async (args: Record<string, unknown>) => deckDeletionOutputSchema.parse(
      (await client.callTool({ name: "delete-deck-and-cards", arguments: args })).structuredContent,
    );
    const reviewed = await call({ name: "Target" });
    assert.equal(reviewed.dryRun, true);
    const reads = anki.requests.length;
    assert.equal((await client.callTool({ name: "delete-deck-and-cards", arguments: { name: "Target", dryRun: false, confirmDeletion: true } })).isError, true);
    assert.equal(anki.requests.length, reads);
    anki.notes.get(1)!.tags.push("changed");
    assertBlocked(await call({ name: "Target", dryRun: false, expectedImpactHash: reviewed.impactHash, confirmDeletion: true }), anki);
    const fresh = await call({ name: "Target" });
    const applied = await call({ name: "Target", dryRun: false, expectedImpactHash: fresh.impactHash, confirmDeletion: true });
    assert.equal(applied.verified, true);
    assert.ok(anki.cards.has(201));
    assert.ok(anki.notes.has(2));
    assert.equal(anki.writes.length, 1);
  });
}

async function preview(input: Record<string, unknown> = {}) {
  return deckDeletionOutputSchema.parse((await deleteDeckAndCards(
    deckDeletionInputSchema.parse({ name: "Target", ...input }),
  )).structuredContent);
}
async function apply(reviewed: Awaited<ReturnType<typeof preview>>, name = "Target") {
  assert.ok(reviewed.impactHash);
  return preview({ name, dryRun: false, expectedImpactHash: reviewed.impactHash, confirmDeletion: true });
}
function assertBlocked(result: Awaited<ReturnType<typeof preview>>, anki: { writes: string[][] }) {
  assert.equal(result.applied, false); assert.equal(result.verified, false);
  assert.equal(result.deletedCards, false); assert.deepEqual(result.deletedDecks, []);
  assert.ok(result.blockers.length); assert.equal(anki.writes.length, 0);
}
function note(noteId: number, cards: number[]): AnkiNoteInfo {
  return { noteId, cards, modelName: "Basic", tags: [], mod: 1_700_000_000, fields: { Front: { value: `Note ${noteId}`, order: 0 } } };
}

type MockAnki = ReturnType<typeof mockAnki>;
function mockAnki(t: TestContext) {
  const oldUrl = process.env.ANKI_URL; process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => { if (oldUrl === undefined) delete process.env.ANKI_URL; else process.env.ANKI_URL = oldUrl; });
  type Card = { noteId: number; deckId: number; originalDeckId?: number };
  type DeleteMode = "normal" | "noop" | "keep-decks" | "keep-cards" | "keep-orphan" | "drop-sibling" | "drop-shared-note" | "throw-before" | "throw-after";
  interface Action { action: string; params?: Record<string, unknown> }
  const state = {
    profile: "Default", decks: new Map([["Default", 1], ["Target", 10], ["Target::Child", 11], ["Targetish", 12], ["Other", 20]]),
    cards: new Map<number, Card>([[100, { noteId: 1, deckId: 10 }], [200, { noteId: 2, deckId: 11 }], [201, { noteId: 2, deckId: 20 }], [300, { noteId: 3, deckId: 20 }]]),
    notes: new Map([[1, note(1, [100])], [2, note(2, [200, 201])], [3, note(3, [300])]]),
    configs: new Map<string, unknown>(), configError: false, omitPlacements: false,
    notesOverride: undefined as unknown, noteIdsOverride: undefined as unknown,
    onAction: undefined as ((action: string) => void) | undefined,
    actions: [] as Array<{ action: string; params: Record<string, unknown> }>, requests: [] as string[], writes: [] as string[][],
    deleteMode: "normal" as DeleteMode, switchOnDelete: false, failVerification: false,
  };
  const nameFor = (id: number) => [...state.decks].find(([, deckId]) => deckId === id)?.[0] ?? "Missing";
  function execute(action: string, params: Record<string, unknown>): unknown {
    if (action === "multi") return (params.actions as Action[]).map((nested) => {
      try { return { result: execute(nested.action, nested.params ?? {}), error: null }; }
      catch (error) { return { result: null, error: error instanceof Error ? error.message : String(error) }; }
    });
    state.actions.push({ action, params }); state.onAction?.(action);
    if (action === "getActiveProfile") return state.profile;
    if (action === "deckNamesAndIds") return Object.fromEntries(state.decks);
    if (action === "getDeckConfig") {
      if (state.configError) throw new Error("Configuration unavailable");
      return state.configs.has(String(params.deck)) ? state.configs.get(String(params.deck)) : { dyn: false };
    }
    if (action === "findCards" || action === "findNotes") {
      const query = String(params.query);
      assert.match(query, /^(?:did|cid|nid):\d+(?:,\d+)*$/u);
      if (state.failVerification && state.writes.length) throw new Error("read unavailable");
      const [kind, list] = query.split(":"); const ids = list!.split(",").map(Number);
      if (kind === "did") return [...state.cards].filter(([, card]) => ids.includes(card.deckId) || ids.includes(card.originalDeckId ?? -1)).map(([id]) => id);
      return ids.filter((id) => kind === "nid" ? state.notes.has(id) : state.cards.has(id));
    }
    if (action === "getDecks") {
      const result: Record<string, number[]> = {};
      (params.cards as number[]).forEach((id, index) => {
        if (state.omitPlacements && index === 0) return;
        const card = state.cards.get(id); if (card) (result[nameFor(card.deckId)] ??= []).push(id);
      });
      return result;
    }
    if (action === "cardsToNotes") return state.noteIdsOverride !== undefined ? state.noteIdsOverride : [...new Set((params.cards as number[]).map((id) => state.cards.get(id)?.noteId))];
    if (action === "notesInfo") return state.notesOverride !== undefined ? state.notesOverride : (params.notes as number[]).map((id) => state.notes.get(id) ?? {});
    if (action === "deleteDecks") {
      const names = params.decks as string[]; state.writes.push(names);
      assert.equal(params.cardsToo, true);
      if (state.deleteMode === "throw-before") throw new Error("reply unavailable");
      if (state.deleteMode === "noop") return null;
      const removedDecks = [...state.decks].filter(([name]) => names.some((root) => name.toLowerCase() === root.toLowerCase() || name.toLowerCase().startsWith(`${root.toLowerCase()}::`)));
      const ids = new Set(removedDecks.map(([, id]) => id));
      if (state.deleteMode !== "keep-cards") for (const [id, card] of state.cards) if (ids.has(card.deckId) || ids.has(card.originalDeckId ?? -1)) state.cards.delete(id);
      if (state.deleteMode === "drop-sibling" || state.deleteMode === "drop-shared-note") state.cards.delete(201);
      for (const [id, n] of state.notes) {
        n.cards = n.cards.filter((cid) => state.cards.has(cid));
        if (!n.cards.length && state.deleteMode !== "keep-orphan") state.notes.delete(id);
      }
      if (state.deleteMode === "drop-shared-note") state.notes.delete(2);
      if (state.deleteMode !== "keep-decks") removedDecks.forEach(([name]) => state.decks.delete(name));
      if (state.switchOnDelete) state.profile = "Other profile";
      if (state.deleteMode === "throw-after") throw new Error("reply lost after deletion");
      return null;
    }
    throw new Error(`Unexpected action: ${action}`);
  }
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Action; state.requests.push(request.action);
    try { return Response.json({ result: execute(request.action, request.params ?? {}), error: null }); }
    catch (error) { return Response.json({ result: null, error: error instanceof Error ? error.message : String(error) }); }
  });
  return state;
}
