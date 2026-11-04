import { z } from "zod";
import { getAnkiNotesInfo } from "../../../anki-api/notes/note-client.js";
import type { AnkiNoteDraft } from "../../../anki-api/notes/note-types.js";
import { createdCardIdsSchema, type NoteCreationResult } from "./note-creation-schemas.js";
import { creationErrorDetail } from "./note-creation-results.js";
import { noteIdSchema } from "./shared-schemas.js";

const readbackSchema = z.object({
  noteId: noteIdSchema,
  modelName: z.string(),
  cards: createdCardIdsSchema,
});

/**
 * Verifies ID, Note Type, and readable Card IDs, not exact field/tag contents.
 * Read failures never erase the IDs already acknowledged by addNotes.
 */
export async function verifyCreatedNotes(
  rows: NoteCreationResult[], drafts: AnkiNoteDraft[],
): Promise<{ noteResults: NoteCreationResult[]; warnings: string[] }> {
  const pending = rows.filter((row) => row.status === "created-unverified");
  if (pending.length === 0) return { noteResults: rows, warnings: [] };
  const ids = pending.map(({ noteId }) => noteId);
  let reply: unknown;
  try {
    reply = await getAnkiNotesInfo(ids);
  } catch (error) {
    return { noteResults: rows, warnings: [`Creation was acknowledged, but readback failed. Notes may already exist. ${creationErrorDetail(error)}`] };
  }
  if (!Array.isArray(reply)) {
    return { noteResults: rows, warnings: ["Creation was acknowledged, but notesInfo returned a malformed result. Known Note IDs are retained."] };
  }
  const requested = new Set(ids);
  const byId = new Map<number, z.infer<typeof readbackSchema>>();
  const seenIds = new Set<number>();
  for (const raw of reply) {
    if (typeof raw === "object" && raw !== null && "noteId" in raw && typeof raw.noteId === "number") {
      if (!requested.has(raw.noteId) || seenIds.has(raw.noteId)) {
        return { noteResults: rows, warnings: ["Creation was acknowledged, but readback contained unexpected or duplicate Note IDs. Known creation IDs are retained; readback was not trusted."] };
      }
      seenIds.add(raw.noteId);
    }
    const parsed = readbackSchema.safeParse(raw);
    if (parsed.success) byId.set(parsed.data.noteId, parsed.data);
  }
  const cardOwners = new Map<number, number>();
  const ambiguous = new Set<number>();
  for (const note of byId.values()) {
    for (const cardId of note.cards) {
      const owner = cardOwners.get(cardId);
      if (owner !== undefined && owner !== note.noteId) {
        ambiguous.add(owner);
        ambiguous.add(note.noteId);
      }
      cardOwners.set(cardId, note.noteId);
    }
  }
  const noteResults = rows.map((row): NoteCreationResult => {
    if (row.status !== "created-unverified") return row;
    const note = byId.get(row.noteId);
    if (note === undefined || ambiguous.has(row.noteId) || note.modelName !== drafts[row.inputIndex]?.modelName) {
      return { ...row, error: "Creation was acknowledged, but Note ID, Note Type, or generated Card data could not be verified. The Note may have changed or disappeared after creation." };
    }
    return { inputIndex: row.inputIndex, status: "created", noteId: row.noteId, cardIds: note.cards, error: null };
  });
  return {
    noteResults,
    warnings: noteResults.some(({ status }) => status === "created-unverified")
      ? ["Some acknowledged Notes could not be read back reliably. Their IDs are retained; null cardIds does not mean they have no Cards."] : [],
  };
}
