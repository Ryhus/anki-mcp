import assert from "node:assert/strict";
import test from "node:test";
import { rescheduleAnkiCards, resetAnkiCardsToNew, setAnkiCardFlag, setAnkiCardsSuspended, startAnkiCardsRelearning } from "../anki-api/cards/card-client.js";
import { mockCardMutations, writeRequests } from "./helpers/card-mutation-fixture.js";

const operations = [
  { action: "suspend", run: () => setAnkiCardsSuspended([10], true), invalid: [null, 0, "true", [], {}] },
  { action: "unsuspend", run: () => setAnkiCardsSuspended([10], false), invalid: [0, "true", [], {}] },
  { action: "setDueDate", run: () => rescheduleAnkiCards([10], "1!"), invalid: [false, null, 1, "true", []] },
  { action: "forgetCards", run: () => resetAnkiCardsToNew([10]), invalid: [true, false, 0, []] },
  { action: "relearnCards", run: () => startAnkiCardsRelearning([10]), invalid: [true, false, 0, []] },
  { action: "setSpecificValueOfCard", run: () => setAnkiCardFlag(10, 3), invalid: [false, null, true, [], [true, true], [[false, "failed"]], [1], {}] },
];

for (const operation of operations) {
  test(`${operation.action} validates its acknowledgement at runtime without retrying`, async (t) => {
    const state = mockCardMutations(t);
    for (const acknowledgement of operation.invalid) {
      state.acknowledgements.set(operation.action, acknowledgement);
      const before = writeRequests(state).length;
      await assert.rejects(operation.run());
      assert.equal(writeRequests(state).length, before + 1);
    }
  });
}

test("suspend/unsuspend valid acknowledgement types are preserved for callers", async (t) => {
  const state = mockCardMutations(t);
  assert.equal(await setAnkiCardsSuspended([10], true), true);
  state.acknowledgements.set("suspend", false);
  assert.equal(await setAnkiCardsSuspended([10], true), false);
  assert.equal(await setAnkiCardsSuspended([10], false), null);
});
