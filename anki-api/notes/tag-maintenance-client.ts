import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, searchV1IdPage, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { getV1Notes } from "../v1/anki-v1-note-client.js";
import { invalidAnkiV1Response } from "../v1/anki-v1-request.js";

const deleteUnusedMethod = "tags.deleteUnused";
export const TAG_CLEANUP_MAX_NOTES = 50_000;
export const TAG_CLEANUP_MAX_TAGS = 1_000;

export async function openTagMaintenance(): Promise<V1AdapterContext> {
  if (!useAnkiV1(deleteUnusedMethod)) {
    throw new AnkiRequestError("configuration", deleteUnusedMethod, "Tag cleanup requires ANKI_API_MODE=v1.", false);
  }
  return openV1Adapter({});
}

export async function readTagRegistry(ctx: V1AdapterContext): Promise<string[]> {
  const method = "tags.list";
  const tags = await ctx.request(method, {}, z.array(z.string().min(1)));
  if (new Set(tags).size !== tags.length) throw invalidAnkiV1Response(method);
  return tags.sort();
}

/** Reads actual Note assignments, not hierarchical tag search matches. */
export async function findUnusedTagRegistrations(ctx: V1AdapterContext, registry: string[]): Promise<string[]> {
  if (registry.length === 0) return [];
  if (registry.length > TAG_CLEANUP_MAX_TAGS) {
    throw new Error(`Tag cleanup preview is limited to ${TAG_CLEANUP_MAX_TAGS} registered tags. Use Clear Unused Tags in Anki.`);
  }
  const ids = new Set<number>();
  let cursor: string | undefined;
  for (;;) {
    const page = await searchV1IdPage(ctx, "notes.search", "-tag:none", 1_000, cursor);
    for (const id of page.ids) {
      if (ids.has(id)) throw invalidAnkiV1Response("notes.search");
      ids.add(id);
    }
    if (ids.size > TAG_CLEANUP_MAX_NOTES || (ids.size === TAG_CLEANUP_MAX_NOTES && page.nextCursor !== null)) {
      throw new Error(`Tag cleanup preview is limited to ${TAG_CLEANUP_MAX_NOTES} tagged Notes. Use Clear Unused Tags in Anki.`);
    }
    if (page.nextCursor === null) break;
    if (page.ids.length === 0 || page.nextCursor === cursor) throw invalidAnkiV1Response("notes.search");
    cursor = page.nextCursor;
  }

  const available = new Set(registry);
  const used = new Set<string>();
  const noteIds = [...ids];
  for (let start = 0; start < noteIds.length; start += 100) {
    const { notes, missingNoteIds } = await getV1Notes(noteIds.slice(start, start + 100), ctx.session, ctx.options);
    if (missingNoteIds.length > 0 || notes.some(({ tags }) => tags.length === 0)) {
      throw new Error("Tagged Notes changed during the scan. Preview tag cleanup again.");
    }
    for (const { tags } of notes) {
      for (const tag of tags) {
        // Refuse inconsistent/noncanonical inventories instead of guessing Anki's Unicode tag equivalence.
        if (!available.has(tag)) throw new Error("Note tags did not match the tag registry. Preview again or use Clear Unused Tags in Anki.");
        used.add(tag);
      }
    }
    if (used.size === available.size) return [];
  }
  return registry.filter((tag) => !used.has(tag));
}

export async function deleteUnusedTagRegistrations(ctx: V1AdapterContext): Promise<number> {
  const { changedCount } = await ctx.request(deleteUnusedMethod, {}, z.object({ changedCount: z.number().int().nonnegative() }));
  return changedCount;
}
