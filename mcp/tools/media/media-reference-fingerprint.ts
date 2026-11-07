import { createHash } from "node:crypto";

/** One exact reference location and its occurrence count, before sampling. */
export type MediaReferenceFingerprintEntry =
  | readonly [
      kind: "note", noteId: number, modelName: string,
      fieldName: string, occurrenceCount: number,
    ]
  | readonly [
      kind: "template", modelName: string, templateName: string,
      side: "front" | "back", occurrenceCount: number,
    ]
  | readonly [kind: "css", modelName: string, occurrenceCount: number];

/**
 * Hashes a canonical reference set independently of scan order or surrounding
 * HTML. The filename distinguishes even empty sets belonging to different files.
 */
export function calculateMediaReferenceFingerprint(
  filename: string,
  entries: readonly MediaReferenceFingerprintEntry[],
): string {
  const references = entries.map((entry) => JSON.stringify(entry)).sort();
  const canonical = JSON.stringify({ version: 1, filename, references });

  return createHash("sha256").update(canonical).digest("hex");
}
