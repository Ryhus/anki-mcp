import type { CallToolResult } from "@modelcontextprotocol/server";
import { createToolResult } from "../../utils/tool-result.js";
import { NOTE_BATCH_LIMIT, type NoteDraftValidation } from "./shared-schemas.js";
import { noteCreationOutputSchema, type NoteCreationResult } from "./note-creation-schemas.js";

export const CREATION_RETRY_WARNING =
  "No automatic retry or rollback was performed. Do not resend the whole batch after a partial or unknown outcome; inspect Anki and the known IDs first. Duplicate checks are not an idempotency guarantee.";

/** Keeps bounded ID evidence without treating it as a valid acknowledgement. */
export function collectReportedNoteIds(values: Iterable<unknown>) {
  const reportedNoteIds: number[] = [];
  const seen = new Set<number>();
  let reportedNoteIdsTruncated = false;
  for (const value of values) {
    if (!isNoteId(value) || seen.has(value)) continue;
    if (reportedNoteIds.length === NOTE_BATCH_LIMIT) {
      reportedNoteIdsTruncated = true;
      break;
    }
    seen.add(value);
    reportedNoteIds.push(value);
  }
  return { reportedNoteIds, reportedNoteIdsTruncated };
}

/** Validates positional IDs without inventing associations from a broken reply. */
export function interpretNoteCreationReply(reply: unknown, inputCount: number) {
  const evidence = collectReportedNoteIds(Array.isArray(reply) ? reply : []);
  const valid = Array.isArray(reply) && reply.length === inputCount &&
    reply.every((id: unknown) => id === null || isNoteId(id)) &&
    reply.filter((id: unknown) => id !== null).length === evidence.reportedNoteIds.length;
  const noteResults: NoteCreationResult[] = valid
    ? reply.map((id: number | null, inputIndex: number): NoteCreationResult => id === null
      ? { inputIndex, status: "not-created", noteId: null, cardIds: null, error: "AnkiConnect did not create this Note after validation." }
      : { inputIndex, status: "created-unverified", noteId: id, cardIds: null, error: "Creation was acknowledged; readback has not been verified." })
    : unsuccessfulNoteResults(inputCount, "unknown", "Malformed or misaligned addNotes reply; input-to-ID associations are unknown.");
  return { noteResults, ...evidence, valid };
}

export function unsuccessfulNoteResults(
  count: number, status: "not-attempted" | "unknown", error: string,
): NoteCreationResult[] {
  return Array.from({ length: count }, (_, inputIndex) => ({ inputIndex, status, noteId: null, cardIds: null, error }));
}

/** Preserves creation evidence in both structured data and legacy text content. */
export function noteCreationToolResult(
  noteResults: NoteCreationResult[],
  validations: NoteDraftValidation[],
  options: {
    warnings?: string[];
    reportedNoteIds?: number[];
    reportedNoteIdsTruncated?: boolean;
    executionError?: boolean;
  } = {},
): CallToolResult {
  const created = noteResults.filter((row) => row.status === "created" || row.status === "created-unverified");
  const outcome = noteResults.some(({ status }) => status === "unknown") ? "unknown"
    : noteResults.every(({ status }) => status === "not-attempted") ? "not-attempted"
    : noteResults.every(({ status }) => status === "created") ? "complete" : "incomplete";
  const failed = outcome === "unknown" || outcome === "incomplete" || options.executionError === true;
  const warnings = [...(options.warnings ?? [])];
  if (outcome === "unknown" || outcome === "incomplete") warnings.push(CREATION_RETRY_WARNING);
  const result = noteCreationOutputSchema.parse({
    outcome,
    createdNoteCount: outcome === "unknown" ? null : created.length,
    createdNotes: created.map((row) => ({ inputIndex: row.inputIndex, noteId: row.noteId, cardIds: row.cardIds, verified: row.status === "created" })),
    noteResults,
    reportedNoteIds: options.reportedNoteIds ?? [],
    reportedNoteIdsTruncated: options.reportedNoteIdsTruncated ?? false,
    validations, warnings,
  });
  const summary = outcome === "unknown"
    ? "Creation outcome is unknown; the created Note count is not known. Inspect Anki before resubmitting."
    : outcome === "not-attempted"
      ? "Created no Notes: creation was not attempted."
      : `Anki acknowledged creation of ${created.length} of ${noteResults.length} Notes; readback verified ${noteResults.filter(({ status }) => status === "created").length}.`;
  const response = createToolResult(summary, result);
  response.content.push({ type: "text", text: JSON.stringify(result) });
  return failed ? { ...response, isError: true } : response;
}

export function creationErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "Unknown AnkiConnect failure";
}

function isNoteId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
