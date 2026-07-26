import { createDesignValidation } from "./design-validation.js";
import type {
  DesignValidation,
  DesignValidationIssue,
} from "./shared-schemas.js";

/** Performs conservative CSS structural checks without changing Anki. */
export function validateCss(css: string): DesignValidation {
  const issues: DesignValidationIssue[] = [];
  const openingBraces: number[] = [];
  let quote: "'" | '"' | null = null;
  let quoteStart = -1;
  let inComment = false;
  let commentStart = -1;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const nextCharacter = css[index + 1];

    if (inComment) {
      if (character === "*" && nextCharacter === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      inComment = true;
      commentStart = index;
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
      quoteStart = index;
    } else if (character === "{") {
      openingBraces.push(index);
    } else if (character === "}") {
      const openingBrace = openingBraces.pop();

      if (openingBrace === undefined) {
        issues.push({
          severity: "error",
          code: "unexpected_closing_brace",
          path: "css",
          message: `Unexpected closing brace at character ${index}.`,
        });
      }
    }
  }

  if (inComment) {
    issues.push({
      severity: "error",
      code: "unterminated_comment",
      path: "css",
      message: `CSS comment starting at character ${commentStart} is not closed.`,
    });
  }

  if (quote !== null) {
    issues.push({
      severity: "error",
      code: "unterminated_string",
      path: "css",
      message: `CSS string starting at character ${quoteStart} is not closed.`,
    });
  }

  for (const openingBrace of openingBraces) {
    issues.push({
      severity: "error",
      code: "unclosed_block",
      path: "css",
      message: `CSS block starting at character ${openingBrace} is not closed.`,
    });
  }

  if (
    /@import\s/i.test(css) ||
    /url\(\s*(['"]?)(?:https?:)?\/\//i.test(css)
  ) {
    issues.push({
      severity: "warning",
      code: "external_resource",
      path: "css",
      message:
        "The CSS references an external resource. Cards may require network access and can disclose requests to a third party.",
    });
  }

  return createDesignValidation(issues);
}
