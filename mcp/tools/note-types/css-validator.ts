import { parse, walk } from "css-tree";
import type { CssLocation, CssNode } from "css-tree";
import { createDesignValidation } from "./design-validation.js";
import type {
  DesignValidation,
  DesignValidationIssue,
} from "./shared-schemas.js";

interface SourcePosition {
  column: number;
  line: number;
}

/** Parses CSS without changing Anki and reports syntax and portability issues. */
export function validateCss(css: string): DesignValidation {
  const issues: DesignValidationIssue[] = [];
  const issueKeys = new Set<string>();
  let referencesExternalResource = false;
  let ast: CssNode | undefined;

  const addIssue = (issue: DesignValidationIssue): void => {
    const key = `${issue.severity}:${issue.code}:${issue.path}:${issue.message}`;

    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(issue);
    }
  };

  try {
    ast = parse(css, {
      positions: true,
      onComment: (_value, location) => {
        if (!sourceAt(css, location).endsWith("*/")) {
          addIssue({
            severity: "error",
            code: "unterminated_comment",
            path: "css",
            message: `CSS comment starting at ${formatPosition(location.start)} is not closed.`,
          });
        }
      },
      onParseError: (error) => {
        addIssue(createSyntaxIssue(css, error));
      },
    });
  } catch (error) {
    addIssue(createSyntaxIssue(css, error));
  }

  if (ast !== undefined) {
    walk(ast, (node) => {
      if (
        node.type === "Block" &&
        node.loc !== undefined &&
        !sourceAt(css, node.loc).endsWith("}")
      ) {
        addIssue({
          severity: "error",
          code: "unclosed_block",
          path: "css",
          message: `CSS block starting at ${formatPosition(node.loc.start)} is not closed.`,
        });
      }

      if (
        node.type === "String" &&
        node.loc !== undefined &&
        !hasClosingQuote(sourceAt(css, node.loc))
      ) {
        addIssue({
          severity: "error",
          code: "unterminated_string",
          path: "css",
          message: `CSS string starting at ${formatPosition(node.loc.start)} is not closed.`,
        });
      }

      if (
        (node.type === "Atrule" && node.name.toLowerCase() === "import") ||
        (node.type === "Url" && isExternalUrl(node.value))
      ) {
        referencesExternalResource = true;
      }
    });
  }

  if (referencesExternalResource) {
    addIssue({
      severity: "warning",
      code: "external_resource",
      path: "css",
      message:
        "The CSS references an external resource. Cards may require network access and can disclose requests to a third party.",
    });
  }

  return createDesignValidation(issues);
}

function createSyntaxIssue(
  css: string,
  error: unknown,
): DesignValidationIssue {
  const offset = isSyntaxParseError(error) ? error.offset : 0;
  const position = positionAt(css, offset);
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Unknown CSS syntax error";

  return {
    severity: "error",
    code: "css_syntax_error",
    path: "css",
    message: `${message} at ${formatPosition(position)}.`,
  };
}

function isSyntaxParseError(
  error: unknown,
): error is SyntaxError & { offset: number } {
  return (
    error instanceof SyntaxError &&
    "offset" in error &&
    typeof error.offset === "number"
  );
}

function positionAt(css: string, offset: number): SourcePosition {
  const safeOffset = Math.max(0, Math.min(offset, css.length));
  const sourceBeforeOffset = css.slice(0, safeOffset);
  const lastLineBreak = sourceBeforeOffset.lastIndexOf("\n");

  return {
    line: sourceBeforeOffset.split("\n").length,
    column: safeOffset - lastLineBreak,
  };
}

function formatPosition(position: SourcePosition): string {
  return `line ${position.line}, column ${position.column}`;
}

function sourceAt(css: string, location: CssLocation): string {
  return css.slice(location.start.offset, location.end.offset);
}

function hasClosingQuote(source: string): boolean {
  const openingQuote = source[0];

  return (
    (openingQuote === "'" || openingQuote === '"') &&
    source.at(-1) === openingQuote
  );
}

function isExternalUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}
