type StructureNameKind = "field" | "template";

const cherokee = /\p{Script=Cherokee}/u;
// Python's str.isspace() also includes these four ASCII information separators.
const fieldLeadingCharacters = /^[\p{White_Space}\u001c-\u001f#/^]+/u;
const fieldTrailingWhitespace = /[\p{White_Space}\u001c-\u001f]+$/u;

/** Comparison key only: never replace the spelling sent to Anki. */
export function ankiStructureNameKey(name: string, kind: StructureNameKind): string {
  let normalized = name.normalize("NFC");
  if (kind === "field") {
    normalized = normalized.replace(/[:{}"]/gu, "")
      .replace(fieldLeadingCharacters, "").replace(fieldTrailingWhitespace, "");
  }
  // AnkiConnect uses default Unicode case folding, not contextual lowercasing.
  // The round trip handles expansions (ß → ss) and folds final sigma. Dotless i
  // remains distinct and the Unicode fold for Cherokee uses uppercase.
  return Array.from(normalized, (char) => {
    if (char === "ı") return char;
    if (cherokee.test(char)) return char.toUpperCase();
    return Array.from(char.toLowerCase().toUpperCase(), (part) => part.toLowerCase()).join("");
  }).join("");
}

export function hasUniqueAnkiStructureNames(names: readonly string[], kind: StructureNameKind): boolean {
  return new Set(names.map((name) => ankiStructureNameKey(name, kind))).size === names.length;
}
