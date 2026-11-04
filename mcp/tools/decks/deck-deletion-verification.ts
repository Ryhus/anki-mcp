import { createAnkiAction, invokeAnkiMulti } from "../../../anki-api/anki-request.js";
import { classifyDeckNotes, isInDeckTree, parseDeckMap, parseIds, type DeckDeletionScope } from "./deck-deletion-impact.js";
import { DECK_DELETION_LIMITS } from "./deck-deletion-schemas.js";

/** Verifies both removed objects and the siblings that must survive elsewhere. */
export async function verifyDeckDeletion(scope: DeckDeletionScope): Promise<void> {
  const classified = classifyDeckNotes(scope);
  const checks: Array<{ ids: number[]; present: boolean; action: ReturnType<typeof createAnkiAction<number[]>> }> = [];
  for (const [kind, ids, present] of [
    ["cid", scope.cardIds ?? [], false], ["nid", classified.deletedNoteIds, false],
    ["nid", classified.survivingNoteIds, true], ["cid", classified.preservedCardIds, true],
  ] as const) {
    for (let start = 0; start < ids.length; start += DECK_DELETION_LIMITS.batch) {
      const batch = ids.slice(start, start + DECK_DELETION_LIMITS.batch);
      checks.push({ ids: batch, present, action: createAnkiAction<number[]>(kind === "cid" ? "findCards" : "findNotes", {
        query: `${kind}:${batch.join(",")}`,
      }) });
    }
  }
  const [profileName, rawMap, ...results] = await invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"), createAnkiAction<unknown>("deckNamesAndIds"),
    ...checks.map(({ action }) => action),
  ] as const);
  if (profileName !== scope.profileName) throw new Error("The active Anki profile changed during deletion verification.");
  const remaining = parseDeckMap(rawMap);
  const removedIds = new Set(scope.decks.map(({ id }) => id));
  if (Object.entries(remaining).some(([name, id]) => removedIds.has(id) || isInDeckTree(name, scope.deck!.name))) {
    throw new Error("A reviewed deck identity or subtree name is still present.");
  }
  checks.forEach((check, index) => {
    const found = parseIds(results[index]);
    const expected = check.present ? [...check.ids].sort((a, b) => a - b) : [];
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      throw new Error(check.present
        ? "Some Notes or sibling Cards that should survive outside the deleted subtree are missing."
        : "Some reviewed Cards or orphaned Notes are still present after deck deletion.");
    }
  });
}
