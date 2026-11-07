import { retrieveAnkiMediaFile } from "../../../anki-api/media/media-client.js";
import type { AnkiRetrievedMediaData } from "../../../anki-api/media/media-types.js";
import {
  decodeBase64,
  describeMediaFile,
  type MediaFileDescriptor,
} from "./media-utils.js";

export interface LoadedMediaFile {
  filename: string;
  bytes: Buffer;
  data: string;
  descriptor: MediaFileDescriptor;
}

type MediaReader = (filename: string) => Promise<AnkiRetrievedMediaData>;

/** Loads and describes one exact media filename from Anki. */
export async function loadAnkiMediaFile(
  filename: string,
  read: MediaReader = retrieveAnkiMediaFile,
): Promise<LoadedMediaFile | null> {
  const data = await read(filename);

  if (data === false) {
    return null;
  }

  const bytes = decodeBase64(data);
  const descriptor = await describeMediaFile(filename, bytes);

  return { filename, bytes, data, descriptor };
}

/** Loads distinct filenames while preserving explicit missing entries. */
export async function loadAnkiMediaFiles(
  filenames: string[],
  read?: MediaReader,
): Promise<Map<string, LoadedMediaFile | null>> {
  const uniqueFilenames = [...new Set(filenames)];
  const entries = await Promise.all(
    uniqueFilenames.map(
      async (filename) =>
        [filename, await loadAnkiMediaFile(filename, read)] as const,
    ),
  );

  return new Map(entries);
}
