import { createHash } from "node:crypto";
import type { DeckPreset, PresetSettingValue } from "../../../anki-api/decks/deck-preset-client.js";
import type { ManagedDeck } from "../../../anki-api/decks/deck-management-client.js";
import { presetImpactLimit } from "./deck-preset-schemas.js";

export function dependentDecks(decks: ManagedDeck[], presetId: number): ManagedDeck[] {
  return decks.filter((deck) => deck.presetId === presetId).sort((a, b) => a.id - b.id);
}

export function previewDecks(decks: ManagedDeck[]) {
  return {
    affectedDeckCount: decks.length,
    affectedDecks: decks.slice(0, presetImpactLimit).map(({ id, name }) => ({ id, name })),
  };
}

export function presetImpactHash(
  profile: string, operation: string, preset: DeckPreset, decks: ManagedDeck[], proposal: unknown,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1, profile, operation,
    preset: { ...preset, settings: Object.entries(preset.settings).sort(([a], [b]) => a.localeCompare(b, "en")) },
    decks, proposal,
  })).digest("hex");
}

export function addApplyBlockers(
  blockers: string[], impactHash: string | null,
  input: { dryRun: boolean; expectedImpactHash?: string | undefined }, confirmed: boolean, confirmation: string,
): void {
  if (input.expectedImpactHash !== undefined && input.expectedImpactHash !== impactHash) {
    blockers.push("The preset impact changed since the preview. Review a fresh preview.");
  }
  if (!input.dryRun && (!confirmed || input.expectedImpactHash === undefined)) {
    blockers.push(`Applying requires ${confirmation}: true and the reviewed expectedImpactHash.`);
  }
}

/** Native protobuf floats can round decimal input to its float32 representation. */
export function samePresetSetting(actual: PresetSettingValue | undefined, expected: PresetSettingValue): boolean {
  if (typeof expected === "number" && typeof actual === "number") return actual === expected || actual === Math.fround(expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((value, index) => samePresetSetting(actual[index], value));
  }
  return actual === expected;
}

export async function verifyPresetMutation<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(
      `Could not confirm ${action}. Some or all changes may already be applied; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown error."}`,
      { cause: error },
    );
  }
}
