import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { AnkiRequestError } from "../../../anki-api/anki-request-error.js";
import { openV1Adapter } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { getV1Notes, replaceV1NoteTag } from "../../../anki-api/v1/anki-v1-note-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { NOTE_TAG_BATCH_LIMIT, noteIdSchema, noteMutationIdListSchema, noteTagSchema } from "./shared-schemas.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const tagNameSchema = noteTagSchema.refine(
  (tag) => !/[\p{Cc}\p{Cs}]/u.test(tag) && tag.split("::").every((part) => part.length > 0),
  "Use one tag with no control characters, invalid Unicode, or empty hierarchy components.",
).transform((tag) => tag.normalize("NFC"));

// The native replace method matches a whole tag using lowercased names.
const tagKey = (tag: string) => tag.toLowerCase();

const inputSchema = z.strictObject({
  noteIds: noteMutationIdListSchema.describe(`Explicit selection of up to ${NOTE_TAG_BATCH_LIMIT} Note IDs. No collection-wide option.`),
  from: tagNameSchema.describe("Full existing tag name to replace. Not a prefix or search query."),
  to: tagNameSchema.describe("One replacement tag name. Anki may reuse registered casing."),
  dryRun: z.boolean().default(true).describe("Preview without modifying Anki"),
  expectedImpactHash: hashSchema.optional().describe("Hash from the reviewed replacement preview"),
  confirmReplacement: z.boolean().default(false),
}).refine(({ from, to }) => tagKey(from) !== tagKey(to), {
  path: ["to"], message: "The replacement must differ from the source beyond capitalization.",
});

const changeSchema = z.object({
  noteId: noteIdSchema,
  removes: z.array(z.string()),
  targetAlreadyPresent: z.boolean(),
});

export const replaceNoteTagConfig = {
  title: "Replace a tag on selected notes",
  description: "Previews replacing one whole tag on explicit Note IDs. Notes without the source tag are skipped. Does not recursively rename child tags, change unrelated tags, or apply to the whole collection. Requires AnkiConnect v1 and explicit confirmation of the reviewed preview to write.",
  inputSchema,
  outputSchema: z.object({
    from: z.string(),
    to: z.string(),
    dryRun: z.boolean(),
    applied: z.boolean(),
    verified: z.boolean(),
    impactHash: hashSchema.nullable(),
    changes: z.array(changeSchema).max(NOTE_TAG_BATCH_LIMIT),
    skippedNoteIds: z.array(noteIdSchema).max(NOTE_TAG_BATCH_LIMIT),
    missingNoteIds: z.array(noteIdSchema).max(NOTE_TAG_BATCH_LIMIT),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function replaceNoteTag({
  noteIds, from, to, dryRun, expectedImpactHash, confirmReplacement,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  if (!useAnkiV1("tags.replace")) {
    throw new AnkiRequestError("configuration", "tags.replace", "Tag replacement requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  const ids = [...new Set(noteIds)].sort((a, b) => a - b);
  const { notes, missingNoteIds } = await getV1Notes(ids, ctx.session, ctx.options);
  const fromKey = tagKey(from);
  const toKey = tagKey(to);
  const changes: z.infer<typeof changeSchema>[] = [];
  const skippedNoteIds: number[] = [];
  const expectedUnrelatedTags = new Map<number, string[]>();
  for (const { id, tags } of notes) {
    const removes = tags.filter((tag) => tagKey(tag) === fromKey).sort();
    if (removes.length === 0) {
      skippedNoteIds.push(id);
      continue;
    }
    changes.push({ noteId: id, removes, targetAlreadyPresent: tags.some((tag) => tagKey(tag) === toKey) });
    expectedUnrelatedTags.set(id, tags.filter((tag) => {
      const key = tagKey(tag);
      return key !== fromKey && key !== toKey;
    }).sort());
  }
  const impactHash = missingNoteIds.length === 0
    ? createHash("sha256").update(JSON.stringify([
      "replace-note-tag", 1, ctx.session, from, to, notes.map(({ id, tags }) => [id, [...tags].sort()]),
    ])).digest("hex") : null;
  const blockers: string[] = [];
  if (missingNoteIds.length > 0) blockers.push("At least one selected Note was not found. No partial replacement is allowed.");
  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The reviewed selection, tags, or collection session changed. Preview the replacement again.");
  }
  if (!dryRun && (!confirmReplacement || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmReplacement: true and the reviewed expectedImpactHash.");
  }
  const result = {
    from, to, dryRun, applied: false, verified: false, impactHash, changes, skippedNoteIds, missingNoteIds, blockers,
    warnings: [
      "Anki can keep registered tag casing. This does not rename or remove entries in the collection's tag list.",
      "Preview and apply are separate; concurrent changes can race with the final replacement.",
    ],
  };
  if (blockers.length > 0) return createToolResult("No tags changed; resolve the replacement blockers.", result);
  if (dryRun) return createToolResult(`Dry run: ${changes.length} Note(s) would change. Anki was not modified.`, result);
  if (changes.length === 0) return createToolResult("None of the selected Notes has the source tag.", { ...result, verified: true });

  try {
    const changedIds = changes.map(({ noteId }) => noteId);
    await replaceV1NoteTag(ctx, changedIds, from, to);
    const saved = await getV1Notes(changedIds, ctx.session, ctx.options);
    if (saved.missingNoteIds.length > 0 || saved.notes.some(({ id, tags }) => {
      const targetTags = tags.filter((tag) => tagKey(tag) === toKey);
      const unrelated = tags.filter((tag) => tagKey(tag) !== toKey).sort();
      const expected = expectedUnrelatedTags.get(id)!;
      return targetTags.length !== 1 || unrelated.length !== expected.length ||
        unrelated.some((tag, index) => tag !== expected[index]);
    })) throw new Error("Readback did not verify the replacement and preservation of unrelated tags.");
  } catch (error) {
    throw new Error(
      `Could not confirm the tag replacement. Tags may already have changed; inspect the selected Notes before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  return createToolResult(`Replaced the tag and verified ${changes.length} changed Note(s).`, {
    ...result, applied: true, verified: true,
  });
}
