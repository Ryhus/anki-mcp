import type { AnkiRequestOptions } from "../anki-request-config.js";
import { openV1Adapter, type V1Route } from "./anki-v1-adapter-utils.js";
import { v1CardRoutes } from "./anki-v1-cards-adapter.js";
import { v1DeckRoutes } from "./anki-v1-decks-adapter.js";
import { v1MediaRoutes } from "./anki-v1-media-adapter.js";
import { v1NoteTypeRoutes } from "./anki-v1-note-types-adapter.js";
import { v1NotesRoutes } from "./anki-v1-notes-adapter.js";
import { AnkiV1Error } from "./anki-v1-request.js";

const routes: Readonly<Record<string, V1Route>> = {
  ...v1CardRoutes, ...v1DeckRoutes, ...v1MediaRoutes, ...v1NoteTypeRoutes, ...v1NotesRoutes,
};
const readBatchActions = new Set([
  "getActiveProfile", "deckNamesAndIds", "getDeckConfig", "getDecks", "cardsToNotes", "findCards",
  "findNotes", "notesInfo", "modelNamesAndIds", "modelTemplates", "modelStyling",
]);

/**
 * Adapts internal action-shaped calls without ever sending a legacy request.
 * Higher-level MCP safety checks continue to use their existing data contracts.
 */
export async function invokeV1Action(
  action: string, params: Record<string, unknown> = {}, options: AnkiRequestOptions,
): Promise<unknown> {
  if (action === "multi") {
    const actions = params.actions as Array<{ action: string; params?: Record<string, unknown> }>;
    if (!Array.isArray(actions) || actions.some((item) => !readBatchActions.has(item.action))) {
      throw new Error("Only supported read actions can be grouped in v1 mode.");
    }
    if (actions.length === 0) return [];
    const ctx = await openV1Adapter(options);
    const replies = [];
    for (const item of actions) {
      try {
        replies.push({ result: await routes[item.action]!(item.params ?? {}, ctx), error: null });
      } catch (error) {
        if (!(error instanceof AnkiV1Error)) throw error;
        replies.push({ result: null, error: error.message });
      }
    }
    return replies;
  }
  const route = Object.hasOwn(routes, action) ? routes[action] : undefined;
  if (route === undefined) throw new Error(`No AnkiConnect v1 route for ${JSON.stringify(action)}; no legacy request was sent.`);
  return route(params, await openV1Adapter(options));
}
