import { isDeepStrictEqual } from "node:util";
import type { V1AdapterContext } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { getV1Cards } from "../../../anki-api/v1/anki-v1-cards-adapter.js";
import { getV1Notes } from "../../../anki-api/v1/anki-v1-note-client.js";
import { mappedFieldValues, type PreparedConversion } from "./note-conversion-plan.js";
import { CONVERSION_CARD_LIMIT, type NoteConversionOutput } from "./note-conversion-schemas.js";

/** Confirms original Note IDs, exact fields, and old/new Card identities. */
export async function verifyNoteConversion(
  ctx: V1AdapterContext, plan: PreparedConversion,
): Promise<NoteConversionOutput["convertedNotes"]> {
  const ids = plan.notes.map(({ id }) => id);
  const { notes, missingNoteIds } = await getV1Notes(ids, ctx.session, ctx.options);
  if (missingNoteIds.length > 0) throw new Error(`Converted Note IDs could not be loaded: ${missingNoteIds.join(", ")}.`);
  const before = new Map(plan.notes.map((note) => [note.id, note]));
  const afterCardIds = notes.flatMap(({ cardIds }) => cardIds);
  if (afterCardIds.length > CONVERSION_CARD_LIMIT || new Set(afterCardIds).size !== afterCardIds.length) {
    throw new Error("Converted Notes reported excessive or duplicate Card IDs.");
  }
  const removed = new Set(plan.removed.map(({ id }) => id));
  const afterIds = new Set(afterCardIds);
  if ([...plan.preserved.keys()].some((id) => !afterIds.has(id)) || [...removed].some((id) => afterIds.has(id))) {
    throw new Error("The saved Card IDs do not match the reviewed preservation and removal plan.");
  }
  const queryIds = [...afterCardIds, ...removed];
  const cards = await getV1Cards(ctx, queryIds, true);
  const byId = new Map(cards.flatMap((card) => card === null ? [] : [[card.id, card] as const]));
  if (afterCardIds.some((id) => !byId.has(id)) || [...removed].some((id) => byId.has(id))) {
    throw new Error("At least one expected Card is unreadable or a removed Card still exists.");
  }
  for (const [id, { card: old, targetIndex }] of plan.preserved) {
    const saved = byId.get(id);
    if (saved === undefined || saved.noteId !== old.noteId || saved.templateIndex !== targetIndex ||
        saved.deck.id !== old.deck.id || saved.homeDeck !== null || saved.flags !== old.flags ||
        !isDeepStrictEqual(saved.scheduling, old.scheduling)) {
      throw new Error(`Preserved Card ${id} did not match its reviewed template, placement, or scheduling state.`);
    }
  }

  return notes.map((note) => {
    const old = before.get(note.id)!;
    const expected = mappedFieldValues(old, plan.fields);
    if (note.noteType.id !== plan.target.id || note.noteType.name !== plan.target.name ||
        !isDeepStrictEqual(note.fields, expected) || !isDeepStrictEqual([...note.tags].sort(), [...old.tags].sort())) {
      throw new Error(`Note ${note.id} did not match the target type, mapped field values, or original tags.`);
    }
    const ordinals = new Set<number>();
    for (const id of note.cardIds) {
      const card = byId.get(id)!;
      if (card.noteId !== note.id || ordinals.has(card.templateIndex) || !plan.target.templates[card.templateIndex]) {
        throw new Error(`Unexpected Card ownership or template ordinal for Note ${note.id}.`);
      }
      ordinals.add(card.templateIndex);
    }
    return {
      noteId: note.id,
      preservedCardIds: note.cardIds.filter((id) => plan.preserved.has(id)).sort((a, b) => a - b),
      removedCardIds: old.cardIds.filter((id) => removed.has(id)).sort((a, b) => a - b),
      newCardIds: note.cardIds.filter((id) => !plan.preserved.has(id)).sort((a, b) => a - b),
    };
  });
}
