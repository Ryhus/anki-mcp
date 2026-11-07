import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnkiNoteInfo } from "../../../anki-api/notes/note-types.js";
import { calculateNoteDeletionImpactHash } from "../notes/note-deletion-utils.js";
import { deckIdSchema } from "./shared-schemas.js";
import { DECK_DELETION_LIMITS, type DeletionDeck } from "./deck-deletion-schemas.js";

export interface DeckDeletionScope {
  profileName: string;
  deck: DeletionDeck | null;
  decks: DeletionDeck[];
  cardIds: number[] | null;
  noteIds: number[] | null;
  notes: AnkiNoteInfo[] | null;
  placements: Array<readonly [number, number]>;
  blockers: string[];
}

/** Validates data before it can become a destructive search or target. */
export function parseDeckMap(value: unknown): Record<string, number> {
  const map = z.record(z.string().min(1), deckIdSchema).parse(value);
  if (new Set(Object.values(map)).size !== Object.keys(map).length) {
    throw new Error("AnkiConnect returned ambiguous deck identities.");
  }
  return map;
}

export function parseIds(value: unknown): number[] {
  return [...new Set(z.array(z.number().int().positive()).parse(value))].sort((a, b) => a - b);
}

export function isInDeckTree(name: string, root: string): boolean {
  const candidate = name.toLowerCase();
  const parent = root.toLowerCase();
  return candidate === parent || candidate.startsWith(`${parent}::`);
}

/** Resolves children explicitly; native did: searches do not expand children. */
export function resolveDeletionDecks(map: Record<string, number>, name: string): DeletionDeck[] {
  if (!Object.hasOwn(map, name)) return [];
  return Object.entries(map).filter(([candidate]) => isInDeckTree(candidate, name))
    .map(([name, id]) => ({ name, id })).sort((a, b) => a.id - b.id);
}

export function classifyDeckNotes(scope: DeckDeletionScope) {
  const removed = new Set(scope.cardIds ?? []);
  const deletedNoteIds: number[] = [];
  const survivingNoteIds: number[] = [];
  const preservedCardIds = new Set<number>();
  const notes = (scope.notes ?? []).map((note) => {
    const cards = [...new Set(note.cards)];
    const preserved = cards.filter((id) => !removed.has(id));
    const willBeDeleted = preserved.length === 0;
    (willBeDeleted ? deletedNoteIds : survivingNoteIds).push(note.noteId);
    preserved.forEach((id) => preservedCardIds.add(id));
    return {
      noteId: note.noteId, modelName: note.modelName, willBeDeleted,
      deletedCardCount: cards.length - preserved.length, preservedCardCount: preserved.length,
    };
  });
  return { notes, deletedNoteIds, survivingNoteIds, preservedCardIds: [...preservedCardIds].sort((a, b) => a - b) };
}

/** Hashes full deck identity, placement, and Note data before response sampling. */
export function calculateDeckDeletionImpactHash(scope: DeckDeletionScope): string {
  if (scope.deck === null || scope.notes === null || scope.cardIds === null || scope.noteIds === null || scope.blockers.length) {
    throw new Error("Cannot hash an incomplete deck deletion impact.");
  }
  return createHash("sha256").update(JSON.stringify({
    version: 1, profileName: scope.profileName, root: [scope.deck.id, scope.deck.name],
    decks: scope.decks.map(({ id, name }) => [id, name]).sort(([a], [b]) => Number(a) - Number(b)),
    cardIds: [...scope.cardIds].sort((a, b) => a - b),
    placements: [...scope.placements].sort(([a], [b]) => a - b),
    notesHash: calculateNoteDeletionImpactHash(scope.profileName, scope.noteIds, scope.notes),
  })).digest("hex");
}

export function describeDeckDeletionImpact(scope: DeckDeletionScope) {
  const classified = classifyDeckNotes(scope);
  const complete = scope.notes !== null;
  const sample = DECK_DELETION_LIMITS.sample;
  return {
    deckCount: scope.decks.length, cardCount: scope.cardIds?.length ?? null,
    affectedNoteCount: scope.noteIds?.length ?? null,
    deletedNoteCount: complete ? classified.deletedNoteIds.length : null,
    survivingNoteCount: complete ? classified.survivingNoteIds.length : null,
    preservedCardCount: complete ? classified.preservedCardIds.length : null,
    sampleDecks: scope.decks.slice(0, sample), decksTruncated: scope.decks.length > sample,
    sampleCardIds: (scope.cardIds ?? []).slice(0, sample), cardsTruncated: (scope.cardIds?.length ?? 0) > sample,
    sampleNotes: classified.notes.slice(0, sample), notesTruncated: (scope.noteIds?.length ?? 0) > sample,
  };
}
