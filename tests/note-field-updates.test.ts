import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { AnkiNoteInfo } from "../anki-api/notes/note-types.js";
import {
  getNoteDetails,
  getNoteDetailsConfig,
} from "../mcp/tools/notes/get-note-details.js";
import { calculateNoteFieldHash } from "../mcp/tools/notes/note-field-utils.js";
import { registerNoteTools } from "../mcp/tools/notes/register.js";
import {
  updateNoteFields,
  updateNoteFieldsConfig,
} from "../mcp/tools/notes/update-note-fields.js";
import { withToolErrorHandling } from "../mcp/utils/tool-handler.js";

test("field updates default to preview and require a hash for every applied field", () => {
  const patch = { noteId: 1, fields: { Front: "House", Back: "Home" } };
  assert.equal(
    updateNoteFieldsConfig.inputSchema.parse({ updates: [patch] }).dryRun,
    true,
  );

  for (const expectedFieldHashes of [
    undefined,
    {},
    { Front: calculateNoteFieldHash("House") },
    { Front: "invalid", Back: calculateNoteFieldHash("Home") },
  ]) {
    assert.equal(
      updateNoteFieldsConfig.inputSchema.safeParse({
        dryRun: false,
        updates: [{ ...patch, expectedFieldHashes }],
      }).success,
      false,
    );
  }
  assert.equal(
    updateNoteFieldsConfig.inputSchema.safeParse({
      dryRun: false,
      updates: [{
        ...patch,
        expectedFieldHashes: {
          FRONT: calculateNoteFieldHash("House"),
          back: calculateNoteFieldHash("Home"),
        },
      }],
    }).success,
    true,
  );
  assert.equal(
    updateNoteFieldsConfig.inputSchema.safeParse({ updates: [patch, patch] }).success,
    false,
  );
});

test("get-note-details includes exact full-value hashes without changing Anki fields", async (t) => {
  const anki = mockAnkiNotes(t);
  anki.field(1, "Front").value = "<b>das Haus</b>\nHäuser 🏠";
  const details = getNoteDetailsConfig.outputSchema.parse(
    (await getNoteDetails({ noteIds: [1, 99] })).structuredContent,
  );
  const note = details.notes[0];
  assert.ok(note);
  assert.deepEqual(Object.keys(note.fields), ["Front", "Back"]);
  assert.equal(note.fields.Front?.value, "<b>das Haus</b>\nHäuser 🏠");
  assert.equal(note.fields.Front?.hash, anki.hash(1, "Front"));
  assert.deepEqual(details.missingNoteIds, [99]);
  assert.equal(Object.hasOwn(anki.field(1, "Front"), "hash"), false);
  assert.notEqual(
    calculateNoteFieldHash("<b>das Haus</b>"),
    calculateNoteFieldHash("das Haus"),
  );
});

test("dry runs preview raw HTML and hashes without writes or readback", async (t) => {
  const anki = mockAnkiNotes(t);
  const before = anki.field(1, "Front").value;
  const proposed = `${before}<br>Translation: house`;
  const preview = await update({
    updates: [{ noteId: 1, fields: { Front: proposed } }],
  });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.verified, false);
  assert.equal(preview.changedFieldCount, 1);
  assert.deepEqual(preview.changes, [{
    noteId: 1,
    fieldName: "Front",
    changed: true,
    beforeFieldHash: calculateNoteFieldHash(before),
    afterFieldHash: calculateNoteFieldHash(proposed),
    previousPreview: before,
    proposedPreview: proposed,
    previewTruncated: false,
  }]);
  assert.equal(anki.field(1, "Front").value, before);
  assert.deepEqual(anki.actions, ["notesInfo"]);
});

test("preview hashes can be applied and exact HTML is verified after writing", async (t) => {
  const anki = mockAnkiNotes(t);
  const proposed = '<b>das Haus</b><br><img src="house.png">';
  const preview = await update({
    updates: [{ noteId: 1, fields: { Front: proposed } }],
  });
  const change = preview.changes[0];
  assert.ok(change);
  anki.actions.length = 0;
  const applied = await update({
    dryRun: false,
    updates: [{
      noteId: 1,
      fields: { Front: proposed },
      expectedFieldHashes: { Front: change.beforeFieldHash },
    }],
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  assert.deepEqual(applied.updatedNotes, [{ noteId: 1, updatedFields: ["Front"] }]);
  assert.equal(anki.field(1, "Front").value, proposed);
  assert.equal(anki.field(1, "Back").value, "Home");
  assert.deepEqual(anki.actions, ["notesInfo", "updateNoteFields", "notesInfo"]);
});

test("hashes from get-note-details allow direct apply while unrelated edits are preserved", async (t) => {
  const anki = mockAnkiNotes(t);
  const details = getNoteDetailsConfig.outputSchema.parse(
    (await getNoteDetails({ noteIds: [1] })).structuredContent,
  );
  const fields = details.notes[0]?.fields;
  assert.ok(fields);
  const expectedFieldHashes = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.hash]),
  );
  anki.field(1, "Back").value = "A manual edit to another field";
  anki.actions.length = 0;

  const applied = await update({
    dryRun: false,
    updates: [{ noteId: 1, fields: { Front: "House" }, expectedFieldHashes }],
  });
  assert.equal(applied.applied, true);
  assert.equal(anki.field(1, "Back").value, "A manual edit to another field");
  assert.deepEqual(anki.actions, ["notesInfo", "updateNoteFields", "notesInfo"]);
});

test("a stale field rejects the entire batch before the first write", async (t) => {
  const anki = mockAnkiNotes(t);
  const expectedSecondHash = anki.hash(2, "Front");
  anki.field(2, "Front").value += "<br>A manual edit";
  const rejected = await update({
    dryRun: false,
    updates: [
      { noteId: 1, fields: { Front: "House" }, expectedFieldHashes: { Front: anki.hash(1, "Front") } },
      { noteId: 2, fields: { Front: "Tree" }, expectedFieldHashes: { Front: expectedSecondHash } },
    ],
  });

  assert.equal(rejected.applied, false);
  assert.equal(rejected.verified, false);
  assert.equal(rejected.rejectedUpdates[0]?.noteId, 2);
  assert.match(rejected.rejectedUpdates[0]?.error ?? "", /changed since.*Front/u);
  assert.equal(anki.field(1, "Front").value, "<b>das Haus</b>");
  assert.equal(anki.writes.length, 0);
});

test("HTML-only changes are conflicts even when visible text is unchanged", async (t) => {
  const anki = mockAnkiNotes(t);
  const expectedHash = anki.hash(1, "Front");
  anki.field(1, "Front").value = "<i>das Haus</i>";
  for (const dryRun of [true, false]) {
    const result = await update({
      dryRun,
      updates: [{
        noteId: 1,
        fields: { Front: "House" },
        expectedFieldHashes: { Front: expectedHash },
      }],
    });
    assert.equal(result.applied, false);
    assert.equal(result.rejectedUpdates.length, 1);
  }
  assert.equal(anki.writes.length, 0);
});

test("field and hash names resolve to canonical casing and share one write per note", async (t) => {
  const anki = mockAnkiNotes(t);
  const result = await update({
    dryRun: false,
    updates: [{
      noteId: 1,
      fields: { front: "House", BACK: "" },
      expectedFieldHashes: { FRONT: anki.hash(1, "Front"), back: anki.hash(1, "Back") },
    }],
  });
  assert.equal(result.verified, true);
  assert.deepEqual(anki.writes, [{ id: 1, fields: { Front: "House", Back: "" } }]);
});

test("missing notes and invalid or ambiguous field names prevent every write", async (t) => {
  const anki = mockAnkiNotes(t);
  for (const invalidUpdate of [
    { noteId: 99, fields: { Front: "Missing" } },
    { noteId: 2, fields: { Unknown: "Unknown" } },
    { noteId: 2, fields: { Front: "First", front: "Second" } },
    { noteId: 2, fields: { Front: "Tree" }, expectedFieldHashes: { Front: anki.hash(2, "Front"), front: anki.hash(2, "Front") } },
    { noteId: 2, fields: { Front: "Tree" }, expectedFieldHashes: { Unknown: anki.hash(2, "Front") } },
  ]) {
    const result = await update({
      updates: [{ noteId: 1, fields: { Front: "House" } }, invalidUpdate],
    });
    assert.equal(result.applied, false);
    assert.equal(result.missingNoteIds.length + result.rejectedUpdates.length, 1);
  }
  assert.equal(anki.writes.length, 0);
});

test("unchanged patches skip writes and additional verification reads", async (t) => {
  const anki = mockAnkiNotes(t);
  const result = await update({
    dryRun: false,
    updates: [{
      noteId: 1,
      fields: { Front: anki.field(1, "Front").value },
      expectedFieldHashes: { Front: anki.hash(1, "Front") },
    }],
  });
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.changedFieldCount, 0);
  assert.deepEqual(result.updatedNotes, []);
  assert.deepEqual(result.unchangedNoteIds, [1]);
  assert.deepEqual(anki.actions, ["notesInfo"]);
});

test("previews are bounded while hashes cover changes beyond the preview", async (t) => {
  const anki = mockAnkiNotes(t);
  const before = `${"x".repeat(1_500)}old`;
  const proposed = `${"x".repeat(1_500)}new`;
  anki.field(1, "Front").value = before;
  const result = await update({ updates: [{ noteId: 1, fields: { Front: proposed } }] });
  const change = result.changes[0];
  assert.ok(change);
  assert.equal(change.previewTruncated, true);
  assert.equal(change.previousPreview.length, 1_000);
  assert.equal(change.proposedPreview.length, 1_000);
  assert.equal(change.previousPreview, change.proposedPreview);
  assert.notEqual(change.beforeFieldHash, change.afterFieldHash);
  assert.equal(change.beforeFieldHash, calculateNoteFieldHash(before));
  assert.equal(change.afterFieldHash, calculateNoteFieldHash(proposed));
});

test("readback mismatches produce an MCP error instead of reporting success", async (t) => {
  const anki = mockAnkiNotes(t, {
    onWrite: (note) => { delete note.fields.Front; },
  });
  const result = await withToolErrorHandling(updateNoteFields)(
    updateNoteFieldsConfig.inputSchema.parse({
      dryRun: false,
      updates: [{ noteId: 1, fields: { Front: "House" }, expectedFieldHashes: { Front: anki.hash(1, "Front") } }],
    }),
  );
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /verification failed.*note 1 field/u);
  assert.match(JSON.stringify(result.content), /no rollback/u);
  assert.equal(anki.writes.length, 1);
});

test("missing notes during verification are reported after acknowledged writes", async (t) => {
  const anki = mockAnkiNotes(t, {
    onRead: (notes, readCount) => { if (readCount === 2) notes.delete(1); },
  });
  await assert.rejects(
    update({
      dryRun: false,
      updates: [{ noteId: 1, fields: { Front: "House" }, expectedFieldHashes: { Front: anki.hash(1, "Front") } }],
    }),
    /verification failed.*Missing note IDs: 1/u,
  );
  assert.equal(anki.writes.length, 1);
});

test("HTML normalization during writing fails exact-value verification", async (t) => {
  const anki = mockAnkiNotes(t, {
    onWrite: (note) => {
      const field = note.fields.Front;
      assert.ok(field);
      field.value = "House";
    },
  });
  await assert.rejects(
    update({
      dryRun: false,
      updates: [{
        noteId: 1,
        fields: { Front: "<b>House</b>" },
        expectedFieldHashes: { Front: anki.hash(1, "Front") },
      }],
    }),
    /verification failed.*note 1 field "Front"/u,
  );
});

test("verification read failures report that writes already reached Anki", async (t) => {
  const anki = mockAnkiNotes(t, {
    onRead: (_notes, readCount) => { if (readCount === 2) throw new Error("Read unavailable"); },
  });
  await assert.rejects(
    update({
      dryRun: false,
      updates: [{ noteId: 1, fields: { Front: "House" }, expectedFieldHashes: { Front: anki.hash(1, "Front") } }],
    }),
    /verification failed.*acknowledged for note IDs: 1.*Read unavailable/u,
  );
  assert.equal(anki.field(1, "Front").value, "House");
});

test("a failed write reports partial progress and stops before later notes", async (t) => {
  const anki = mockAnkiNotes(t, {
    onWrite: (note, fields) => {
      if (note.noteId === 2) throw new Error("Write unavailable");
      for (const [name, value] of Object.entries(fields)) {
        const field = note.fields[name];
        assert.ok(field);
        field.value = value;
      }
    },
  });
  await assert.rejects(
    update({
      dryRun: false,
      updates: [1, 2, 3].map((noteId) => ({
        noteId,
        fields: { Front: "Updated" },
        expectedFieldHashes: { Front: anki.hash(noteId, "Front") },
      })),
    }),
    /Could not confirm.*note 2.*acknowledged note IDs: 1.*later updates were not attempted/u,
  );
  assert.deepEqual(anki.writes.map(({ id }) => id), [1, 2]);
  assert.equal(anki.field(1, "Front").value, "Updated");
  assert.equal(anki.field(3, "Front").value, "<b>das Haus</b>");
});

test("MCP clients discover field hashes and enforce preview and apply contracts", async (t) => {
  const anki = mockAnkiNotes(t);
  const server = new McpServer({ name: "notes-test-server", version: "0.0.0" });
  const client = new Client({ name: "notes-test-client", version: "0.0.0" });
  registerNoteTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some(({ name }) => name === "update-note-fields"));

  const details = getNoteDetailsConfig.outputSchema.parse(
    (await client.callTool({
      name: "get-note-details",
      arguments: { noteIds: [1] },
    })).structuredContent,
  );
  const hash = details.notes[0]?.fields.Front?.hash;
  assert.ok(hash);
  const patch = { noteId: 1, fields: { Front: "House" } };
  const preview = updateNoteFieldsConfig.outputSchema.parse(
    (await client.callTool({
      name: "update-note-fields",
      arguments: { updates: [patch] },
    })).structuredContent,
  );
  assert.equal(preview.dryRun, true);
  assert.equal(anki.writes.length, 0);
  const rejected = await client.callTool({
    name: "update-note-fields",
    arguments: { dryRun: false, updates: [patch] },
  });
  assert.equal(rejected.isError, true);
  assert.equal(anki.writes.length, 0);

  const applied = updateNoteFieldsConfig.outputSchema.parse(
    (await client.callTool({
      name: "update-note-fields",
      arguments: {
        dryRun: false,
        updates: [{ ...patch, expectedFieldHashes: { Front: hash } }],
      },
    })).structuredContent,
  );
  assert.equal(applied.verified, true);
  assert.equal(anki.field(1, "Front").value, "House");
});

async function update(input: unknown) {
  const result = await updateNoteFields(updateNoteFieldsConfig.inputSchema.parse(input));
  return updateNoteFieldsConfig.outputSchema.parse(result.structuredContent);
}

interface MockOptions {
  onRead?: (notes: Map<number, AnkiNoteInfo>, readCount: number) => void;
  onWrite?: (note: AnkiNoteInfo, fields: Record<string, string>) => void;
}

function mockAnkiNotes(t: TestContext, options: MockOptions = {}) {
  const originalAnkiUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalAnkiUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalAnkiUrl;
  });
  const notes = new Map<number, AnkiNoteInfo>([1, 2, 3].map((noteId) => [noteId, {
    noteId,
    modelName: "Basic",
    tags: ["keep"],
    fields: { Back: { value: "Home", order: 1 }, Front: { value: "<b>das Haus</b>", order: 0 } },
    mod: 1_700_000_000,
    cards: [noteId * 10],
  }]));
  const actions: string[] = [];
  const writes: Array<{ id: number; fields: Record<string, string> }> = [];
  let readCount = 0;

  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      action: string;
      params: { notes?: number[]; note?: { id: number; fields: Record<string, string> } };
    };
    actions.push(request.action);
    try {
      if (request.action === "notesInfo") {
        options.onRead?.(notes, ++readCount);
        return Response.json({ result: (request.params.notes ?? []).map((id) => notes.get(id) ?? {}), error: null });
      }
      assert.equal(request.action, "updateNoteFields");
      const patch = request.params.note;
      assert.ok(patch);
      writes.push(patch);
      const note = notes.get(patch.id);
      assert.ok(note);
      if (options.onWrite !== undefined) options.onWrite(note, patch.fields);
      else {
        for (const [name, value] of Object.entries(patch.fields)) {
          const field = note.fields[name];
          assert.ok(field);
          field.value = value;
        }
      }
      return Response.json({ result: null, error: null });
    } catch (error) {
      return Response.json({ result: null, error: error instanceof Error ? error.message : String(error) });
    }
  });

  function field(noteId: number, name: string) {
    const value = notes.get(noteId)?.fields[name];
    assert.ok(value);
    return value;
  }
  return { notes, actions, writes, field, hash: (noteId: number, name: string) => calculateNoteFieldHash(field(noteId, name).value) };
}
