import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { AnkiV1Error, invalidAnkiV1Response } from "../v1/anki-v1-request.js";

const renameMethod = "noteTypes.update";
type NoteTypeReference = { id: number } | { name: string };

export async function openNoteTypeRename(): Promise<V1AdapterContext> {
  if (!useAnkiV1(renameMethod)) {
    throw new AnkiRequestError(
      "configuration", renameMethod, "Renaming a Note Type requires ANKI_API_MODE=v1.", false,
    );
  }
  return openV1Adapter({});
}

/** A name lookup uses Anki's native comparison rules, including case. */
export async function findManagedNoteType(ctx: V1AdapterContext, reference: NoteTypeReference) {
  const method = "noteTypes.get";
  try {
    const type = await ctx.request(method, {
      noteType: "id" in reference ? { id: String(reference.id) } : reference,
    }, v1EntitySummarySchema);
    if ("id" in reference && type.id !== reference.id) throw invalidAnkiV1Response(method);
    return type;
  } catch (error) {
    if (error instanceof AnkiV1Error && error.code === 1001) return null;
    throw error;
  }
}

/** Changes only the name of the type with the reviewed stable ID. */
export async function renameManagedNoteType(ctx: V1AdapterContext, id: number, name: string): Promise<void> {
  const saved = await ctx.request(renameMethod, {
    noteType: { id: String(id) }, patch: { name },
  }, v1EntitySummarySchema);
  if (saved.id !== id || saved.name !== name) throw invalidAnkiV1Response(renameMethod);
}
