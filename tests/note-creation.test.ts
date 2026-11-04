import assert from "node:assert/strict";
import test from "node:test";
import { createNotes } from "../mcp/tools/notes/create-notes.js";
import { noteCreationInputSchema, noteCreationOutputSchema } from "../mcp/tools/notes/note-creation-schemas.js";
import { interpretNoteCreationReply } from "../mcp/tools/notes/note-creation-results.js";
import { creationInput, mockNoteCreation } from "./helpers/note-creation-fixture.js";

test("creation input retains existing defaults and a 50-Note limit", () => {
  const input = creationInput(50);
  assert.equal(input.notes[0]!.options.allowDuplicate, false);
  assert.deepEqual(input.notes[0]!.mediaReferences, []);
  assert.equal(noteCreationInputSchema.safeParse({ notes: [] }).success, false);
  assert.equal(noteCreationInputSchema.safeParse({ notes: [...input.notes, input.notes[0]] }).success, false);
});

test("the exported handler also rejects an empty or oversized batch before contacting Anki", async (t) => {
  const state = mockNoteCreation(t);
  for (const notes of [[], Array.from({ length: 51 }, () => creationInput(1).notes[0]!)]) {
    const response = await createNotes({ notes });
    const result = noteCreationOutputSchema.parse(response.structuredContent);
    assert.equal(response.isError, true);
    assert.equal(result.outcome, "not-attempted");
    assert.equal(result.createdNoteCount, 0);
  }
  assert.equal(state.requests.length, 0);
});

test("successful creation retains the original counts, input indexes, and generated Card IDs", async (t) => {
  const state = mockNoteCreation(t);
  const response = await createNotes(creationInput());
  const result = noteCreationOutputSchema.parse(response.structuredContent);
  assert.notEqual(response.isError, true);
  assert.equal(result.outcome, "complete");
  assert.equal(result.createdNoteCount, 3);
  assert.deepEqual(result.createdNotes, [100, 101, 102].map((noteId, inputIndex) => ({ inputIndex, noteId, cardIds: [noteId * 10], verified: true })));
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["created", "created", "created"]);
  assert.deepEqual(result.reportedNoteIds, [100, 101, 102]);
  assert.deepEqual(result.warnings, []);
  assert.equal(state.writes, 1);
  assert.equal(state.readbacks, 1);
  assert.deepEqual(state.createdInputs.map(({ fields }) => fields.Back), ["<b>Back</b>", "<b>Back</b>", "<b>Back</b>"]);
  const json = response.content.find((item) => item.type === "text" && item.text.startsWith("{"));
  assert.ok(json?.type === "text");
  assert.deepEqual(JSON.parse(json.text), result, "legacy text-only clients also receive all IDs and statuses");
});

test("a rejected draft blocks the entire batch before the first creation request", async (t) => {
  const state = mockNoteCreation(t);
  state.rejectIndexes.add(1);
  const response = await createNotes(creationInput());
  const result = noteCreationOutputSchema.parse(response.structuredContent);
  assert.equal(result.outcome, "not-attempted");
  assert.equal(result.createdNoteCount, 0);
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["not-attempted", "not-attempted", "not-attempted"]);
  assert.equal(result.validations[1]!.canCreate, false);
  assert.equal(state.writes, 0);
  assert.equal(state.readbacks, 0);
});

test("preparation errors have a known zero creation count, not an unknown outcome", async (t) => {
  const state = mockNoteCreation(t);
  state.failPreparation = true;
  const response = await createNotes(creationInput());
  const result = noteCreationOutputSchema.parse(response.structuredContent);
  assert.equal(response.isError, true);
  assert.equal(result.outcome, "not-attempted");
  assert.equal(result.createdNoteCount, 0);
  assert.equal(state.writes, 0);
});

for (const validationReply of [null, {}, [], [{ canAdd: "true" }], [{ canAdd: true }, { canAdd: true }]]) {
  test(`invalid draft validation ${JSON.stringify(validationReply)} cannot reach addNotes`, async (t) => {
    const state = mockNoteCreation(t);
    state.validationReply = validationReply;
    const response = await createNotes(creationInput(1));
    const result = noteCreationOutputSchema.parse(response.structuredContent);
    assert.equal(response.isError, true);
    assert.equal(result.outcome, "not-attempted");
    assert.equal(result.createdNoteCount, 0);
    assert.equal(state.writes, 0);
  });
}

test("an aligned partial creation reply keeps successful IDs and explicit null rejections", async (t) => {
  const state = mockNoteCreation(t);
  state.nullIndexes.add(1);
  const response = await createNotes(creationInput());
  const result = noteCreationOutputSchema.parse(response.structuredContent);
  assert.equal(response.isError, true);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.createdNoteCount, 2);
  assert.deepEqual(result.createdNotes.map(({ inputIndex, noteId }) => ({ inputIndex, noteId })), [{ inputIndex: 0, noteId: 100 }, { inputIndex: 2, noteId: 102 }]);
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["created", "not-created", "created"]);
  assert.equal(result.validations[1]!.canCreate, false);
  assert.match(result.warnings.join(" "), /Do not resend the whole batch/u);
  assert.deepEqual(state.requests.find(({ action }) => action === "notesInfo")?.params.notes, [100, 102]);
  assert.equal(state.writes, 1);
});

test("an aligned all-null reply is known zero creation and does not perform an empty readback", async (t) => {
  const state = mockNoteCreation(t);
  [0, 1, 2].forEach((index) => state.nullIndexes.add(index));
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
  assert.equal(result.createdNoteCount, 0);
  assert.equal(result.outcome, "incomplete");
  assert.ok(result.noteResults.every(({ status }) => status === "not-created"));
  assert.equal(state.writes, 1);
  assert.equal(state.readbacks, 0);
});

test("readback failure preserves every acknowledged ID and uses null, not empty Card arrays", async (t) => {
  const state = mockNoteCreation(t);
  state.readbackFailure = true;
  const response = await createNotes(creationInput());
  const result = noteCreationOutputSchema.parse(response.structuredContent);
  assert.equal(response.isError, true);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.createdNoteCount, 3);
  assert.deepEqual(result.createdNotes, [100, 101, 102].map((noteId, inputIndex) => ({ inputIndex, noteId, cardIds: null, verified: false })));
  assert.ok(result.noteResults.every(({ status }) => status === "created-unverified"));
  assert.equal(state.writes, 1);
  assert.equal(state.readbacks, 1);
  assert.equal(state.notes.size, 3, "there was no rollback or second creation");
  assert.match(JSON.stringify(response.content), /100.*101.*102/u);
});

test("missing readback Notes do not erase verified siblings or imply creation failed", async (t) => {
  const state = mockNoteCreation(t);
  state.missingReadbackIds.add(101);
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
  assert.equal(result.createdNoteCount, 3);
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["created", "created-unverified", "created"]);
  assert.equal(result.createdNotes[1]!.noteId, 101);
  assert.equal(result.createdNotes[1]!.cardIds, null);
});

for (const failure of ["network-before", "network-after", "action-after", "timeout-after", "invalid-json-after"] as const) {
  test(`a ${failure} creation failure reports unknown count without retrying or inventing IDs`, async (t) => {
    const state = mockNoteCreation(t);
    state.creationFailure = failure;
    if (failure === "timeout-after") process.env.ANKI_REQUEST_TIMEOUT_MS = "15";
    const response = await createNotes(creationInput());
    const result = noteCreationOutputSchema.parse(response.structuredContent);
    assert.equal(response.isError, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.createdNoteCount, null);
    assert.deepEqual(result.createdNotes, []);
    assert.deepEqual(result.reportedNoteIds, []);
    assert.ok(result.noteResults.every(({ status, noteId, cardIds }) => status === "unknown" && noteId === null && cardIds === null));
    assert.equal(state.writes, 1);
    assert.equal(state.readbacks, 0, "no speculative search/reconstruction after losing the creation reply");
    assert.doesNotMatch(JSON.stringify(result), /private-invalid-response/u);
    if (failure === "network-before") assert.equal(state.notes.size, 0);
    else assert.equal(state.notes.size, 3);
  });
}

test("a known not-sent creation error remains not-attempted", async (t) => {
  const state = mockNoteCreation(t);
  state.beforeCreation = () => { delete process.env.ANKI_URL; };
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
  assert.equal(result.outcome, "not-attempted");
  assert.equal(result.createdNoteCount, 0);
  assert.equal(state.writes, 0);
});

for (const reply of [null, {}, true, "private-reply", [], [100], [100, 101, 102, 103], [100, 100, 102], [100, "private-reply", null], [100, -1, null], [100, 1.5, null], [100, Number.MAX_SAFE_INTEGER + 1, null]]) {
  test(`malformed creation reply ${JSON.stringify(reply)} retains only unmapped numeric evidence`, async (t) => {
    const state = mockNoteCreation(t);
    state.creationReply = reply;
    const response = await createNotes(creationInput());
    const result = noteCreationOutputSchema.parse(response.structuredContent);
    assert.equal(response.isError, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.createdNoteCount, null);
    assert.deepEqual(result.createdNotes, []);
    assert.ok(result.noteResults.every(({ status, noteId }) => status === "unknown" && noteId === null));
    assert.equal(state.readbacks, 0);
    assert.equal(state.writes, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-reply/u);
    assert.ok(result.reportedNoteIds.every((id) => Number.isSafeInteger(id) && id > 0));
  });
}

test("reported IDs from corrupt replies are bounded and never mapped by guessed positions", () => {
  const parsed = interpretNoteCreationReply(Array.from({ length: 80 }, (_, index) => index + 1), 3);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reportedNoteIds.length, 50);
  assert.equal(parsed.reportedNoteIdsTruncated, true);
  assert.ok(parsed.noteResults.every(({ status, noteId }) => status === "unknown" && noteId === null));
  assert.deepEqual(interpretNoteCreationReply([100, 100], 3).reportedNoteIds, [100]);
});

for (const reply of [null, {}, "private-readback", [{ noteId: 100, modelName: "Basic", cards: [-1] }], [{ noteId: 100, modelName: "Other", cards: [1000] }]]) {
  test(`bad readback ${JSON.stringify(reply)} cannot remove creation evidence or report verified success`, async (t) => {
    const state = mockNoteCreation(t);
    state.readbackReply = reply;
    const response = await createNotes(creationInput());
    const result = noteCreationOutputSchema.parse(response.structuredContent);
    assert.equal(response.isError, true);
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.createdNoteCount, 3);
    assert.deepEqual(result.createdNotes.map(({ noteId }) => noteId), [100, 101, 102]);
    assert.ok(result.createdNotes.every(({ verified, cardIds }) => !verified && cardIds === null));
    assert.equal(state.writes, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-readback/u);
  });
}

test("one malformed Note record does not discard other readable created Notes", async (t) => {
  const state = mockNoteCreation(t);
  state.readbackReply = [null, { noteId: 100, modelName: "Basic", cards: [1000] }, { noteId: 101, modelName: "Basic", cards: [1010, 1010] }, { noteId: 102, modelName: "Basic", cards: [] }];
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["created", "created-unverified", "created"]);
  assert.deepEqual(result.createdNotes[2]!.cardIds, [], "an actual empty list differs from unavailable data");
});

for (const reply of [
  [{ noteId: 100, modelName: "Basic", cards: [1000] }, { noteId: 100, modelName: "Basic", cards: [1000] }],
  [{ noteId: 999, modelName: "Basic", cards: [9990] }],
]) {
  test("unexpected or duplicate Note IDs make readback untrusted without losing creation IDs", async (t) => {
    const state = mockNoteCreation(t);
    state.readbackReply = reply;
    const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
    assert.ok(result.noteResults.every(({ status }) => status === "created-unverified"));
    assert.equal(result.createdNoteCount, 3);
  });
}

test("a Card claimed by two created Notes cannot be verified for either owner", async (t) => {
  const state = mockNoteCreation(t);
  state.readbackReply = [100, 101, 102].map((noteId) => ({ noteId, modelName: "Basic", cards: [noteId === 102 ? 1020 : 1000] }));
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput())).structuredContent);
  assert.deepEqual(result.noteResults.map(({ status }) => status), ["created-unverified", "created-unverified", "created"]);
});

test("a complete 50-Note batch is sent once and read back once", async (t) => {
  const state = mockNoteCreation(t);
  const result = noteCreationOutputSchema.parse((await createNotes(creationInput(50))).structuredContent);
  assert.equal(result.outcome, "complete");
  assert.equal(result.createdNoteCount, 50);
  assert.equal(state.writes, 1);
  assert.equal(state.readbacks, 1);
  assert.equal(state.createdInputs.length, 50);
});
