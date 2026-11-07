import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { setCardSuspension, setCardSuspensionConfig } from "../mcp/tools/cards/set-card-suspension.js";
import { setCardFlag, setCardFlagConfig } from "../mcp/tools/cards/set-card-flag.js";
import { rescheduleCards, rescheduleCardsConfig } from "../mcp/tools/cards/reschedule-cards.js";
import { resetCardsToNew } from "../mcp/tools/cards/reset-cards-to-new.js";
import { startCardRelearning } from "../mcp/tools/cards/start-card-relearning.js";
import { toCardFlag } from "../mcp/tools/cards/card-normalizers.js";
import { TEST_TODAY, mockCardMutations, writeRequests } from "./helpers/card-mutation-fixture.js";

const mutations: Array<{ name: string; action: string; run: (cardIds: number[]) => Promise<CallToolResult> }> = [
  { name: "suspend", action: "suspend", run: (cardIds) => setCardSuspension({ cardIds, suspended: true }) },
  { name: "flag", action: "setSpecificValueOfCard", run: (cardIds) => setCardFlag({ cardIds, flag: "green" }) },
  { name: "reschedule", action: "setDueDate", run: (cardIds) => rescheduleCards({ cardIds, due: "1!" }) },
  { name: "reset", action: "forgetCards", run: (cardIds) => resetCardsToNew({ cardIds }) },
  { name: "relearn", action: "relearnCards", run: (cardIds) => startCardRelearning({ cardIds }) },
];

for (const mutation of mutations) {
  test(`${mutation.name} writes once per plan, deduplicates IDs, and reads back state`, async (t) => {
    const state = mockCardMutations(t);
    const response = await mutation.run([10, 10, 20]);
    assert.notEqual(response.isError, true);
    assert.equal(writeRequests(state).length, mutation.name === "flag" ? 2 : 1);
    assert.deepEqual(state.requests.filter(({ action }) => action === "cardsInfo").map(({ params }) => params.cards), [[10, 20], [10, 20]]);
    if (mutation.name === "reschedule") {
      assert.deepEqual(state.requests.at(-1), { action: "findCards", params: { query: "cid:10,20 prop:due>=1 prop:due<=1" } });
    }
  });

  test(`${mutation.name} blocks a missing Card before all writes`, async (t) => {
    const state = mockCardMutations(t);
    await assert.rejects(mutation.run([10, 999]), /No Cards were changed.*No partial selection/u);
    assert.equal(writeRequests(state).length, 0);
  });

  test(`${mutation.name} refuses success after a noop acknowledgement`, async (t) => {
    const state = mockCardMutations(t);
    state.noop = true;
    await assert.rejects(mutation.run([10]), /acknowledged.*verification failed.*No automatic retry/u);
    assert.equal(writeRequests(state).length, 1);
  });

  for (const phase of ["before", "after"] as const) {
    test(`${mutation.name} stops on a ${phase}-write failure without retry or false success`, async (t) => {
      const state = mockCardMutations(t);
      state.throwBefore = phase === "before";
      state.throwAfter = phase === "after";
      await assert.rejects(mutation.run([10, 20, 30]), /Could not confirm.*Some changes may already.*No automatic retry or rollback/u);
      assert.equal(writeRequests(state).length, 1);
      assert.equal(state.reads, 1, "a failed write is not followed by an implicit recovery/retry");
    });
  }

  test(`${mutation.name} reports acknowledged writes when readback fails`, async (t) => {
    const state = mockCardMutations(t);
    state.onRead = (cards, read) => {
      if (read === 2) throw new Error("Simulated verification failure");
      return cards;
    };
    await assert.rejects(mutation.run([10]), /acknowledged.*verification failed.*Changes may already be applied/u);
    assert.equal(writeRequests(state).length, 1);
  });

  test(`${mutation.name} rejects a Card that disappears during verification`, async (t) => {
    const state = mockCardMutations(t);
    state.onRead = (cards, read) => read === 2 ? [{}] : cards;
    await assert.rejects(mutation.run([10]), /verification failed.*Cards missing or incomplete/u);
    assert.equal(writeRequests(state).length, 1);
  });

  test(`${mutation.name} cannot verify a replaced Card with a different owning Note`, async (t) => {
    const state = mockCardMutations(t);
    state.onRead = (cards, read) => read === 2 ? [{ ...state.cards.get(10), note: 999 }] : cards;
    await assert.rejects(mutation.run([10]), /verification failed.*Unexpected Card state/u);
  });
}

test("legacy null unsuspend succeeds only after actual suspension-state readback", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(10)!.queue = -1;
  const response = await setCardSuspension({ cardIds: [10], suspended: false });
  assert.deepEqual(response.structuredContent, { suspended: false, updatedCardIds: [10], unchangedCardIds: [], missingCardIds: [] });
  assert.deepEqual(state.requests.map(({ action }) => action), ["cardsInfo", "unsuspend", "cardsInfo"]);
});

test("null unsuspend acknowledgement cannot hide an unchanged suspended Card", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(10)!.queue = -1;
  state.noop = true;
  await assert.rejects(setCardSuspension({ cardIds: [10], suspended: false }), /verification failed/u);
});

test("false suspension acknowledgement is acceptable only when readback proves the desired state", async (t) => {
  const state = mockCardMutations(t);
  state.acknowledgements.set("suspend", false);
  assert.notEqual((await setCardSuspension({ cardIds: [10], suspended: true })).isError, true);
  state.noop = true;
  await assert.rejects(setCardSuspension({ cardIds: [20], suspended: true }), /verification failed/u);
});

test("suspension and flag noops skip writes and extra reads", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(10)!.queue = -1;
  state.cards.get(10)!.flags = 3;
  assert.deepEqual(setCardSuspensionConfig.outputSchema.parse((await setCardSuspension({ cardIds: [10], suspended: true })).structuredContent).unchangedCardIds, [10]);
  assert.deepEqual(setCardFlagConfig.outputSchema.parse((await setCardFlag({ cardIds: [10], flag: "green" })).structuredContent).unchangedCardIds, [10]);
  assert.equal(writeRequests(state).length, 0);
  assert.equal(state.reads, 2);
});

test("unchanged Cards in a mixed batch are also checked after a write", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(20)!.flags = 3;
  state.onRead = (cards, read) => read === 2 ? cards.map((card) => ({ ...card as object, flags: 0 })) : cards;
  await assert.rejects(setCardFlag({ cardIds: [10, 20], flag: "green" }), /verification failed/u);
  assert.deepEqual(writeRequests(state).map(({ params }) => params.card), [10]);
});

test("a flag write failure stops later Cards and reports earlier/unsent IDs", async (t) => {
  const state = mockCardMutations(t);
  state.failFlagId = 20;
  await assert.rejects(setCardFlag({ cardIds: [10, 20, 30], flag: "green" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Card IDs: 20/u);
    assert.match(error.message, /Earlier writes acknowledged but not verified: 10/u);
    assert.match(error.message, /Not attempted: 30/u);
    return true;
  });
  assert.deepEqual(writeRequests(state).map(({ params }) => params.card), [10, 20]);
  assert.equal(state.cards.get(30)!.flags, 0);
});

test("missing or invalid current flag values block writes", async (t) => {
  const state = mockCardMutations(t);
  delete state.cards.get(10)!.flags;
  await assert.rejects(setCardFlag({ cardIds: [10], flag: "green" }), /No Cards were changed.*flags are missing/u);
  assert.equal(writeRequests(state).length, 0);
});

test("user-visible flags use only the low three bits", () => {
  assert.equal(toCardFlag(128 | 3), "green");
  assert.equal(toCardFlag(7), "purple");
  for (const value of [undefined, NaN, -1, 1.5, 256]) assert.equal(toCardFlag(value), "unknown");
});

test("due range verification detects a wrong date even if Card type is Review", async (t) => {
  const state = mockCardMutations(t);
  state.onRead = (cards, read) => {
    if (read === 2) state.cards.get(10)!.due = TEST_TODAY + 20;
    return cards;
  };
  await assert.rejects(rescheduleCards({ cardIds: [10], due: "1!" }), /verification failed.*native search/u);
  assert.equal(writeRequests(state).length, 1);
});

test("rescheduling must restore an active Review queue, not leave the Card suspended", async (t) => {
  const state = mockCardMutations(t);
  state.onRead = (cards, read) => read === 2 ? [{ ...state.cards.get(10), queue: -1 }] : cards;
  await assert.rejects(rescheduleCards({ cardIds: [10], due: "1!" }), /verification failed/u);
});

for (const value of [null, {}, [], [10, 10], [10, 999], ["10", "20"]]) {
  test(`malformed/incomplete due search ${JSON.stringify(value)} cannot verify rescheduling`, async (t) => {
    const state = mockCardMutations(t);
    state.searchResult = value;
    await assert.rejects(rescheduleCards({ cardIds: [10, 20], due: "3-7" }), /verification failed.*native search/u);
    assert.equal(writeRequests(state).length, 1);
  });
}

test("due-date syntax validates bounded offsets before contacting Anki", () => {
  for (const due of ["0", "1!", "3-7", "03-007!", " 7 "]) {
    assert.equal(rescheduleCardsConfig.inputSchema.safeParse({ cardIds: [10], due }).success, true);
  }
  for (const due of ["", "-1", "7-3", "1.5", "1 or cid:999", "2147483648", "9".repeat(40)]) {
    assert.equal(rescheduleCardsConfig.inputSchema.safeParse({ cardIds: [10], due }).success, false);
  }
});

test("range dates are verified without predicting a random day or requiring an SM-2 interval", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(10)!.interval = 0; // FSRS can leave the interval at zero.
  await rescheduleCards({ cardIds: [10], due: "03-007!" });
  assert.equal(state.requests.at(-1)?.params.query, "cid:10 prop:due>=3 prop:due<=7");
});

test("reset checks New state, not erased history or counters", async (t) => {
  const state = mockCardMutations(t);
  await resetCardsToNew({ cardIds: [10] });
  assert.equal(state.cards.get(10)!.reps, 5);
  assert.equal(state.cards.get(10)!.factor, 0);
});

test("native reset may retain an inactive remaining-steps field on a New Card", async (t) => {
  const state = mockCardMutations(t);
  state.cards.get(10)!.left = 1001;
  await resetCardsToNew({ cardIds: [10] });
  assert.equal(state.cards.get(10)!.left, 1001);
});

test("a reset that does not reset the ease factor cannot be reported as verified", async (t) => {
  const state = mockCardMutations(t);
  state.onRead = (cards, read) => read === 2 ? [{ ...state.cards.get(10), factor: 2500 }] : cards;
  await assert.rejects(resetCardsToNew({ cardIds: [10] }), /verification failed/u);
});

for (const mode of ["relearning", "interday", "review", "suspended"] as const) {
  test(`relearning reports the verified ${mode} outcome`, async (t) => {
    const state = mockCardMutations(t);
    state.relearnMode = mode;
    const response = await startCardRelearning({ cardIds: [10] });
    assert.deepEqual(response.structuredContent, {
      relearningCardIds: mode === "relearning" || mode === "interday" ? [10] : [],
      reviewCardIds: mode === "review" ? [10] : [],
      suspendedCardIds: mode === "suspended" ? [10] : [], missingCardIds: [],
    });
  });
}

for (const [type, queue] of [[0, 0], [1, 1], [3, 1], [2, -1], [2, -2], [2, 4]]) {
  test(`non-active-Review Card ${type}/${queue} blocks the complete relearning batch`, async (t) => {
    const state = mockCardMutations(t);
    Object.assign(state.cards.get(20)!, { type, queue });
    await assert.rejects(startCardRelearning({ cardIds: [10, 20] }), /No Cards were changed.*active Review/u);
    assert.equal(writeRequests(state).length, 0);
  });
}

for (const value of [null, {}, [{ cardId: 10 }]]) {
  test(`invalid initial cardsInfo ${JSON.stringify(value)} blocks all writes`, async (t) => {
    const state = mockCardMutations(t);
    state.onRead = () => value;
    await assert.rejects(resetCardsToNew({ cardIds: [10] }));
    assert.equal(writeRequests(state).length, 0);
  });
}

for (const kind of ["duplicate", "unexpected", "null", "missing-due", "missing-left"] as const) {
  test(`invalid verification Cards (${kind}) do not report success`, async (t) => {
    const state = mockCardMutations(t);
    state.onRead = (cards, read) => {
      if (read === 1) return cards;
      const card = structuredClone(state.cards.get(10)!);
      switch (kind) {
        case "duplicate": return [card, card];
        case "unexpected": return [{ ...card, cardId: 999 }];
        case "null": return [null];
        case "missing-due": return [{ ...card, due: undefined }];
        case "missing-left": return [{ ...card, left: undefined }];
      }
    };
    await assert.rejects(resetCardsToNew({ cardIds: [10] }), /verification failed/u);
    assert.equal(writeRequests(state).length, 1);
  });
}
