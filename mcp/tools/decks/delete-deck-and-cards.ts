import type { CallToolResult } from "@modelcontextprotocol/server";
import { deleteAnkiDeck } from "../../../anki-api/decks/deck-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckDeletionInputSchema, deckDeletionOutputSchema, type DeckDeletionInput } from "./deck-deletion-schemas.js";
import { loadDeckDeletionScope } from "./deck-deletion-scope.js";
import { calculateDeckDeletionImpactHash, describeDeckDeletionImpact } from "./deck-deletion-impact.js";
import { verifyDeckDeletion } from "./deck-deletion-verification.js";

export const deleteDeckAndCardsConfig = {
  title: "Delete deck and cards",
  description:
    "Previews deletion of one normal deck and all descendants. Applying requires dryRun: false, the reviewed impactHash as expectedImpactHash, and confirmDeletion: true. Changed deck identities, Card placement, or Note data block deletion. Default/filtered decks, borrowed-out Cards, incomplete data, and excessive impact are blocked. Surviving sibling Cards in other decks are preserved and verified. No backup or rollback is created.",
  inputSchema: deckDeletionInputSchema,
  outputSchema: deckDeletionOutputSchema,
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Deletes only a complete, unchanged, explicitly approved normal-deck subtree. */
export async function deleteDeckAndCards({
  name, dryRun, expectedImpactHash, confirmDeletion,
}: DeckDeletionInput): Promise<CallToolResult> {
  const scope = await loadDeckDeletionScope(name);
  const impactComplete = scope.blockers.length === 0 && scope.notes !== null;
  const impactHash = impactComplete ? calculateDeckDeletionImpactHash(scope) : null;
  const blockers = [...scope.blockers];
  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The deck deletion impact changed after review; inspect a fresh preview before applying.");
  }
  if (!dryRun && (expectedImpactHash === undefined || !confirmDeletion)) {
    blockers.push("Applying requires expectedImpactHash and confirmDeletion: true after user approval.");
  }
  if (!impactComplete && blockers.length === 0) blockers.push("A complete deck deletion impact is required.");
  const impact = describeDeckDeletionImpact(scope);
  const result = {
    dryRun, applied: false, verified: false, exists: scope.deck !== null,
    profileName: scope.profileName, deck: scope.deck, impactComplete, impactHash, impact,
    deletedDeck: null, deletedDecks: [], deletedCards: false, blockers,
    warnings: [
      "Deletion includes every descendant deck and its Cards/review history. Notes disappear only if no sibling Cards remain elsewhere. Media files and shared Note Types are not deleted.",
      "Only normal decks are supported. Default (ID 1), filtered/unknown deck kinds, and Cards borrowed into filtered decks are blocked; return borrowed Cards before retrying.",
      "The hash covers deck IDs/names, current Card placement, and complete affected Note data/Card IDs, not scheduling, review logs, shared Note Type design, or deck option settings.",
      "Read, compare, and deletion are not atomic. No MCP backup, automatic retry, or rollback is provided; confirmation flags do not prove user approval.",
    ],
  };
  if (dryRun || blockers.length) {
    return createToolResult(blockers.length
      ? `Deleted no decks: ${blockers.length} safety blocker(s) must be resolved.`
      : `Dry run would delete ${impact.deckCount} deck(s), ${impact.cardCount} Cards, and ${impact.deletedNoteCount} orphaned Notes; ${impact.survivingNoteCount} Notes keep sibling Cards elsewhere.`, result);
  }
  try {
    await deleteAnkiDeck(scope.deck!.name);
  } catch (error) {
    throw new Error(`Could not confirm deletion of deck "${name}" (ID ${scope.deck!.id}). Some data may already be deleted; inspect Anki before retrying. No automatic retry or rollback was performed. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    await verifyDeckDeletion(scope);
  } catch (error) {
    throw new Error(`Deck deletion was acknowledged for "${name}" (ID ${scope.deck!.id}), but verification failed. Data may already be deleted; inspect Anki before retrying. No automatic retry or rollback was performed. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return createToolResult(`Deleted and verified ${impact.deckCount} deck(s) and ${impact.cardCount} Cards; sibling Cards outside the subtree were preserved.`, {
    ...result, applied: true, verified: true, deletedDeck: scope.deck,
    deletedDecks: scope.decks, deletedCards: true,
  });
}
