import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { AnkiCardInfo } from "../../anki-api/cards/card-types.js";

export const TEST_TODAY = 12_345;
export const CARD_WRITES = new Set(["suspend", "unsuspend", "setSpecificValueOfCard", "setDueDate", "forgetCards", "relearnCards"]);

export function testCard(cardId = 10): AnkiCardInfo {
  return {
    cardId, note: cardId + 100, modelName: "Basic", ord: 0, deckName: "Test",
    fields: { Front: { value: "Front", order: 0 }, Back: { value: "Back", order: 1 } },
    question: "Front", answer: "Back", css: "", fieldOrder: 0,
    type: 2, queue: 2, interval: 10, factor: 2500, reps: 5, lapses: 0,
    due: TEST_TODAY + 20, left: 0, mod: 1_700_000_000, flags: 0,
  };
}

export function mockCardMutations(t: TestContext, cardIds = [10, 20, 30]) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  const state = {
    cards: new Map(cardIds.map((id) => [id, testCard(id)])),
    requests: [] as Array<{ action: string; params: Record<string, unknown> }>,
    acknowledgements: new Map<string, unknown>(),
    noop: false,
    throwBefore: false,
    throwAfter: false,
    failFlagId: -1,
    relearnMode: "relearning" as "relearning" | "interday" | "review" | "suspended",
    reads: 0,
    onRead: undefined as ((cards: unknown[], read: number) => unknown) | undefined,
    searchResult: undefined as unknown,
  };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { action, params = {} } = JSON.parse(String(init?.body)) as (typeof state.requests)[number];
    state.requests.push({ action, params });
    let result: unknown;
    if (action === "cardsInfo") {
      state.reads += 1;
      const cards = (params.cards as number[]).map((id) => state.cards.get(id) ?? {});
      result = state.onRead ? state.onRead(structuredClone(cards), state.reads) : cards;
    } else if (action === "findCards") {
      if (state.searchResult !== undefined) result = state.searchResult;
      else {
        const match = /^cid:([\d,]+) prop:due>=(\d+) prop:due<=(\d+)$/u.exec(String(params.query));
        assert.ok(match, `Unexpected verification search: ${String(params.query)}`);
        const ids = match[1]!.split(",").map(Number);
        result = ids.filter((id) => {
          const card = state.cards.get(id);
          return card && card.due >= TEST_TODAY + Number(match[2]) && card.due <= TEST_TODAY + Number(match[3]);
        });
      }
    } else {
      assert.ok(CARD_WRITES.has(action), `Unexpected action ${action}`);
      if (state.throwBefore) throw new TypeError("Simulated connection failure");
      const ids = action === "setSpecificValueOfCard" ? [params.card as number] : params.cards as number[];
      if (!state.noop) {
        for (const id of ids) {
          const card = state.cards.get(id);
          assert.ok(card);
          switch (action) {
            case "suspend": card.queue = -1; break;
            case "unsuspend": card.queue = card.type === 0 ? 0 : 2; break;
            case "setSpecificValueOfCard": card.flags = (params.newValues as number[])[0]!; break;
            case "setDueDate": {
              const day = Number(String(params.days).replace(/!$/u, "").split("-")[0]);
              card.type = 2; card.queue = 2; card.due = TEST_TODAY + day;
              break;
            }
            case "forgetCards": card.type = 0; card.queue = 0; card.interval = 0; card.factor = 0; break;
            case "relearnCards":
              card.reps += 1; card.lapses += 1;
              card.type = state.relearnMode === "review" ? 2 : 3;
              card.queue = state.relearnMode === "review" ? 2 : state.relearnMode === "suspended" ? -1 : state.relearnMode === "interday" ? 3 : 1;
              break;
          }
        }
      }
      if (state.throwAfter) throw new TypeError("Simulated lost acknowledgement");
      result = action === "suspend" || action === "setDueDate" ? true : action === "setSpecificValueOfCard" ? [true] : null;
      if (action === "setSpecificValueOfCard" && ids[0] === state.failFlagId) result = [[false, "Simulated failure"]];
      if (state.acknowledgements.has(action)) result = state.acknowledgements.get(action);
    }
    return Response.json({ result, error: null });
  });
  return state;
}

export function writeRequests(state: ReturnType<typeof mockCardMutations>) {
  return state.requests.filter(({ action }) => CARD_WRITES.has(action));
}
