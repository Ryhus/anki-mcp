import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  addAnkiNoteTags,
  removeAnkiNoteTags,
} from "../../../anki-api/notes/note-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNotes } from "./note-loader.js";
import {
  noteIdSchema,
  noteMutationIdListSchema,
  noteTagListSchema,
} from "./shared-schemas.js";
import { unique } from "./note-utils.js";

const editNoteTagsInputSchema = z
  .object({
    noteIds: noteMutationIdListSchema,
    add: noteTagListSchema
      .default([])
      .describe("Tags to add while preserving every other existing tag"),
    remove: noteTagListSchema
      .default([])
      .describe("Tags to remove while preserving every other existing tag"),
  })
  .superRefine(({ add, remove }, context) => {
    if (add.length === 0 && remove.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one tag must be added or removed",
      });
    }

    const tagsInBoth = unique(add).filter((tag) => remove.includes(tag));

    if (tagsInBoth.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Tags cannot be added and removed in the same request: ${tagsInBoth.join(", ")}`,
      });
    }
  });

type EditNoteTagsInput = z.infer<typeof editNoteTagsInputSchema>;

const noteTagChangeSchema = z.object({
  noteId: noteIdSchema,
  addedTags: z.array(z.string()),
  removedTags: z.array(z.string()),
});

export const editNoteTagsConfig = {
  title: "Edit note tags",
  description:
    "Adds and removes selected tags on existing notes without replacing their complete tag lists.",
  inputSchema: editNoteTagsInputSchema,
  outputSchema: z.object({
    applied: z.boolean(),
    changes: z.array(noteTagChangeSchema),
    missingNoteIds: z.array(noteIdSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Applies an idempotent tag patch after validating every requested note ID. */
export async function editNoteTags({
  noteIds,
  add,
  remove,
}: EditNoteTagsInput): Promise<CallToolResult> {
  const uniqueNoteIds = unique(noteIds);
  const tagsToAdd = unique(add);
  const tagsToRemove = unique(remove);
  const { notes, missingNoteIds } = await loadNotes(uniqueNoteIds);

  if (missingNoteIds.length > 0) {
    return createToolResult(
      `Applied no tag changes because ${missingNoteIds.length} note ID${missingNoteIds.length === 1 ? " was" : "s were"} not found.`,
      { applied: false, changes: [], missingNoteIds },
    );
  }

  const changes = notes.map((note) => ({
    noteId: note.noteId,
    addedTags: tagsToAdd.filter((tag) => !note.tags.includes(tag)),
    removedTags: tagsToRemove.filter((tag) => note.tags.includes(tag)),
  }));

  if (changes.some(({ addedTags }) => addedTags.length > 0)) {
    await addAnkiNoteTags(uniqueNoteIds, tagsToAdd.join(" "));
  }

  if (changes.some(({ removedTags }) => removedTags.length > 0)) {
    await removeAnkiNoteTags(uniqueNoteIds, tagsToRemove.join(" "));
  }

  const changedNoteCount = changes.filter(
    ({ addedTags, removedTags }) =>
      addedTags.length > 0 || removedTags.length > 0,
  ).length;

  return createToolResult(
    `Updated tags on ${changedNoteCount} note${changedNoteCount === 1 ? "" : "s"}; ${changes.length - changedNoteCount} already had the requested tag state.`,
    { applied: true, changes, missingNoteIds: [] },
  );
}
