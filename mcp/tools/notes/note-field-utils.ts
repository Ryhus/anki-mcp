import { createHash } from "node:crypto";

/** Hashes the exact UTF-8 field value, including HTML and whitespace. */
export function calculateNoteFieldHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Maps submitted field names to the exact casing defined by an Anki note type.
 * Returns a readable error instead of allowing AnkiConnect to silently ignore
 * unknown fields.
 */
export function canonicalizeFields(
  submittedFields: Record<string, string>,
  definedFieldNames: string[],
): Record<string, string> | string {
  const canonicalNameByLowercase = new Map(
    definedFieldNames.map((name) => [name.toLowerCase(), name]),
  );
  const canonicalFields: Record<string, string> = {};
  const unknownFields: string[] = [];
  const duplicateFields: string[] = [];

  for (const [submittedName, value] of Object.entries(submittedFields)) {
    const canonicalName = canonicalNameByLowercase.get(
      submittedName.toLowerCase(),
    );

    if (canonicalName === undefined) {
      unknownFields.push(submittedName);
      continue;
    }

    if (canonicalName in canonicalFields) {
      duplicateFields.push(submittedName);
      continue;
    }

    canonicalFields[canonicalName] = value;
  }

  if (unknownFields.length > 0) {
    return `Unknown field${unknownFields.length === 1 ? "" : "s"} for the selected note type: ${unknownFields.join(", ")}`;
  }

  if (duplicateFields.length > 0) {
    return `Multiple submitted fields resolve to the same note-type field: ${duplicateFields.join(", ")}`;
  }

  return canonicalFields;
}
