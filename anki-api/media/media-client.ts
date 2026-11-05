import { invokeAnki } from "../anki-request.js";
import { useAnkiV1 } from "../anki-api-mode.js";
import type {
  AnkiRetrievedMediaData,
  AnkiStoredMediaFilename,
  AnkiStoreMediaFileInput,
} from "./media-types.js";

/** Stores base64-encoded bytes in Anki's current collection.media folder. */
export function storeAnkiMediaFile({
  filename,
  data,
  deleteExisting,
}: AnkiStoreMediaFileInput, rejectIfExists = false): Promise<AnkiStoredMediaFilename> {
  return invokeAnki<AnkiStoredMediaFilename>("storeMediaFile", {
    filename,
    data,
    deleteExisting,
    ...(useAnkiV1("storeMediaFile") ? { rejectIfExists } : {}),
  });
}

/** Retrieves one media file as base64, or false when it does not exist. */
export function retrieveAnkiMediaFile(
  filename: string,
): Promise<AnkiRetrievedMediaData> {
  return invokeAnki<AnkiRetrievedMediaData>("retrieveMediaFile", {
    filename,
  });
}

/** Lists media filenames matched by AnkiConnect's glob pattern. */
export function getAnkiMediaFileNames(
  pattern: string,
): Promise<string[]> {
  return invokeAnki<string[]>("getMediaFilesNames", { pattern });
}

/** Moves one file from collection.media into Anki's media trash. */
export async function deleteAnkiMediaFile(
  filename: string,
): Promise<void> {
  await invokeAnki<null>("deleteMediaFile", { filename });
}
