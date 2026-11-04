import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { AnkiNoteDraft } from "../../anki-api/notes/note-types.js";
import { noteCreationInputSchema } from "../../mcp/tools/notes/note-creation-schemas.js";

export function creationInput(count = 3) {
  return noteCreationInputSchema.parse({ notes: Array.from({ length: count }, (_, index) => ({
    deckName: "Fixture", modelName: "Basic", fields: { Front: `Front ${index}`, Back: "<b>Back</b>" }, tags: ["fixture"],
  })) });
}

export function mockNoteCreation(t: TestContext) {
  const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  delete process.env.ANKI_REQUEST_TIMEOUT_MS;
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const state = {
    requests: [] as Array<{ action: string; params: Record<string, unknown> }>,
    notes: new Map<number, { noteId: number; modelName: string; cards: number[] }>(),
    createdInputs: [] as AnkiNoteDraft[],
    writes: 0, readbacks: 0,
    nullIndexes: new Set<number>(),
    rejectIndexes: new Set<number>(),
    rejectValidation: false,
    validationReply: undefined as unknown,
    failPreparation: false,
    beforeCreation: undefined as (() => void) | undefined,
    creationFailure: "" as "" | "network-before" | "network-after" | "action-after" | "timeout-after" | "invalid-json-after",
    creationReply: undefined as unknown,
    readbackFailure: false,
    readbackReply: undefined as unknown,
    missingReadbackIds: new Set<number>(),
  };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { action, params = {} } = JSON.parse(String(init?.body)) as (typeof state.requests)[number];
    state.requests.push({ action, params });
    let result: unknown;
    switch (action) {
      case "deckNamesAndIds":
        if (state.failPreparation) throw new TypeError("Simulated preparation failure");
        result = { Fixture: 1 }; break;
      case "modelNamesAndIds": result = { Basic: 1 }; break;
      case "modelFieldNames": result = ["Front", "Back"]; break;
      case "canAddNotesWithErrorDetail":
        result = state.validationReply === undefined
          ? (params.notes as AnkiNoteDraft[]).map((_draft, index) => ({ canAdd: !state.rejectIndexes.has(index) && !state.rejectValidation, error: "Rejected draft" }))
          : state.validationReply;
        state.beforeCreation?.();
        break;
      case "addNotes": {
        state.writes += 1;
        if (state.creationFailure === "network-before") throw new TypeError("Simulated creation connection failure");
        const drafts = params.notes as AnkiNoteDraft[];
        const ids = drafts.map((draft, index) => {
          if (state.nullIndexes.has(index)) return null;
          const noteId = 100 + (state.writes - 1) * 1000 + index;
          state.createdInputs.push(draft);
          state.notes.set(noteId, { noteId, modelName: draft.modelName, cards: [noteId * 10] });
          return noteId;
        });
        switch (state.creationFailure) {
          case "network-after": throw new TypeError("Simulated lost reply");
          case "action-after": return Response.json({ result: null, error: "Simulated error after partial processing" });
          case "timeout-after": return new Promise<Response>(() => {});
          case "invalid-json-after": return new Response("<html>private-invalid-response</html>");
        }
        result = state.creationReply === undefined ? ids : state.creationReply;
        break;
      }
      case "notesInfo":
        state.readbacks += 1;
        if (state.readbackFailure) throw new TypeError("Simulated readback failure");
        result = state.readbackReply === undefined
          ? (params.notes as number[]).map((id) => state.missingReadbackIds.has(id) ? {} : state.notes.get(id) ?? {})
          : state.readbackReply;
        break;
      default: assert.fail(`Unexpected action ${action}`);
    }
    return Response.json({ result, error: null });
  });
  return state;
}
