import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { prepareNoteDrafts } from "./note-draft-validator.js";
import { loadNotes } from "./note-loader.js";
import {
  NOTE_BATCH_LIMIT,
  noteDraftSchema,
  noteDraftValidationSchema,
  noteIdSchema,
} from "./shared-schemas.js";

const createNotesInputSchema = z.object({
  notes: z
    .array(noteDraftSchema)
    .min(1)
    .max(NOTE_BATCH_LIMIT)
    .describe("One or more notes to validate and create as one batch"),
});

type CreateNotesInput = z.infer<typeof createNotesInputSchema>;

const createdNoteSchema = z.object({
  inputIndex: z.number().int().nonnegative(),
  noteId: noteIdSchema,
  cardIds: z.array(z.number().int().positive()),
});

export const createNotesConfig = {
  title: "Create notes",
  description:
    "Validates and creates one or more Anki notes. Duplicate creation is disabled by default, and successful results include generated card IDs.",
  inputSchema: createNotesInputSchema,
  outputSchema: z.object({
    createdNoteCount: z.number().int().nonnegative(),
    createdNotes: z.array(createdNoteSchema),
    validations: z.array(noteDraftValidationSchema),
  }),
  annotations: NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS,
};

/** Validates a complete batch before creating any notes. */
export async function createNotes({
  notes,
}: CreateNotesInput): Promise<CallToolResult> {
  const prepared = await prepareNoteDrafts(notes);
  const rejected = prepared.validations.filter(
    ({ canCreate }) => !canCreate,
  );

  if (rejected.length > 0) {
    return createToolResult(
      `Created no notes because ${rejected.length} of ${notes.length} draft${notes.length === 1 ? "" : "s"} failed validation.`,
      {
        createdNoteCount: 0,
        createdNotes: [],
        validations: prepared.validations,
      },
    );
  }

  const preparedNotes = prepared.notes.flatMap((note) =>
    note === null ? [] : [note],
  );

  if (preparedNotes.length !== notes.length) {
    throw new Error("Validated note drafts could not be prepared");
  }

  const createdIds = await createAnkiNotes(preparedNotes);

  if (createdIds.length !== notes.length) {
    throw new Error("AnkiConnect returned misaligned created note IDs");
  }

  const existingCreatedIds = createdIds.flatMap((noteId) =>
    noteId === null ? [] : [noteId],
  );
  const { notes: createdNoteInfo, missingNoteIds } =
    await loadNotes(existingCreatedIds);

  if (missingNoteIds.length > 0) {
    throw new Error(
      `AnkiConnect could not reload created note IDs: ${missingNoteIds.join(", ")}`,
    );
  }

  const createdInfoById = new Map(
    createdNoteInfo.map((note) => [note.noteId, note]),
  );
  const validations = prepared.validations.map((validation) => {
    const createdId = createdIds[validation.index];

    return createdId === null
      ? {
          ...validation,
          canCreate: false,
          error: "AnkiConnect did not create this note",
        }
      : validation;
  });
  const createdNotes = createdIds.flatMap((noteId, inputIndex) => {
    if (noteId === null) {
      return [];
    }

    const noteInfo = createdInfoById.get(noteId);

    if (noteInfo === undefined) {
      throw new Error(`AnkiConnect omitted created note ${noteId}`);
    }

    return [{ inputIndex, noteId, cardIds: noteInfo.cards }];
  });

  return createToolResult(
    `Created ${createdNotes.length} of ${notes.length} requested note${notes.length === 1 ? "" : "s"}.`,
    {
      createdNoteCount: createdNotes.length,
      createdNotes,
      validations,
    },
  );
}
