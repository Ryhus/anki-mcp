import { hasUniqueAnkiStructureNames } from "./anki-structure-names.js";
import { validateCss } from "./css-validator.js";
import { combineValidations, createDesignValidation } from "./design-validation.js";
import type {
  DesignValidation,
  DesignValidationIssue,
} from "./shared-schemas.js";
import { validateTemplateSide } from "./template-validator.js";

export interface NoteTypeDefinitionTemplate {
  name: string;
  front: string;
  back: string;
}

export interface NoteTypeDefinitionValidationInput {
  fieldNames: string[];
  templates: NoteTypeDefinitionTemplate[];
  css: string;
  isCloze: boolean;
}

/** Validates a complete new note-type definition before Anki receives it. */
export function validateNoteTypeDefinition({
  fieldNames,
  templates,
  css,
  isCloze,
}: NoteTypeDefinitionValidationInput): DesignValidation {
  const validations: DesignValidation[] = [validateCss(css)];
  const issues: DesignValidationIssue[] = [];

  if (!hasUniqueAnkiStructureNames(fieldNames, "field")) {
    issues.push({
      severity: "error", code: "duplicate_field_names", path: "fields",
      message: "Field names must be unique under Anki's name comparison rules.",
    });
  }
  if (!hasUniqueAnkiStructureNames(templates.map(({ name }) => name), "template")) {
    issues.push({
      severity: "error", code: "duplicate_template_names", path: "templates",
      message: "Card template names must be unique under Anki's name comparison rules.",
    });
  }

  for (const [index, template] of templates.entries()) {
    validations.push(
      validateTemplateSide({
        html: template.front,
        fieldNames,
        path: `templates[${index}].front`,
        requireFieldReference: true,
      }),
      validateTemplateSide({
        html: template.back,
        fieldNames,
        path: `templates[${index}].back`,
        requireFieldReference: false,
      }),
    );
  }

  const templatesWithCloze = templates.filter(
    ({ front, back }) =>
      containsClozeFilter(front) || containsClozeFilter(back),
  );

  if (!isCloze && templatesWithCloze.length > 0) {
    issues.push({
      severity: "error",
      code: "cloze_filter_requires_cloze_note_type",
      path: "isCloze",
      message:
        "Normal note types cannot use {{cloze:Field}} filters. Set isCloze to true or remove the filters.",
    });
  }

  if (isCloze) {
    if (templates.length !== 1) {
      issues.push({
        severity: "error",
        code: "cloze_note_type_requires_one_template",
        path: "templates",
        message: "A Cloze note type must define exactly one card template.",
      });
    }

    const firstTemplate = templates[0];
    if (
      firstTemplate !== undefined &&
      !containsClozeFilter(firstTemplate.front)
    ) {
      issues.push({
        severity: "error",
        code: "cloze_front_missing_filter",
        path: "templates[0].front",
        message:
          "A Cloze front template must contain a {{cloze:Field}} filter.",
      });
    }

    if (
      firstTemplate !== undefined &&
      !containsClozeFilter(firstTemplate.back)
    ) {
      issues.push({
        severity: "warning",
        code: "cloze_back_missing_filter",
        path: "templates[0].back",
        message:
          "The Cloze back template has no {{cloze:Field}} filter. Confirm that it reveals the intended answer.",
      });
    }
  }

  validations.push(createDesignValidation(issues));
  return combineValidations(validations);
}

/** Detects an Anki cloze field replacement in template HTML. */
export function containsClozeFilter(html: string): boolean {
  return /{{[^{}]*\bcloze\s*:/i.test(html);
}
