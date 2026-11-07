import type { CallToolResult } from "@modelcontextprotocol/server";
import { convertNotesV1, openNoteConversion } from "../../../anki-api/notes/note-conversion-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { prepareNoteConversion } from "./note-conversion-plan.js";
import { noteConversionInputSchema, noteConversionOutputSchema, type NoteConversionInput } from "./note-conversion-schemas.js";
import { verifyNoteConversion } from "./note-conversion-verification.js";

export const convertNotesToNoteTypeConfig = {
  title: "Convert notes to another Note Type",
  description: "Previews moving explicit existing Notes to another Normal Note Type. Review target-to-source field and template maps, preserved/removed Card IDs, and possible new Cards. Apply only with the reviewed hash and confirmations. Does not duplicate Notes. Requires AnkiConnect v1.",
  inputSchema: noteConversionInputSchema,
  outputSchema: noteConversionOutputSchema,
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function convertNotesToNoteType(input: NoteConversionInput): Promise<CallToolResult> {
  const ctx = await openNoteConversion();
  const { plan, preview } = await prepareNoteConversion(ctx, input);
  const blockers = [...preview.blockers];
  const impact = preview.impact;
  if (input.expectedImpactHash !== undefined && input.expectedImpactHash !== preview.impactHash) {
    blockers.push("The reviewed Note, Card, or schema snapshot changed. Preview the conversion again.");
  }
  if (!input.dryRun) {
    if (!input.confirmConversion || input.expectedImpactHash === undefined) {
      blockers.push("Applying requires confirmConversion: true and the reviewed expectedImpactHash.");
    }
    if (impact !== null && (impact.droppedNonEmptyFieldValueCount > 0 || impact.removedCardCount > 0) && !input.confirmDataLoss) {
      blockers.push("Nonempty field values or existing Cards would be discarded; confirmDataLoss is required.");
    }
    if (impact !== null && impact.possibleNewCardCount > 0 && !input.confirmCardCreation) {
      blockers.push("Anki may generate new Cards; confirmCardCreation is required.");
    }
  }
  const result = { ...preview, dryRun: input.dryRun, applied: false, verified: false, blockers, convertedNotes: [] };
  if (input.dryRun || blockers.length > 0 || plan === null) {
    return createToolResult(
      blockers.length > 0 ? "No Notes were converted; resolve the conversion blockers."
        : `Dry run: reviewed ${impact?.noteCount ?? 0} Note(s). Anki was not changed.`, result,
    );
  }

  const ids = plan.notes.map(({ id }) => id);
  let acknowledged = false;
  try {
    await convertNotesV1(ctx, ids, plan.target.id, plan.fields, plan.templates, plan.token);
    acknowledged = true;
    const convertedNotes = await verifyNoteConversion(ctx, plan);
    return createToolResult(
      `Converted and verified ${convertedNotes.length} Note(s) as "${plan.target.name}" without changing their Note IDs.`,
      { ...result, applied: true, verified: true, convertedNotes },
    );
  } catch (error) {
    const status = acknowledged ? "Anki acknowledged the conversion, but readback did not verify it." : "The conversion could not be confirmed.";
    throw new Error(`${status} Note IDs: ${ids.join(", ")}. Data may already have changed; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`, { cause: error });
  }
}
