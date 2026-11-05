import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AnkiMultiActionError, createAnkiAction, invokeAnki, invokeAnkiMulti } from "../anki-api/anki-request.js";
import { withAnkiToolContext } from "../anki-api/v1/anki-v1-context.js";

const session = "test-collection";
const profile = "Fixture";
const entity = { id: "10", name: "Basic" };
const design = {
  ...entity, css: ".card {}", fields: [{ name: "Front" }, { name: "Back" }],
  templates: [{ name: "Card 1", questionHtml: "{{Front}}", answerHtml: "{{Back}}" }],
};
const deck = { id: "1", name: "Default", kind: "normal" };
const note = {
  id: "101", noteType: entity, fields: { Back: "Second", Front: "First" },
  tags: ["keep"], cardIds: ["201"], modifiedAt: "2026-11-05T12:00:00Z",
};
const card = {
  id: "201", noteId: "101", deck, homeDeck: null, templateIndex: 0, flags: 1,
  modifiedAt: "2026-11-05T12:00:00Z",
  scheduling: {
    type: "review", queue: "review", due: { kind: "day", day: 42 },
    intervalDays: 4, remainingSteps: 0, repetitions: 7, lapses: 1, sm2EasePermille: 2500,
  },
};
const items = (...results: unknown[]) => ({ items: results.map((result, index) => ({ index, result })) });
const changed = { changed: true };

function scripted(t: TestContext) {
  const saved = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  const steps: Array<{ method: string; params: Record<string, unknown>; result: unknown; error?: number }> = [];
  const calls: string[] = [];
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.deepEqual(steps.map(({ method }) => method), [], "all expected RPCs must have run");
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const { method, id, jsonrpc, params } = JSON.parse(String(init.body));
    calls.push(method);
    assert.equal(new URL(url).pathname, "/api/v1", "no legacy request is allowed in v1 mode");
    assert.equal(jsonrpc, "2.0");
    const step = steps.shift();
    assert.ok(step, `Unexpected call: ${method}`);
    assert.equal(method, step.method);
    assert.deepEqual(params, step.params);
    return Response.json({
      jsonrpc, id, ...(step.error === undefined ? { result: step.result } : { error: { code: step.error, message: "private" } }),
    });
  });
  return {
    calls,
    start: () => steps.push({ method: "collection.get", params: {}, result: { session, profile } }),
    add: (method: string, params: Record<string, unknown>, result: unknown, error?: number) =>
      steps.push({
        method, params: method === "operations.get" ? params : { ...params, session }, result,
        ...(error === undefined ? {} : { error }),
      }),
  };
}

test("exact search traverses native cursors, and grouped reads reuse one session", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("notes.search", { query: "", limit: 1000 }, { ids: ["101"], nextCursor: "more" });
  f.add("notes.search", { query: "", limit: 1000, cursor: "more" }, { ids: ["102"], nextCursor: null });
  f.add("notes.getMany", { ids: ["101"] }, items(note));
  f.add("noteTypes.get", { noteType: { name: "Basic" } }, design);
  const [active, found, notes] = await withAnkiToolContext(true, () => invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"), createAnkiAction<number[]>("findNotes", { query: "" }),
    createAnkiAction<unknown[]>("notesInfo", { notes: [101] }),
  ] as const));
  assert.equal(active, profile);
  assert.deepEqual(found, [101, 102]);
  assert.deepEqual(notes, [{
    noteId: 101, profile, modelName: "Basic", tags: ["keep"], cards: [201],
    mod: 1_793_880_000, fields: { Front: { value: "First", order: 0 }, Back: { value: "Second", order: 1 } },
  }]);
});

test("an invalid native search keeps its read-group action index, not a fallback request", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("notes.search", { query: "bad", limit: 1000 }, null, 1013);
  f.add("notes.search", { query: "", limit: 1000 }, { ids: [], nextCursor: null });
  await assert.rejects(invokeAnkiMulti([
    createAnkiAction("findNotes", { query: "bad" }), createAnkiAction("findNotes", { query: "" }),
  ]), (error) => error instanceof AnkiMultiActionError && error.actionIndex === 0 && /invalidSearch/u.test(error.message));
  await assert.rejects(invokeAnki("unknownLegacyAction"), /no legacy request was sent/u);
  await assert.rejects(invokeAnkiMulti([createAnkiAction("deleteNotes", { notes: [101] })]), /Only supported read actions/u);
});

test("native tag, Note deletion, and media-related field writes check indexed acknowledgements", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("tags.add", { noteIds: ["101"], tags: ["new", "more"] }, items(changed));
  f.add("tags.remove", { noteIds: ["101"], tags: ["old"] }, items(changed));
  f.add("notes.update", { id: "101", patch: { fields: { Back: "updated" } } }, note);
  f.add("notes.delete", { ids: ["101"] }, items(changed));
  await withAnkiToolContext(true, async () => {
    assert.equal(await invokeAnki("addTags", { notes: [101], tags: "new more" }), null);
    assert.equal(await invokeAnki("removeTags", { notes: [101], tags: "old" }), null);
    assert.equal(await invokeAnki("updateNoteFields", { note: { id: 101, fields: { Back: "updated" } } }), null);
    assert.equal(await invokeAnki("deleteNotes", { notes: [101] }), null);
  });
});

test("native deletion never acknowledges a malformed or failed item", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("notes.delete", { ids: ["101", "102"] }, { items: [
    { index: 0, result: changed }, { index: 1, error: { code: 1001, message: "private" } },
  ] });
  await assert.rejects(invokeAnki("deleteNotes", { notes: [101, 102] }), /notFound \(1001\)/u);
});

test("Note Type structure and design operations map all existing edits to native methods", async (t) => {
  const f = scripted(t);
  const modelName = "Basic";
  const noteType = { name: modelName };
  f.start();
  f.add("noteTypes.create", {
    name: modelName, fields: [{ name: "Front" }, { name: "Back" }],
    templates: [{ name: "Card 1", questionHtml: "{{Front}}", answerHtml: "{{Back}}" }], css: ".card {}", kind: "normal",
  }, entity);
  f.add("noteTypes.getTemplateUsage", { noteType }, [{
    templateName: "Card 1", questionFields: ["Front"], answerFields: ["Front", "Back"],
  }]);
  const edits = [
    ["modelFieldAdd", { fieldName: "Extra", index: 1 }, { op: "addField", field: { name: "Extra" }, index: 1 }],
    ["modelFieldRename", { oldFieldName: "Extra", newFieldName: "New" }, { op: "updateField", name: "Extra", patch: { name: "New" } }],
    ["modelFieldReposition", { fieldName: "New", index: 0 }, { op: "moveField", name: "New", index: 0 }],
    ["modelFieldRemove", { fieldName: "New" }, { op: "removeField", name: "New" }],
    ["modelTemplateAdd", { template: { Name: "Card 2", Front: "{{Back}}", Back: "{{Front}}" } },
      { op: "addTemplate", template: { name: "Card 2", questionHtml: "{{Back}}", answerHtml: "{{Front}}" } }],
    ["modelTemplateRename", { oldTemplateName: "Card 2", newTemplateName: "Reverse" }, { op: "updateTemplate", name: "Card 2", patch: { name: "Reverse" } }],
    ["modelTemplateReposition", { templateName: "Reverse", index: 0 }, { op: "moveTemplate", name: "Reverse", index: 0 }],
    ["modelTemplateRemove", { templateName: "Reverse" }, { op: "removeTemplate", name: "Reverse" }],
    ["updateModelTemplates", { model: { name: modelName, templates: { "Card 1": { Back: "" } } } },
      { op: "updateTemplate", name: "Card 1", patch: { answerHtml: "" } }],
  ] as const;
  for (const [, , edit] of edits) f.add("noteTypes.editStructure", { noteType, edits: [edit] }, entity);
  f.add("noteTypes.update", { noteType, patch: { css: "changed" } }, entity);
  await withAnkiToolContext(true, async () => {
    assert.deepEqual(await invokeAnki("createModel", {
      modelName, inOrderFields: ["Front", "Back"], cardTemplates: [{ Name: "Card 1", Front: "{{Front}}", Back: "{{Back}}" }],
      css: ".card {}", isCloze: false,
    }), { id: 10, name: modelName });
    assert.deepEqual(await invokeAnki("modelFieldsOnTemplates", { modelName }), { "Card 1": [["Front"], ["Back"]] });
    for (const [action, params] of edits) assert.equal(await invokeAnki(action, { modelName, ...params }), null);
    assert.equal(await invokeAnki("updateModelStyling", { model: { name: modelName, css: "changed" } }), null);
  });
});

test("native deck statistics, placement, moves and deletion preserve IDs and acknowledgement", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("decks.getCounts", { deck: { name: "Default" }, includeChildren: true }, { deckId: "1", new: 2, learning: 3, review: 4, total: 10 });
  f.add("cards.getMany", { ids: ["201"] }, items(card));
  f.add("decks.get", { deck: { name: "Default" } }, deck);
  f.add("decks.create", { name: "Target" }, { id: "2", name: "Target", kind: "normal" });
  f.add("cards.move", { ids: ["201"], deck: { id: "2" } }, items(changed));
  f.add("decks.delete", { decks: [{ name: "Target" }], deleteCards: true }, items(changed));
  await withAnkiToolContext(true, async () => {
    assert.deepEqual(await invokeAnki("getDeckStats", { decks: ["Default"] }), {
      1: { deck_id: 1, name: "Default", new_count: 2, learn_count: 3, review_count: 4, total_in_deck: 10 },
    });
    assert.deepEqual(await invokeAnki("getDecks", { cards: [201] }), { Default: [201] });
    assert.deepEqual(await invokeAnki("getDeckConfig", { deck: "Default" }), { dyn: false });
    assert.equal(await invokeAnki("changeDeck", { cards: [201], deck: "Target" }), null);
    assert.equal(await invokeAnki("deleteDecks", { decks: ["Target"], cardsToo: true }), null);
  });
});

test("native Card routes render only when requested and use native scheduler commands", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("cards.getMany", { ids: ["201"] }, items(card));
  f.add("notes.getMany", { ids: ["101"] }, items(note));
  f.add("noteTypes.get", { noteType: { name: "Basic" } }, design);
  f.add("cards.render", { id: "201" }, { cardId: "201", questionHtml: "Q", answerHtml: "A", css: ".card {}" });
  f.add("cards.setSuspended", { ids: ["201"], suspended: true }, items(changed));
  f.add("cards.setSuspended", { ids: ["201"], suspended: false }, items(changed));
  f.add("cards.setFlags", { ids: ["201"], flag: 2 }, items(changed));
  f.add("scheduling.setDueDate", { cardIds: ["201"], days: "4" }, items(changed));
  f.add("scheduling.reset", { cardIds: ["201"], restorePosition: true, resetCounts: false, log: true }, items(changed));
  f.add("cards.getMany", { ids: ["201"] }, items(card));
  f.add("scheduling.predict", { cardId: "201" }, { cardId: "201", stateToken: "token", answers: [{ rating: "again" }] });
  f.add("scheduling.answer", { cardId: "201", rating: "again", stateToken: "token" }, { cardId: "201" });
  await withAnkiToolContext(true, async () => {
    const [read] = await invokeAnki<Array<Record<string, unknown>>>("cardsInfo", { cards: [201], render: true });
    assert.equal(read?.question, "Q");
    assert.equal(read?.answer, "A");
    assert.equal(read?.type, 2);
    assert.equal(read?.due, 42);
    assert.equal(await invokeAnki("suspend", { cards: [201] }), true);
    assert.equal(await invokeAnki("unsuspend", { cards: [201] }), null);
    assert.deepEqual(await invokeAnki("setSpecificValueOfCard", { card: 201, keys: ["flags"], newValues: [2] }), [true]);
    assert.equal(await invokeAnki("setDueDate", { cards: [201], days: "4" }), true);
    assert.equal(await invokeAnki("forgetCards", { cards: [201] }), null);
    assert.equal(await invokeAnki("relearnCards", { cards: [201] }), null);
  });
});

test("media store polls one accepted write and uses native collision rejection", async (t) => {
  const f = scripted(t);
  f.start();
  const handle = { operationId: "op", method: "media.store", session };
  f.add("media.store", { filename: "pixel.png", source: { data: "data" }, collision: "error" }, handle);
  f.add("operations.get", { operationId: "op" }, { ...handle, state: "running" });
  f.add("operations.get", { operationId: "op" }, { ...handle, state: "succeeded", result: { status: "stored", filename: "pixel.png" } });
  f.add("media.get", { filename: "pixel.png" }, { filename: "pixel.png", data: "data" });
  f.add("media.delete", { filename: "pixel.png" }, changed);
  await withAnkiToolContext(true, async () => {
    assert.equal(await invokeAnki("storeMediaFile", { filename: "pixel.png", data: "data", deleteExisting: false, rejectIfExists: true }), "pixel.png");
    assert.equal(await invokeAnki("retrieveMediaFile", { filename: "pixel.png" }), "data");
    assert.equal(await invokeAnki("deleteMediaFile", { filename: "pixel.png" }), null);
  });
});

test("a lost operation status reports uncertain storage without repeating the write", async (t) => {
  const f = scripted(t);
  f.start();
  f.add("media.store", { filename: "pixel.png", source: { data: "data" }, collision: "rename" }, {
    operationId: "op", method: "media.store", session,
  });
  f.add("operations.get", { operationId: "op" }, null, 1001);
  await assert.rejects(invokeAnki("storeMediaFile", { filename: "pixel.png", data: "data", deleteExisting: false }),
    /accepted the media operation.*may exist.*inspect Anki/u);
  assert.equal(f.calls.filter((method) => method === "media.store").length, 1);
});

test("concurrent MCP invocations do not share their pinned collection contexts", async (t) => {
  const previous = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "v1";
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let opened = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { id, method, params } = JSON.parse(String(init.body));
    let result: unknown;
    if (method === "collection.get") {
      opened += 1;
      result = { session: String(opened), profile: String(opened) };
    } else {
      assert.equal(method, "notes.search");
      assert.equal(params.session, params.query);
      result = { ids: [params.session], nextCursor: null };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  const invocation = () => withAnkiToolContext(true, async () => {
    const profile = await invokeAnki<string>("getActiveProfile");
    const [first, second] = await Promise.all([
      invokeAnki("findNotes", { query: profile }), invokeAnki("findNotes", { query: profile }),
    ]);
    return { profile, first, second };
  });
  const results = await Promise.all([invocation(), invocation()]);
  assert.equal(opened, 2);
  assert.deepEqual(results, [
    { profile: "1", first: [1], second: [1] }, { profile: "2", first: [2], second: [2] },
  ]);
});
