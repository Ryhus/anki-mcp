import { createDesignValidation } from "./design-validation.js";
import type {
  DesignValidation,
  DesignValidationIssue,
} from "./shared-schemas.js";
import { ANKI_SPECIAL_FIELD_NAMES } from "./shared-schemas.js";

const ANKI_SPECIAL_FIELDS = new Set<string>(ANKI_SPECIAL_FIELD_NAMES);

export interface TemplateSideValidationInput {
  html: string;
  fieldNames: string[];
  path: string;
  requireFieldReference: boolean;
}

/**
 * Checks Anki field replacements, conditional sections, and executable HTML.
 *
 * Anki performs the final template validation when an update is applied.
 */
export function validateTemplateSide({
  html,
  fieldNames,
  path,
  requireFieldReference,
}: TemplateSideValidationInput): DesignValidation {
  const issues: DesignValidationIssue[] = [];
  const fieldNameSet = new Set(fieldNames);
  const conditionalStack: Array<{ name: string; position: number }> = [];
  let hasFieldReference = false;
  let cursor = 0;

  while (cursor < html.length) {
    const opening = html.indexOf("{{", cursor);

    if (opening === -1) {
      if (html.indexOf("}}", cursor) !== -1) {
        issues.push({
          severity: "error",
          code: "unexpected_template_close",
          path,
          message: "Found a closing template delimiter without an opening delimiter.",
        });
      }
      break;
    }

    const unexpectedClose = html.indexOf("}}", cursor);
    if (unexpectedClose !== -1 && unexpectedClose < opening) {
      issues.push({
        severity: "error",
        code: "unexpected_template_close",
        path,
        message: `Unexpected closing template delimiter at character ${unexpectedClose}.`,
      });
    }

    const closing = html.indexOf("}}", opening + 2);
    if (closing === -1) {
      issues.push({
        severity: "error",
        code: "unclosed_template_expression",
        path,
        message: `Template expression starting at character ${opening} is not closed.`,
      });
      break;
    }

    const expression = html.slice(opening + 2, closing).trim();
    validateTemplateExpression({
      expression,
      position: opening,
      path,
      fieldNameSet,
      conditionalStack,
      issues,
      markFieldReference: () => {
        hasFieldReference = true;
      },
    });
    cursor = closing + 2;
  }

  for (const section of conditionalStack) {
    issues.push({
      severity: "error",
      code: "unclosed_conditional",
      path,
      message: `Conditional section "${section.name}" starting at character ${section.position} is not closed.`,
    });
  }

  if (requireFieldReference && !hasFieldReference) {
    issues.push({
      severity: "error",
      code: "front_without_field",
      path,
      message:
        "A front template must reference at least one note field so Anki can decide when to generate the card.",
    });
  }

  if (
    /<\s*(?:script|iframe|object|embed)\b/i.test(html) ||
    /\son[a-z]+\s*=/i.test(html) ||
    /(?:href|src)\s*=\s*(['"]?)\s*javascript:/i.test(html)
  ) {
    issues.push({
      severity: "warning",
      code: "executable_content",
      path,
      message:
        "The template contains executable or embedded content. Review it carefully before applying the change.",
    });
  }

  if (
    /(?:href|src)\s*=\s*(['"]?)\s*(?:https?:)?\/\//i.test(html)
  ) {
    issues.push({
      severity: "warning",
      code: "external_resource",
      path,
      message:
        "The template references an external resource. Cards may require network access and can disclose requests to a third party.",
    });
  }

  return createDesignValidation(issues);
}

interface TemplateExpressionValidationInput {
  expression: string;
  position: number;
  path: string;
  fieldNameSet: Set<string>;
  conditionalStack: Array<{ name: string; position: number }>;
  issues: DesignValidationIssue[];
  markFieldReference: () => void;
}

function validateTemplateExpression({
  expression,
  position,
  path,
  fieldNameSet,
  conditionalStack,
  issues,
  markFieldReference,
}: TemplateExpressionValidationInput): void {
  if (expression.length === 0) {
    issues.push({
      severity: "error",
      code: "empty_template_expression",
      path,
      message: `Empty template expression at character ${position}.`,
    });
    return;
  }

  if (expression.startsWith("!") || expression.startsWith("=")) {
    return;
  }

  if (expression === "tts-voices:") {
    return;
  }

  const operator = expression[0];
  const isSectionOperator =
    operator === "#" || operator === "^" || operator === "/";
  const rawField = isSectionOperator
    ? expression.slice(1).trim()
    : expression;
  const fieldName = extractFieldName(rawField);

  if (fieldName.length === 0) {
    issues.push({
      severity: "error",
      code: "missing_field_name",
      path,
      message: `Template expression at character ${position} does not name a field.`,
    });
    return;
  }

  const isKnownField =
    fieldNameSet.has(fieldName) || ANKI_SPECIAL_FIELDS.has(fieldName);

  if (!isKnownField) {
    issues.push({
      severity: "error",
      code: "unknown_field",
      path,
      message: `Template expression references unknown field "${fieldName}".`,
    });
  } else if (fieldNameSet.has(fieldName)) {
    markFieldReference();
  }

  if (operator === "#" || operator === "^") {
    conditionalStack.push({ name: fieldName, position });
  } else if (operator === "/") {
    const openingSection = conditionalStack.pop();

    if (openingSection === undefined) {
      issues.push({
        severity: "error",
        code: "unexpected_conditional_close",
        path,
        message: `Conditional section "${fieldName}" closes without being opened.`,
      });
    } else if (openingSection.name !== fieldName) {
      issues.push({
        severity: "error",
        code: "mismatched_conditional",
        path,
        message: `Conditional section "${openingSection.name}" is closed as "${fieldName}".`,
      });
    }
  }
}

function extractFieldName(expression: string): string {
  const segments = expression.split(":");
  return (segments.at(-1) ?? "").trim();
}
