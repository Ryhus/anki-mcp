import { createAnkiAction, invokeAnkiMulti } from "../../../anki-api/anki-request.js";
import type { AnkiNoteInfo } from "../../../anki-api/notes/note-types.js";
import { loadNoteDeletionScope } from "../notes/note-deletion-utils.js";
import { DECK_DELETION_LIMITS as LIMIT } from "./deck-deletion-schemas.js";
import { parseDeckMap, parseIds, resolveDeletionDecks, type DeckDeletionScope } from "./deck-deletion-impact.js";

/** Reads an explicitly bounded normal-deck subtree without modifying Anki. */
export async function loadDeckDeletionScope(name: string): Promise<DeckDeletionScope> {
  const [profileName, rawMap] = await invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"), createAnkiAction<unknown>("deckNamesAndIds"),
  ] as const);
  if (typeof profileName !== "string" || !profileName.trim()) throw new Error("AnkiConnect omitted the active profile.");
  const map = parseDeckMap(rawMap);
  const decks = resolveDeletionDecks(map, name);
  const scope: DeckDeletionScope = {
    profileName, deck: decks.find((deck) => deck.name === name) ?? null,
    decks, cardIds: null, noteIds: null, notes: null, placements: [], blockers: [],
  };
  if (!scope.deck) scope.blockers.push(`Deck not found by exact name: ${name}`);
  if (decks.some(({ id }) => id === 1)) scope.blockers.push("The built-in Default deck (ID 1) cannot be deleted by this tool, even after renaming or nesting it.");
  if (decks.length > LIMIT.decks) scope.blockers.push(`The subtree contains ${decks.length} decks; the full review limit is ${LIMIT.decks}.`);
  if (scope.blockers.length) return scope;

  try {
    const configs = await invokeAnkiMulti(decks.map(({ name }) => createAnkiAction<unknown>("getDeckConfig", { deck: name })));
    configs.forEach((config, index) => {
      const dyn = typeof config === "object" && config !== null && "dyn" in config ? config.dyn : undefined;
      if (dyn !== false && dyn !== 0) scope.blockers.push(
        `Deck "${decks[index]!.name}" is filtered or its kind could not be verified; only normal decks are supported.`,
      );
    });
  } catch (error) {
    scope.blockers.push(`Could not verify normal deck kinds (filtered decks are unsupported): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (scope.blockers.length) return scope;

  // An explicit list of numeric IDs includes borrowed-out cards via odid, and
  // avoids wildcard/keyword names such as "current", "filtered", or "*".
  const [foundCards] = await invokeAnkiMulti([
    createAnkiAction<unknown>("findCards", { query: `did:${decks.map(({ id }) => id).join(",")}` }),
  ] as const);
  scope.cardIds = parseIds(foundCards);
  if (scope.cardIds.length > LIMIT.cards) {
    scope.blockers.push(`The subtree contains ${scope.cardIds.length} Cards; the full review limit is ${LIMIT.cards}.`);
    return scope;
  }
  if (scope.cardIds.length === 0) {
    scope.noteIds = [];
    scope.notes = [];
    await confirmScopeStillCurrent(scope, []);
    return scope;
  }

  const [rawPlacements, rawNoteIds] = await invokeAnkiMulti([
    createAnkiAction<unknown>("getDecks", { cards: scope.cardIds }),
    createAnkiAction<unknown>("cardsToNotes", { cards: scope.cardIds }),
  ] as const);
  if (typeof rawPlacements !== "object" || rawPlacements === null || Array.isArray(rawPlacements)) {
    throw new Error("AnkiConnect returned invalid Card deck assignments.");
  }
  const targets = new Set(scope.cardIds);
  const placed = new Set<number>();
  for (const [deckName, ids] of Object.entries(rawPlacements)) {
    const deckId = map[deckName];
    if (!decks.some(({ name }) => name === deckName)) {
      scope.blockers.push(`Cards from the subtree are currently outside it (possibly in a filtered deck): ${deckName}. Return them before deletion.`);
    }
    for (const cardId of parseIds(ids)) {
      if (!targets.has(cardId) || placed.has(cardId)) throw new Error("AnkiConnect returned ambiguous Card deck assignments.");
      placed.add(cardId);
      if (deckId !== undefined) scope.placements.push([cardId, deckId]);
    }
  }
  if (placed.size !== targets.size) scope.blockers.push("AnkiConnect omitted some Card deck assignments; impact cannot be reviewed.");
  scope.noteIds = parseIds(rawNoteIds);
  if (scope.noteIds.length === 0) scope.blockers.push("AnkiConnect did not resolve the Notes that own the selected Cards.");
  if (scope.noteIds.length > LIMIT.notes) scope.blockers.push(`The subtree affects ${scope.noteIds.length} Notes; the full review limit is ${LIMIT.notes}.`);
  if (scope.blockers.length) return scope;

  const notes: AnkiNoteInfo[] = [];
  for (let start = 0; start < scope.noteIds.length; start += LIMIT.batch) {
    const loaded = await loadNoteDeletionScope(scope.noteIds.slice(start, start + LIMIT.batch));
    if (loaded.profileName !== profileName) scope.blockers.push("The active Anki profile changed during impact loading.");
    if (loaded.missingNoteIds.length) scope.blockers.push("Some affected Notes are missing or could not be loaded; no deletion can be reviewed.");
    notes.push(...loaded.notes);
  }
  const owners = new Map<number, number>();
  for (const note of notes) for (const cardId of note.cards) {
    if (owners.has(cardId) && owners.get(cardId) !== note.noteId) throw new Error("AnkiConnect returned inconsistent Card ownership across Notes.");
    owners.set(cardId, note.noteId);
  }
  if (scope.cardIds.some((id) => !owners.has(id)) || notes.some((note) => !note.cards.some((id) => targets.has(id)))) {
    scope.blockers.push("Card-to-Note ownership changed or is incomplete; review a fresh impact.");
  }
  if (owners.size > LIMIT.referencedCards) scope.blockers.push(`Affected Notes reference ${owners.size} Cards; the full review limit is ${LIMIT.referencedCards}.`);
  if (scope.blockers.length === 0) {
    await confirmScopeStillCurrent(scope, [...owners.keys()]);
    if (scope.blockers.length === 0) scope.notes = notes;
  }
  return scope;
}

/** Catches cross-phase disappearance and verifies outside siblings before loss. */
async function confirmScopeStillCurrent(scope: DeckDeletionScope, cardIds: number[]): Promise<void> {
  const checks = [];
  const ids = [...new Set(cardIds)].sort((a, b) => a - b);
  for (let start = 0; start < ids.length; start += LIMIT.batch) {
    checks.push(createAnkiAction<unknown>("findCards", { query: `cid:${ids.slice(start, start + LIMIT.batch).join(",")}` }));
  }
  const [profile, rawMap, targetCards, ...results] = await invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"), createAnkiAction<unknown>("deckNamesAndIds"),
    createAnkiAction<unknown>("findCards", { query: `did:${scope.decks.map(({ id }) => id).join(",")}` }),
    ...checks,
  ] as const);
  if (profile !== scope.profileName) scope.blockers.push("The active Anki profile changed during impact loading.");
  const current = resolveDeletionDecks(parseDeckMap(rawMap), scope.deck!.name);
  if (JSON.stringify(current) !== JSON.stringify(scope.decks)) scope.blockers.push("Deck identities or descendants changed during impact loading.");
  if (JSON.stringify(parseIds(targetCards)) !== JSON.stringify(scope.cardIds)) scope.blockers.push("The target Card set changed during impact loading; review a fresh impact.");
  const found = parseIds(results.flatMap((result) => parseIds(result)));
  if (JSON.stringify(found) !== JSON.stringify(ids)) scope.blockers.push("Some reviewed Cards or outside siblings disappeared during impact loading.");
}
