import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getAnkiDeckStats } from "../anki-api/decks/deck-client.js";

const populatedStats = {
  "2": {
    deck_id: 2, name: "Populated", new_count: 3,
    learn_count: 2, review_count: 4, total_in_deck: 100,
  },
};

test("native deck statistics are returned without fallback requests", async (t) => {
  const actions = mockAnki(t, () => populatedStats);
  assert.deepEqual(await getAnkiDeckStats(["Populated"]), populatedStats);
  assert.deepEqual(actions.map(({ action }) => action), ["getDeckStats"]);
});

test("an unavailable empty deck does not hide statistics for other decks", async (t) => {
  const actions = mockAnki(t, (action, params) => {
    if (action === "deckNamesAndIds") return { Default: 1, Populated: 2 };
    if (action === "findCards") {
      assert.equal(params.query, 'deck:"Default"');
      return [];
    }
    if (params.decks?.length === 1 && params.decks[0] === "Populated") return populatedStats;
    throw new Error("Deck counts unavailable.");
  });
  const result = await getAnkiDeckStats(["Default", "Populated"]);
  assert.deepEqual(result, {
    "1": { deck_id: 1, name: "Default", new_count: 0, learn_count: 0, review_count: 0, total_in_deck: 0 },
    ...populatedStats,
  });
  assert.equal(actions.filter(({ action }) => action === "findCards").length, 1);
});

test("unavailable counts for nonempty decks remain an error", async (t) => {
  mockAnki(t, (action) => {
    if (action === "deckNamesAndIds") return { Populated: 2 };
    if (action === "findCards") return [123];
    throw new Error("Deck counts unavailable.");
  });
  await assert.rejects(getAnkiDeckStats(["Populated"]), /Deck counts unavailable/u);
});

test("unrelated Anki errors do not trigger a zero-count fallback", async (t) => {
  const actions = mockAnki(t, () => { throw new Error("Collection is busy"); });
  await assert.rejects(getAnkiDeckStats(["Default"]), /Collection is busy/u);
  assert.equal(actions.length, 1);
});

test("empty-deck checks escape literal names rather than matching wildcards", async (t) => {
  const name = 'Empty "quoted"_*';
  mockAnki(t, (action, params) => {
    if (action === "deckNamesAndIds") return { [name]: 3 };
    if (action === "findCards") {
      const query = String(params.query);
      assert.ok(query.startsWith('deck:"'));
      assert.ok(query.includes('\\"quoted\\"'));
      assert.ok(query.includes("\\_\\*"));
      return [];
    }
    throw new Error("Deck counts unavailable.");
  });
  assert.equal((await getAnkiDeckStats([name]))["3"]?.total_in_deck, 0);
});

test("fallback requests stay sequential for AnkiConnect's connection limit", async (t) => {
  let active = 0;
  let maximumActive = 0;
  mockAnki(t, async (action, params) => {
    if (action === "deckNamesAndIds") return { First: 1, Second: 2 };
    if (params.decks?.length !== 1) throw new Error("Deck counts unavailable.");
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    const name = params.decks[0];
    const id = name === "First" ? 1 : 2;
    return { [String(id)]: { deck_id: id, name, new_count: 1, learn_count: 0, review_count: 0 } };
  });
  const result = await getAnkiDeckStats(["First", "Second"]);
  assert.equal(Object.keys(result).length, 2);
  assert.equal(maximumActive, 1);
});

function mockAnki(
  t: TestContext,
  handle: (action: string, params: { decks?: string[]; query?: string }) => unknown,
) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  const actions: Array<{ action: string; params: { decks?: string[]; query?: string } }> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as (typeof actions)[number];
    actions.push(request);
    try {
      return Response.json({ result: await handle(request.action, request.params ?? {}), error: null });
    } catch (error) {
      return Response.json({ result: null, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return actions;
}
