import { parse, walk } from "css-tree";
import type { CssNode, ParseOptions } from "css-tree";

/** A partial count must never be used as proof that a file is unreferenced. */
export interface CssMediaReferenceScan {
  occurrenceCount: number;
  error: string | null;
}

// css-tree 3 exposes this onToken context, but @types/css-tree 2 omits it.
interface CssTokenContext {
  getTokenTypeName(index: number): string;
  getBlockTokenPairIndex(index: number): number;
  isBlockOpenerTokenType(type: number): boolean;
  isBlockCloserTokenType(type: number): boolean;
}

interface CssScanParseOptions extends ParseOptions {
  onToken: (this: CssTokenContext, type: number, start: number, end: number, index: number) => void;
}

/**
 * Counts exact url(...) references while retaining the first parsing failure.
 * Recovered/opaque syntax and CSS's implicit EOF closures are incomplete scans,
 * not evidence of zero references. The stylesheet is never rewritten.
 */
export function scanMediaReferencesInCss(css: string, filename: string): CssMediaReferenceScan {
  let occurrenceCount = 0;
  let error: string | null = null;
  let ast: CssNode | undefined;
  const fail = (message: string, offset = 0): void => {
    if (error !== null) return;
    const lines = css.slice(0, offset).split(/\r\n|\r|\n|\f/u);
    const line = lines.length;
    const column = (lines.at(-1)?.length ?? 0) + 1;
    error = `${message.slice(0, 300)} at line ${line}, column ${column}.`;
  };
  const options: CssScanParseOptions = {
    positions: true,
    parseCustomProperty: true,
    onParseError: (parseError, fallbackNode) => {
      // css-tree also reports speculative condition grammar retries with a
      // null fallback, e.g. valid nested @supports. They leave no opaque data.
      if (fallbackNode !== null) fail(parseError.message, parseError.offset);
    },
    onToken(type, start, end, index) {
      const name = this.getTokenTypeName(index);
      const source = css.slice(start, end);
      if (
        (this.isBlockOpenerTokenType(type) || this.isBlockCloserTokenType(type)) &&
        this.getBlockTokenPairIndex(index) === -1
      ) {
        fail("Unmatched CSS block, bracket, or function delimiter", start);
      } else if (name === "comment-token" && !source.endsWith("*/")) {
        fail("Unterminated CSS comment", start);
      } else if (name === "bad-string-token" || name === "bad-url-token") {
        fail("Malformed CSS string or URL", start);
      } else if (name === "string-token" && !hasUnescapedClosingCharacter(source, source[0])) {
        fail("Unterminated CSS string", start);
      } else if (name === "url-token" && !hasUnescapedClosingCharacter(source, ")")) {
        fail("Unterminated CSS URL", start);
      }
    },
  };

  try {
    ast = parse(css, options);
  } catch (parseError) {
    fail(parseError instanceof Error ? parseError.message : "CSS parsing failed");
  }

  if (ast !== undefined) {
    walk(ast, (node) => {
      if (node.type === "Raw" && !/^[;\s]*$/u.test(node.value)) {
        fail("CSS contains content that could not be fully parsed", node.loc?.start.offset);
      }
      if (node.type === "Url") {
        const value = node.value.trim();
        const normalized = value.startsWith("./") ? value.slice(2) : value;
        if (normalized === filename) occurrenceCount += 1;
      }
    });
  }

  return { occurrenceCount, error };
}

function hasUnescapedClosingCharacter(source: string, expected: string | undefined): boolean {
  if (source.length < 2 || expected === undefined || source.at(-1) !== expected) return false;
  let backslashes = 0;
  for (let index = source.length - 2; index >= 0 && source[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}
