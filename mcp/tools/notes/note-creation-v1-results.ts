import { z } from "zod";
import { v1EntityIdSchema } from "../../../anki-api/v1/anki-v1-collection-client.js";
import { AnkiV1Error, ankiV1ErrorSchema } from "../../../anki-api/v1/anki-v1-request.js";
import { collectReportedNoteIds, unsuccessfulNoteResults } from "./note-creation-results.js";
import type { NoteCreationResult } from "./note-creation-schemas.js";

const method = "notes.createMany";
const batchSchema = z.object({ items: z.array(z.unknown()) });
const evidenceSchema = z.object({ result: z.object({ noteId: v1EntityIdSchema }) });
const index = z.number().int().nonnegative();
const itemSchema = z.union([
  z.strictObject({ index, result: z.object({ noteId: v1EntityIdSchema, cardIds: z.array(v1EntityIdSchema) }) }),
  z.strictObject({ index, error: ankiV1ErrorSchema }),
]);

/** Correlates indexed acknowledgements, never using the response array order. */
export function interpretV1NoteCreationReply(reply: unknown, inputCount: number) {
  const batch = batchSchema.safeParse(reply);
  const items = batch.success ? batch.data.items : [];
  const evidence = collectReportedNoteIds(reportedIds(items));
  const invalid = () => ({
    ...evidence, valid: false,
    noteResults: unsuccessfulNoteResults(inputCount, "unknown", "Malformed or misaligned notes.createMany reply; input-to-ID associations are unknown."),
  });
  if (items.length !== inputCount) return invalid();

  const rows = new Map<number, NoteCreationResult>();
  const ids = new Set<number>();
  for (const raw of items) {
    const item = itemSchema.safeParse(raw);
    if (!item.success) return invalid();
    const inputIndex = item.data.index;
    if (inputIndex >= inputCount || rows.has(inputIndex)) return invalid();
    if ("result" in item.data) {
      const { noteId } = item.data.result;
      if (ids.has(noteId)) return invalid();
      ids.add(noteId);
      rows.set(inputIndex, {
        inputIndex, status: "created-unverified", noteId, cardIds: null,
        error: "Creation was acknowledged; readback has not been verified.",
      });
    } else {
      const { code } = item.data.error;
      // These codes reject the Note during native lookup/validation. An
      // internal failure can occur after add_note, before building its result.
      const rejected = code === 1001 || code === 1002;
      rows.set(inputIndex, {
        inputIndex, status: rejected ? "not-created" : "unknown", noteId: null, cardIds: null,
        error: rejected ? new AnkiV1Error(method, code).message
          : `The item failed without confirming whether the Note was created. ${new AnkiV1Error(method, code).message}`,
      });
    }
  }
  const noteResults = Array.from({ length: inputCount }, (_, i) => rows.get(i)!);
  return { ...collectReportedNoteIds(noteResults.map(({ noteId }) => noteId)), noteResults, valid: true };
}

function* reportedIds(items: unknown[]): Iterable<number> {
  for (const item of items) {
    const evidence = evidenceSchema.safeParse(item);
    if (evidence.success) yield evidence.data.result.noteId;
  }
}
