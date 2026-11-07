import type { CallToolResult } from "@modelcontextprotocol/server";
import { deleteAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  noteDeletionInputSchema,
  noteDeletionOutputSchema,
  type NoteDeletionInput,
} from "./note-deletion-schemas.js";
import {
  calculateNoteDeletionImpactHash,
  describeNoteDeletionImpact,
  loadNoteDeletionScope,
  verifyNoteDeletion,
} from "./note-deletion-utils.js";

export const deleteNotesAndCardsConfig = {
  title: "Delete notes and cards",
  description:
    "Previews deletion of explicit Note IDs and all their generated Cards. Defaults to dryRun. Applying requires the reviewed impactHash as expectedImpactHash and confirmDeletion: true. Missing Notes or changed profile, Note content, tags, or Card IDs block the entire batch. Successful deletion is verified with native searches. No backup or rollback is created.",
  inputSchema: noteDeletionInputSchema,
  outputSchema: noteDeletionOutputSchema,
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Deletes one fully reviewed batch, never a silently reduced subset of it. */
export async function deleteNotesAndCards({
  noteIds, dryRun, expectedImpactHash, confirmDeletion,
}: NoteDeletionInput): Promise<CallToolResult> {
  const requestedNoteIds = [...new Set(noteIds)];
  const { profileName, notes, missingNoteIds } = await loadNoteDeletionScope(requestedNoteIds);
  const impact = describeNoteDeletionImpact(requestedNoteIds, notes);
  const impactHash = missingNoteIds.length === 0
    ? calculateNoteDeletionImpactHash(profileName, requestedNoteIds, notes) : null;
  const blockers: string[] = [];
  if (missingNoteIds.length > 0) {
    blockers.push(`Requested Notes are missing or could not be loaded: ${missingNoteIds.join(", ")}. No partial batch will be deleted.`);
  }
  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The deletion impact changed after review (profile, Notes, fields, tags, or generated Card IDs). Review a fresh preview before applying.");
  }
  if (!dryRun && (expectedImpactHash === undefined || !confirmDeletion)) {
    blockers.push("Applying requires expectedImpactHash and confirmDeletion: true after the user approves data loss.");
  }
  const result = {
    dryRun, applied: false, verified: false, profileName, impactHash, impact,
    deletedNotes: [], missingNoteIds, blockers,
    warnings: [
      "Deletion removes the Notes, all generated Cards (including those in other decks), and their review history. Media files are not deleted.",
      "No MCP backup or rollback is created. Deletion can propagate to other devices during synchronization.",
      "The hash covers full Note content and Card IDs, not Card scheduling, deck placement, review history, or shared Note Type design.",
      "Preview, comparison, and deletion are not atomic; concurrent edits after the final read can still race. Confirmation flags are not a substitute for user approval.",
    ],
  };
  if (blockers.length > 0 || dryRun) {
    return createToolResult(
      blockers.length > 0
        ? `Deleted no Notes: ${blockers.length} safety blocker${blockers.length === 1 ? "" : "s"} must be resolved.`
        : `Dry run would delete ${impact.noteCount} Notes and ${impact.cardCount} generated Cards. Anki was not changed.`,
      result,
    );
  }

  const existingNoteIds = notes.map(({ noteId }) => noteId);
  const deletedNotes = notes.map((note) => ({
    noteId: note.noteId,
    deletedCardIds: [...new Set(note.cards)].sort((left, right) => left - right),
  }));
  try {
    await deleteAnkiNotes(existingNoteIds);
  } catch (error) {
    throw new Error(
      `Could not confirm deletion for Note IDs: ${existingNoteIds.join(", ")}. Some or all may already be deleted; no automatic retry or rollback was performed. Inspect Anki before retrying. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    await verifyNoteDeletion(profileName, existingNoteIds, deletedNotes.flatMap((note) => note.deletedCardIds));
  } catch (error) {
    throw new Error(
      `Deletion was acknowledged for Note IDs: ${existingNoteIds.join(", ")}, but verification failed. Data may already be deleted; no automatic retry or rollback was performed. Inspect Anki before retrying. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return createToolResult(
    `Deleted ${impact.noteCount} Notes and ${impact.cardCount} generated Cards; native searches verified their absence.`,
    { ...result, applied: true, verified: true, deletedNotes },
  );
}
