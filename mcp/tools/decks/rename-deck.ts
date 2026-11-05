import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  deckNameKey, listManagedDecks, openDeckManagement, renameManagedDeck, type ManagedDeck,
} from "../../../anki-api/decks/deck-management-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckIdSchema, deckNameSchema } from "./shared-schemas.js";

const impactLimit = 100;
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const inputSchema = z.object({
  name: deckNameSchema.max(1_000).describe("Exact current full deck path"),
  newName: deckNameSchema.max(1_000).refine(
    (name) => name.split("::").every((part) => part.length > 0 && part.trim() === part && !/[:\u0000-\u001f\u007f]/u.test(part)),
    "Use nonempty trimmed path components separated by ::, with no control characters or single colons",
  ).transform((name) => name.normalize("NFC")).describe("New full path; the destination parent must already exist"),
  dryRun: z.boolean().default(true),
  expectedImpactHash: hashSchema.optional().describe("Impact hash from the reviewed rename preview"),
  confirmRename: z.boolean().default(false),
});

const changeSchema = z.object({ deckId: deckIdSchema, beforeName: z.string(), afterName: z.string() });

export const renameDeckConfig = {
  title: "Rename or move a deck",
  description: "Previews a native Anki deck rename or move under an existing parent. Preserves deck and card identity, reviews descendant paths, and requires the impact hash and explicit confirmation before applying. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(),
    deckId: deckIdSchema.nullable(), impactHash: hashSchema.nullable(),
    changeCount: z.number().int().nonnegative(), changes: z.array(changeSchema).max(impactLimit),
    blockers: z.array(z.string()), warnings: z.array(z.string()),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export function planDeckRename(profile: string, decks: ManagedDeck[], name: string, newName: string) {
  const source = decks.find((deck) => deck.name === name);
  const blockers: string[] = [];
  const separator = newName.lastIndexOf("::");
  const parentName = separator === -1 ? null : newName.slice(0, separator);
  const parent = parentName === null ? undefined : decks.find((deck) => deck.name === parentName);
  if (source === undefined) blockers.push("The source deck was not found by exact full name.");
  if (parentName !== null && parent === undefined) blockers.push("The destination parent must already exist with that exact full name.");
  if (parent?.kind === "filtered") blockers.push("A filtered deck cannot be the destination parent.");
  const prefix = deckNameKey(name) + "::";
  if (deckNameKey(newName).startsWith(prefix)) blockers.push("A deck cannot move into its own subtree.");
  const scope = source === undefined ? [] : decks
    .filter((deck) => deck.id === source.id || deckNameKey(deck.name).startsWith(prefix))
    .sort((a, b) => a.id - b.id);
  const scopeIds = new Set(scope.map(({ id }) => id));
  const occupied = new Set(decks.filter(({ id }) => !scopeIds.has(id)).map(({ name }) => deckNameKey(name)));
  const pathDepth = name.split("::").length;
  const targets = scope.map((deck) => ({
    deck, afterName: [newName, ...deck.name.split("::").slice(pathDepth)].join("::"),
  }));
  if (targets.some(({ afterName }) => occupied.has(deckNameKey(afterName)))) {
    blockers.push("At least one destination path is already occupied by another deck.");
  }
  if (targets.some(({ afterName }) => afterName.length > 1_000)) blockers.push("A destination path exceeds the tool's length limit.");
  if (targets.length > impactLimit) blockers.push(`The subtree exceeds the review limit of ${impactLimit} decks.`);
  const changes = targets.filter(({ deck, afterName }) => deck.name !== afterName)
    .map(({ deck, afterName }) => ({ deckId: deck.id, beforeName: deck.name, afterName }));
  const impactHash = blockers.length === 0
    ? createHash("sha256").update(JSON.stringify({ version: 1, profile, source: source!.id, parent: parent ?? null, targets })).digest("hex")
    : null;
  return { source, parent, targets, changes, blockers, impactHash };
}

export async function renameDeck(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("decks.update");
  const plan = planDeckRename(ctx.profile, await listManagedDecks(ctx), input.name, input.newName);
  const blockers = [...plan.blockers];
  if (input.expectedImpactHash !== undefined && input.expectedImpactHash !== plan.impactHash) {
    blockers.push("The rename impact changed since the preview. Review a fresh preview.");
  }
  if (!input.dryRun && (!input.confirmRename || input.expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmRename: true and the reviewed expectedImpactHash.");
  }
  const result = {
    dryRun: input.dryRun, applied: false, verified: false, deckId: plan.source?.id ?? null,
    impactHash: plan.impactHash, changeCount: plan.changes.length, changes: plan.changes.slice(0, impactLimit), blockers,
    warnings: ["Changes affect the listed paths, not the IDs of decks or their cards. Preview and apply are separate; concurrent edits can race with the final rename."],
  };
  if (blockers.length > 0 || input.dryRun) {
    return createToolResult(blockers.length > 0 ? "No deck paths changed; resolve the rename blockers."
      : `Dry run: ${plan.changes.length} deck path(s) would change.`, result);
  }
  if (plan.changes.length === 0) return createToolResult("The deck already has the requested path.", { ...result, verified: true });

  const id = plan.source!.id;
  try {
    await renameManagedDeck(ctx, id, input.newName);
    const after = new Map((await listManagedDecks(ctx)).map((deck) => [deck.id, deck]));
    if (plan.targets.some(({ deck, afterName }) => {
      const saved = after.get(deck.id);
      return saved?.name !== afterName || saved.kind !== deck.kind || saved.presetId !== deck.presetId;
    }) || (plan.parent !== undefined && after.get(plan.parent.id)?.name !== plan.parent.name)) {
      throw new Error("Saved paths, deck kinds, or preset assignments do not match the preview.");
    }
  } catch (error) {
    throw new Error(`Could not confirm the rename of deck ${id}. It may already have changed; inspect current paths before retrying. No rollback was performed. ${error instanceof Error ? error.message : "Unknown error."}`, { cause: error });
  }
  return createToolResult(`Renamed the deck and verified ${plan.changes.length} changed path(s).`, { ...result, applied: true, verified: true });
}
