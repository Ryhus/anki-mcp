import type { CallToolResult } from "@modelcontextprotocol/server";
import { AnkiRequestError } from "../../../anki-api/anki-request.js";
import { createAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { prepareNoteDrafts, type PreparedNoteDrafts } from "./note-draft-validator.js";
import {
  noteCreationInputSchema,
  noteCreationOutputSchema,
  type NoteCreationInput,
} from "./note-creation-schemas.js";
import {
  creationErrorDetail,
  interpretNoteCreationReply,
  noteCreationToolResult,
  unsuccessfulNoteResults,
} from "./note-creation-results.js";
import { verifyCreatedNotes } from "./note-creation-verification.js";
import { NOTE_BATCH_LIMIT, noteDraftValidationSchema } from "./shared-schemas.js";

export const createNotesConfig = {
  title: "Create notes",
  description:
    "Validates the complete batch before creating Notes, optionally merging existing media references. Returns a status for every input and preserves acknowledged IDs if readback fails. A null createdNoteCount means an unknown creation outcome; null cardIds means unverified readback. Partial/unknown outcomes are errors with structured results. Never blindly resend the whole batch; duplicate checks are not idempotency. No automatic retry or rollback.",
  inputSchema: noteCreationInputSchema,
  outputSchema: noteCreationOutputSchema,
  annotations: NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS,
};

/** Attempts creation once and retains evidence even when the outcome is incomplete. */
export async function createNotes({
  notes,
}: NoteCreationInput): Promise<CallToolResult> {
  if (notes.length === 0 || notes.length > NOTE_BATCH_LIMIT) {
    return noteCreationToolResult(
      unsuccessfulNoteResults(notes.length, "not-attempted", `Use 1 to ${NOTE_BATCH_LIMIT} Notes; no creation was attempted.`), [],
      { executionError: true },
    );
  }
  let prepared: PreparedNoteDrafts;
  try {
    prepared = await prepareNoteDrafts(notes);
    const validations = noteDraftValidationSchema.array().safeParse(prepared.validations);
    if (!validations.success || validations.data.length !== notes.length ||
      validations.data.some((validation, index) => validation.index !== index)) {
      throw new Error("Draft validation returned malformed or misaligned results; no creation was attempted.");
    }
  } catch (error) {
    return noteCreationToolResult(
      unsuccessfulNoteResults(notes.length, "not-attempted", "Draft preparation failed before creation."), [],
      { executionError: true, warnings: [creationErrorDetail(error)] },
    );
  }
  const rejected = prepared.validations.filter(
    ({ canCreate }) => !canCreate,
  );

  if (rejected.length > 0) {
    return noteCreationToolResult(
      unsuccessfulNoteResults(notes.length, "not-attempted", "At least one draft failed validation; the whole batch was withheld."),
      prepared.validations,
    );
  }

  const preparedNotes = prepared.notes.flatMap((note) =>
    note === null ? [] : [note],
  );

  if (preparedNotes.length !== notes.length) {
    return noteCreationToolResult(
      unsuccessfulNoteResults(notes.length, "not-attempted", "Validated drafts could not be prepared consistently; no creation was attempted."),
      prepared.validations, { executionError: true },
    );
  }

  let reply: unknown;
  try {
    reply = await createAnkiNotes(preparedNotes);
  } catch (error) {
    const notSent = error instanceof AnkiRequestError && !error.mayHaveExecuted;
    return noteCreationToolResult(
      unsuccessfulNoteResults(notes.length, notSent ? "not-attempted" : "unknown",
        notSent ? "No creation HTTP request was sent." : "The creation request failed without a trustworthy reply. Some or all Notes may already exist."),
      prepared.validations,
      { executionError: true, warnings: [creationErrorDetail(error)] },
    );
  }
  const interpreted = interpretNoteCreationReply(reply, notes.length);
  const { noteResults, warnings } = interpreted.valid
    ? await verifyCreatedNotes(interpreted.noteResults, preparedNotes)
    : { noteResults: interpreted.noteResults, warnings: ["Reported IDs from the malformed reply are unmapped and were not queried or associated with drafts. They are not safe targets for automatic cleanup."] };
  const validations = prepared.validations.map((validation) =>
    noteResults[validation.index]?.status === "not-created"
      ? { ...validation, canCreate: false, error: "AnkiConnect did not create this note" }
      : validation,
  );
  return noteCreationToolResult(
    noteResults, validations,
    { warnings, reportedNoteIds: interpreted.reportedNoteIds, reportedNoteIdsTruncated: interpreted.reportedNoteIdsTruncated },
  );
}
