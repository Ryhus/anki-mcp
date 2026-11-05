import { z } from "zod";
import type { AnkiNoteDraft, AnkiNoteDraftValidation } from "../notes/note-types.js";
import { v1EntityIdSchema } from "./anki-v1-collection-client.js";
import { AnkiV1Error, ankiV1ErrorSchema, callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

const validationMessages = {
  emptyFirstField: "The first field is empty.",
  duplicate: "A matching Note already exists.",
  missingCloze: "The Note has no cloze deletion.",
  notClozeNoteType: "Cloze markup requires a Cloze Note Type.",
  notClozeField: "Cloze markup is not in a cloze field.",
  emptyQuestions: "All generated questions are empty.",
  unknownField: "A submitted field is not defined by the Note Type.",
  invalidTag: "A submitted tag is invalid.",
} as const;

const validationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ type: z.enum(Object.keys(validationMessages) as (keyof typeof validationMessages)[]) })),
  duplicateNoteIds: z.array(v1EntityIdSchema),
});
const indexSchema = z.number().int().nonnegative();
const validationReplySchema = z.object({
  items: z.array(z.union([
    z.strictObject({ index: indexSchema, result: validationSchema }),
    z.strictObject({ index: indexSchema, error: ankiV1ErrorSchema }),
  ])),
});

/** Maps the existing MCP duplicate policy without changing it. */
function toV1NoteInput({ modelName, deckName, fields, tags, options }: AnkiNoteDraft) {
  const duplicateOptions = options.duplicateScopeOptions;
  return {
    noteType: { name: modelName },
    deck: { name: deckName },
    fields, tags,
    duplicates: {
      allow: options.allowDuplicate,
      scope: options.duplicateScope,
      ...(options.duplicateScope === "deck" ? { deck: { name: duplicateOptions.deckName ?? deckName } } : {}),
      includeChildren: duplicateOptions.checkChildren,
      acrossNoteTypes: duplicateOptions.checkAllModels,
    },
    rejectEmptyQuestions: true,
  };
}

export async function validateV1NoteDrafts(drafts: AnkiNoteDraft[], session: string): Promise<AnkiNoteDraftValidation[]> {
  const method = "notes.validateMany";
  const { items } = await callAnkiV1(method, { notes: drafts.map(toV1NoteInput), session }, validationReplySchema);
  if (items.length !== drafts.length) throw invalidAnkiV1Response(method);
  const ordered = new Map<number, AnkiNoteDraftValidation>();
  for (const item of items) {
    if (item.index >= drafts.length || ordered.has(item.index)) throw invalidAnkiV1Response(method);
    if ("error" in item) {
      ordered.set(item.index, { canAdd: false, error: new AnkiV1Error(method, item.error.code).message });
      continue;
    }
    const { valid, issues } = item.result;
    if (valid !== (issues.length === 0)) throw invalidAnkiV1Response(method);
    ordered.set(item.index, valid
      ? { canAdd: true }
      : { canAdd: false, error: [...new Set(issues.map(({ type }) => validationMessages[type]))].join(" ") });
  }
  return drafts.map((_draft, index) => ordered.get(index)!);
}

/** Keep raw results after envelope validation so malformed items can retain unmapped IDs. */
export function createV1Notes(drafts: AnkiNoteDraft[], session: string): Promise<unknown> {
  return callAnkiV1("notes.createMany", {
    notes: drafts.map(toV1NoteInput), atomic: false, session,
  }, z.unknown());
}
