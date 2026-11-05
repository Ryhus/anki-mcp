import { z } from "zod";
import type { AnkiRetrievedMediaData } from "../media/media-types.js";
import type { AnkiRequestOptions } from "../anki-request-config.js";
import { AnkiV1Error, callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

const mediaFileSchema = z.object({ filename: z.string(), data: z.string() });

/** Reads an existing file in the caller's collection session; never stores media. */
export async function retrieveV1MediaFile(filename: string, session: string, options?: AnkiRequestOptions): Promise<AnkiRetrievedMediaData> {
  const method = "media.get";
  try {
    const file = await callAnkiV1(method, { filename, session }, mediaFileSchema, options);
    if (file.filename !== filename) throw invalidAnkiV1Response(method);
    return file.data;
  } catch (error) {
    if (error instanceof AnkiV1Error && error.code === 1001) return false;
    throw error;
  }
}
