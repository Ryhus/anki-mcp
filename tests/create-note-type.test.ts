import assert from "node:assert/strict";
import test from "node:test";
import {
  createNoteTypeConfig,
  DEFAULT_NOTE_TYPE_CSS,
} from "../mcp/tools/note-types/create-note-type.js";
import { validateNoteTypeDefinition } from "../mcp/tools/note-types/note-type-definition-validator.js";

const normalDefinition = {
  fieldNames: ["Front", "Back"],
  templates: [
    {
      name: "Forward",
      front: "{{Front}}",
      back: "{{FrontSide}}<hr>{{Back}}",
    },
  ],
  css: ".card { color: black; }",
  isCloze: false,
};

test("create-note-type input defaults to a dry-run Normal note type", () => {
  const parsed = createNoteTypeConfig.inputSchema.safeParse({
    modelName: "Vocabulary",
    fields: ["Front", "Back"],
    templates: normalDefinition.templates,
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) {
    return;
  }

  assert.equal(parsed.data.dryRun, true);
  assert.equal(parsed.data.isCloze, false);
  assert.equal(parsed.data.css, DEFAULT_NOTE_TYPE_CSS);
});

test("create-note-type input rejects ambiguous fields and templates", () => {
  const duplicateFields = createNoteTypeConfig.inputSchema.safeParse({
    modelName: "Vocabulary",
    fields: ["Front", "front"],
    templates: normalDefinition.templates,
  });
  const specialField = createNoteTypeConfig.inputSchema.safeParse({
    modelName: "Vocabulary",
    fields: ["Front", "Tags"],
    templates: normalDefinition.templates,
  });
  const duplicateTemplates =
    createNoteTypeConfig.inputSchema.safeParse({
      modelName: "Vocabulary",
      fields: ["Front", "Back"],
      templates: [
        ...normalDefinition.templates,
        {
          name: "forward",
          front: "{{Back}}",
          back: "{{Front}}",
        },
      ],
    });

  assert.equal(duplicateFields.success, false);
  assert.equal(specialField.success, false);
  assert.equal(duplicateTemplates.success, false);
});

test("new note type definitions validate fields, HTML, and CSS", () => {
  const valid = validateNoteTypeDefinition(normalDefinition);
  const unknownField = validateNoteTypeDefinition({
    ...normalDefinition,
    templates: [
      {
        name: "Forward",
        front: "{{Missing}}",
        back: "{{Back}}",
      },
    ],
  });
  const invalidCss = validateNoteTypeDefinition({
    ...normalDefinition,
    css: ".card { color: red;",
  });

  assert.equal(valid.valid, true);
  assert.equal(
    unknownField.issues.some(({ code }) => code === "unknown_field"),
    true,
  );
  assert.equal(invalidCss.valid, false);
});

test("Normal and Cloze definitions enforce compatible templates", () => {
  const clozeTemplate = {
    name: "Cloze",
    front: "{{cloze:Text}}",
    back: "{{cloze:Text}}<br>{{Extra}}",
  };
  const clozeAsNormal = validateNoteTypeDefinition({
    fieldNames: ["Text", "Extra"],
    templates: [clozeTemplate],
    css: normalDefinition.css,
    isCloze: false,
  });
  const validCloze = validateNoteTypeDefinition({
    fieldNames: ["Text", "Extra"],
    templates: [clozeTemplate],
    css: normalDefinition.css,
    isCloze: true,
  });
  const multipleClozeTemplates = validateNoteTypeDefinition({
    fieldNames: ["Text", "Extra"],
    templates: [clozeTemplate, { ...clozeTemplate, name: "Cloze 2" }],
    css: normalDefinition.css,
    isCloze: true,
  });

  assert.equal(clozeAsNormal.valid, false);
  assert.equal(validCloze.valid, true);
  assert.equal(
    multipleClozeTemplates.issues.some(
      ({ code }) => code === "cloze_note_type_requires_one_template",
    ),
    true,
  );
});
