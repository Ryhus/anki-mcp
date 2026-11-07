import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { convertNotesToNoteType } from "../mcp/tools/notes/convert-notes-to-note-type.js";
import { noteConversionInputSchema, noteConversionOutputSchema } from "../mcp/tools/notes/note-conversion-schemas.js";

const timestamp = "2026-11-05T12:00:00Z";
const input = { noteIds: [1, 1], targetNoteTypeId: 20 };
const fields = [
  { target: "Question", source: "Front" },
  { target: "Answer", source: "Back" },
  { target: "Extra", source: null },
];
const templates = [
  { target: "New Reverse", source: null },
  { target: "New Recall", source: "Recall" },
];
const mappedFields = { Question: "<b>Cat</b>", Answer: "猫", Extra: "" };
const beforeFields = { Front: "<b>Cat</b>", Back: "猫", Hint: "<i>Private hint</i>" };
const template = (name: string) => ({ name, questionHtml: "{{Field}}", answerHtml: "{{FrontSide}}" });

function fixture(t: TestContext) {
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
  const source = {
    id: "10", name: "Old", kind: "normal", css: ".card {}", modifiedAt: timestamp,
    fields: ["Front", "Back", "Hint"].map((name) => ({ name })),
    templates: ["Recall", "Reverse"].map(template),
  };
  const target = {
    id: "20", name: "New", kind: "normal", css: ".card {}", modifiedAt: timestamp,
    fields: ["Question", "Answer", "Extra"].map((name) => ({ name })),
    templates: ["New Reverse", "New Recall"].map(template),
  };
  const state = {
    source, target, session: "s1", fields: { ...beforeFields }, reps: 2,
    converted: false, filtered: false, tokens: 0, preserveAll: false,
    failure: "" as "" | "lost" | "wrong-count" | "wrong-fields" | "wrong-schedule" | "missing-card" | "removed-still-present",
    calls: [] as string[], writes: [] as Array<Record<string, unknown>>,
  };
  const makeNote = (id: string) => {
    const type = state.converted || id === "2" ? target : source;
    const values: Record<string, string> = type === target ? { ...mappedFields } : state.fields;
    if (state.converted && state.preserveAll) values.Extra = state.fields.Hint;
    if (state.converted && state.failure === "wrong-fields") values.Question = "Changed by Anki";
    return {
      id, noteType: { id: type.id, name: type.name }, fields: values, modifiedAt: timestamp, tags: ["keep"],
      cardIds: state.converted && !state.preserveAll ? ["101", "103"] : ["101", "102"],
    };
  };
  const makeCard = (id: string) => {
    const deck = { id: "5", name: "Learning" };
    return {
      id, noteId: "1", deck, homeDeck: state.filtered ? deck : null,
      templateIndex: id === "101" ? state.converted ? 1 : 0 : id === "103" || state.converted && state.preserveAll ? 0 : 1,
      flags: 0, modifiedAt: timestamp,
      scheduling: {
        type: "review", queue: "review", due: { kind: "day", day: 42 },
        intervalDays: 5, remainingSteps: 0, repetitions: state.reps + (state.converted && state.failure === "wrong-schedule" ? 1 : 0),
        lapses: 0, sm2EasePermille: 2500,
      },
    };
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { id, method, params } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const missing = (index: number) => ({ index, error: { code: 1001, message: "Private backend details" } });
    if (method === "collection.get") return ok({ profile: "Fixture", session: state.session });
    assert.equal(params.session, state.session);
    if (method === "notes.getMany") {
      return ok({ items: params.ids.map((id: string, index: number) => id === "1" || id === "2"
        ? { index, result: makeNote(id) } : missing(index)) });
    }
    if (method === "noteTypes.get") return ok(params.noteType.id === "10" ? source : target);
    if (method === "notes.planConversion") {
      assert.deepEqual(params.source, { id: "10" });
      assert.deepEqual(params.target, { id: "20" });
      return ok({
        source: { id: source.id, name: source.name }, target: { id: target.id, name: target.name },
        fields: [...fields].reverse(), templates: [...templates].reverse(), token: `private-token-${++state.tokens}`,
      });
    }
    if (method === "cards.getMany") {
      return ok({ items: params.ids.map((id: string, index: number) => state.converted &&
        ((id === "102" && !state.preserveAll && state.failure !== "removed-still-present") || (id === "101" && state.failure === "missing-card"))
        ? missing(index) : { index, result: makeCard(id) }) });
    }
    assert.equal(method, "notes.convert");
    assert.equal(params.planToken, `private-token-${state.tokens}`);
    assert.deepEqual(params.ids, ["1"]);
    assert.deepEqual(params.target, { id: "20" });
    assert.deepEqual(params.fields, state.preserveAll ? [...fields.slice(0, 2), { target: "Extra", source: "Hint" }] : fields);
    assert.deepEqual(params.templates, state.preserveAll ? [{ target: "New Reverse", source: "Reverse" }, templates[1]] : templates);
    state.writes.push(params);
    state.converted = true;
    if (state.failure === "lost") throw new TypeError("Private backend details");
    return ok({ changedCount: state.failure === "wrong-count" ? 0 : 1 });
  });
  return state;
}

function applyArgs(impactHash: string | null) {
  assert.ok(impactHash);
  return {
    ...input, dryRun: false, expectedImpactHash: impactHash,
    confirmConversion: true, confirmDataLoss: true, confirmCardCreation: true,
  };
}

async function run(args: unknown = input) {
  return noteConversionOutputSchema.parse((await convertNotesToNoteType(noteConversionInputSchema.parse(args))).structuredContent);
}

for (const protocol of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${protocol} previews and converts once, preserving verified IDs and reporting discarded/new Cards`, async (t) => {
    const state = fixture(t);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "conversion-test", version: "0.0.0" }, {
      supportedProtocolVersions: [protocol],
      versionNegotiation: { mode: protocol === "2026-07-28" ? { pin: protocol } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "convert-notes-to-note-type", arguments: args });
    const previewResponse = await call(input);
    const preview = noteConversionOutputSchema.parse(previewResponse.structuredContent);
    assert.equal(preview.applied, false);
    assert.ok(preview.impactHash);
    assert.deepEqual(preview.fields, fields);
    assert.deepEqual(preview.templates, templates);
    assert.deepEqual(preview.impact, {
      noteCount: 1, preservedCardCount: 1, removedCardCount: 1, possibleNewCardCount: 1,
      droppedNonEmptyFieldValueCount: 1,
      droppedFields: [{ fieldName: "Hint", nonEmptyNoteCount: 1, sampleNoteIds: [1] }],
      samplePreservedCardIds: [101], sampleRemovedCardIds: [102],
    });
    assert.doesNotMatch(JSON.stringify(previewResponse), /private-token|Private hint/u);
    assert.deepEqual(state.writes, []);
    const apply = applyArgs(preview.impactHash);
    const denied = noteConversionOutputSchema.parse((await call({ ...apply, confirmDataLoss: false, confirmCardCreation: false })).structuredContent);
    assert.equal(denied.blockers.length, 2);
    assert.deepEqual(state.writes, []);
    const response = await call({ ...apply, fields: [...fields].reverse(), templates: [...templates].reverse() });
    const saved = noteConversionOutputSchema.parse(response.structuredContent);
    assert.equal(saved.verified, true);
    assert.deepEqual(saved.convertedNotes, [{ noteId: 1, preservedCardIds: [101], removedCardIds: [102], newCardIds: [103] }]);
    assert.deepEqual(state.calls.slice(-3), ["notes.convert", "notes.getMany", "cards.getMany"]);
    assert.equal(state.writes.length, 1);
    assert.ok(noteConversionOutputSchema.parse((await call(input)).structuredContent).blockers.length > 0, "no repeat after conversion");
    assert.equal(state.writes.length, 1);
  });
}

test("changed full fields, Card state, design or collection session invalidate the reviewed hash", async (t) => {
  const state = fixture(t);
  const preview = await run();
  const apply = applyArgs(preview.impactHash);
  const changes: Array<[() => void, () => void]> = [
    [() => { state.fields.Hint = "Concurrent field change"; }, () => { state.fields.Hint = beforeFields.Hint; }],
    [() => { state.reps++; }, () => { state.reps--; }],
    [() => { state.target.css += " "; }, () => { state.target.css = ".card {}"; }],
    [() => { state.session = "s2"; }, () => { state.session = "s1"; }],
  ];
  for (const [change, restore] of changes) {
    change();
    const denied = await run(apply);
    assert.equal(denied.applied, false);
    assert.match(denied.blockers.join(" "), /snapshot changed/u);
    restore();
  }
  assert.deepEqual(state.writes, []);
});

test("explicit mappings can keep all data and Card IDs without loss or creation confirmations", async (t) => {
  const state = fixture(t);
  const suggested = await run();
  const proposal = {
    fields: [...fields.slice(0, 2), { target: "Extra", source: "Hint" }],
    templates: [{ target: "New Reverse", source: "Reverse" }, templates[1]!],
  };
  const preview = await run({ ...input, ...proposal });
  assert.notEqual(preview.impactHash, suggested.impactHash);
  assert.equal(preview.impact?.droppedNonEmptyFieldValueCount, 0);
  assert.equal(preview.impact?.possibleNewCardCount, 0);
  state.preserveAll = true;
  const saved = await run({
    ...applyArgs(preview.impactHash), ...proposal, confirmDataLoss: false, confirmCardCreation: false,
  });
  assert.equal(saved.verified, true);
  assert.deepEqual(saved.convertedNotes, [{ noteId: 1, preservedCardIds: [101, 102], removedCardIds: [], newCardIds: [] }]);
});

test("unsupported selections and malformed mappings never reach notes.convert", async (t) => {
  const state = fixture(t);
  for (const [args, expected] of [
    [{ ...input, noteIds: [1, 99] }, /could not be loaded/u],
    [{ ...input, noteIds: [1, 2] }, /one source/u],
    [{ ...input, targetNoteTypeId: 10 }, /must differ/u],
    [{ ...input, fields: fields.slice(1) }, /cover every target/u],
    [{ ...input, fields: [...fields.slice(0, 2), { target: "Extra", source: "Front" }] }, /distinct source/u],
    [{ ...input, fields: fields.map((row, index) => index === 0 ? { ...row, source: null } : row) }, /empty first/u],
    [{ ...input, templates: templates.map((row) => ({ ...row, source: null })) }, /no existing Card/u],
  ] as const) {
    const denied = await run(args);
    assert.equal(denied.impactHash, null);
    assert.match(denied.blockers.join(" "), expected);
  }
  state.target.kind = "cloze";
  assert.match((await run()).blockers.join(" "), /Normal to Normal/u);
  state.target.kind = "normal";
  state.filtered = true;
  assert.match((await run()).blockers.join(" "), /filtered decks/u);
  assert.deepEqual(state.writes, []);
});

for (const failure of ["lost", "wrong-count", "wrong-fields", "wrong-schedule", "missing-card", "removed-still-present"] as const) {
  test(`conversion ${failure} does not retry or falsely confirm saved state`, async (t) => {
    const state = fixture(t);
    const preview = await run();
    state.failure = failure;
    await assert.rejects(run(applyArgs(preview.impactHash)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Data may already have changed/u);
      assert.doesNotMatch(error.message, /Private backend details|private-token/u);
      if (failure === "lost" || failure === "wrong-count") assert.match(error.message, /could not be confirmed/u);
      else assert.match(error.message, /acknowledged.*readback did not verify/u);
      return true;
    });
    assert.equal(state.writes.length, 1);
  });
}

test("legacy mode rejects conversion before contacting Anki", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(run(), /requires ANKI_API_MODE=v1/u);
  assert.deepEqual(state.calls, []);
});
