const HTML_ENTITY_MEDIA_SOURCE_PATTERN =
  String.raw`(?is)<(?:audio|img|source|video)\b(?:[^>"']|"[^"]*"|'[^']*')*\bsrc\s*=\s*(?:"[^"]*&|'[^']*&|[^\s>]*&)`;

/**
 * Builds a native Anki query that returns every possible exact field match.
 *
 * The literal branch handles ordinary HTML and [sound:...] references. The
 * second branch admits media src attributes containing HTML entities, because
 * parse5 decodes those entities before the exact local comparison.
 */
export function buildMediaReferenceCandidateQuery(
  filename: string,
): string {
  const literalFilenamePattern = escapeRegexLiteral(filename);

  return `(${toAnkiRegexTerm(literalFilenamePattern)} or ${toAnkiRegexTerm(HTML_ENTITY_MEDIA_SOURCE_PATTERN)})`;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function toAnkiRegexTerm(pattern: string): string {
  return `"re:${pattern.replaceAll('"', String.raw`\"`)}"`;
}
