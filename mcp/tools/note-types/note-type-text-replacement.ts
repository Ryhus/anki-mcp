import { z } from "zod";
import { type NoteTypeTextTarget, noteTypeTextTargets } from "../../../anki-api/note-types/note-type-management-client.js";
import { validateCss } from "./css-validator.js";
import { calculateNoteTypeDesignHash } from "./note-type-design-utils.js";
import {
  type DesignValidationIssue, type NoteTypeDesign, NOTE_TYPE_CONTENT_LIMIT,
  noteTypeDesignHashSchema, noteTypeSummarySchema,
} from "./shared-schemas.js";
import { validateTemplateSide } from "./template-validator.js";

export const noteTypeTextTargetSchema = z.enum(noteTypeTextTargets);
export const replacementPlanSchema = z.object({
  noteType: noteTypeSummarySchema,
  beforeHash: noteTypeDesignHashSchema,
  afterHash: noteTypeDesignHashSchema.nullable(),
  matches: z.array(z.object({
    target: noteTypeTextTargetSchema,
    templateName: z.string().nullable(),
    occurrences: z.number().int().positive(),
  })),
});

/** Mirrors Python's str.replace: literal, case-sensitive and non-overlapping. */
export function planNoteTypeTextReplacement(
  current: NoteTypeDesign, find: string, replace: string, targets: readonly NoteTypeTextTarget[],
) {
  if (find.length === 0) throw new Error("Search text must not be empty.");
  const fields = current.noteType.fields.map(({ name }) => name);
  const { id, name } = current.noteType;
  const issues: DesignValidationIssue[] = [];
  const matches: z.infer<typeof replacementPlanSchema>["matches"] = [];

  function transform(text: string, target: NoteTypeTextTarget, templateName: string | null, path: string) {
    if (!targets.includes(target)) return text;
    let occurrences = 0;
    let index = text.indexOf(find);
    while (index !== -1) {
      occurrences++;
      index = text.indexOf(find, index + find.length);
    }
    if (occurrences === 0) return text;
    matches.push({ target, templateName, occurrences });

    const length = text.length + occurrences * (replace.length - find.length);
    if (length > NOTE_TYPE_CONTENT_LIMIT || (target !== "css" && length === 0)) {
      issues.push({
        severity: "error", code: "invalid_replacement_length", path,
        message: `The resulting ${target === "css" ? "CSS" : "HTML"} must ${target === "css" ? "" : "be nonempty and "}not exceed ${NOTE_TYPE_CONTENT_LIMIT} characters.`,
      });
      return text;
    }
    // A callback also keeps JS replacement tokens such as $&, $$ and $` literal.
    const proposed = text.replaceAll(find, () => replace);
    if (target === "css") {
      issues.push(...validateCss(proposed).issues.map((issue) => ({ ...issue, path })));
    } else {
      issues.push(...validateTemplateSide({
        html: proposed, fieldNames: fields, path, requireFieldReference: target === "question",
      }).issues);
    }
    return proposed;
  }

  const path = `noteTypes[${id}]`;
  const css = transform(current.css, "css", null, `${path}.css`);
  const templates = current.templates.map((template, index) => ({
    ...template,
    front: transform(template.front, "question", template.name, `${path}.templates[${index}].front`),
    back: transform(template.back, "answer", template.name, `${path}.templates[${index}].back`),
  }));
  return {
    noteType: { id, name }, beforeHash: current.designHash,
    afterHash: issues.some(({ severity }) => severity === "error") ? null : calculateNoteTypeDesignHash(css, templates),
    matches, issues,
  };
}
