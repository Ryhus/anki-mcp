import assert from "node:assert/strict";
import test from "node:test";
import { addNoteTypeField, addNoteTypeFieldConfig } from "../mcp/tools/note-types/add-note-type-field.js";
import { addNoteTypeTemplate, addNoteTypeTemplateConfig } from "../mcp/tools/note-types/add-note-type-template.js";
import { ankiStructureNameKey } from "../mcp/tools/note-types/anki-structure-names.js";
import { cloneNoteType, cloneNoteTypeConfig } from "../mcp/tools/note-types/clone-note-type.js";
import { createNoteTypeConfig } from "../mcp/tools/note-types/create-note-type.js";
import { calculateNoteTypeDesignHash, normalizeAnkiTemplates } from "../mcp/tools/note-types/note-type-design-utils.js";
import { calculateNoteTypeSchemaHash } from "../mcp/tools/note-types/note-type-schema-utils.js";
import { renameNoteTypeField, renameNoteTypeFieldConfig } from "../mcp/tools/note-types/rename-note-type-field.js";
import { renameNoteTypeTemplate, renameNoteTypeTemplateConfig } from "../mcp/tools/note-types/rename-note-type-template.js";

test("Anki field and template keys apply NFC and Unicode case folding without stripping template punctuation", () => {
  const field = (name: string) => ankiStructureNameKey(name, "field");
  const template = (name: string) => ankiStructureNameKey(name, "template");
  assert.equal(field(' #"^/{F:rOnt}"\u0085'), field("Front"));
  assert.equal(template("CAFÉ"), template("cafe\u0301"));
  assert.equal(template("Straẞe"), template("STRASSE"));
  assert.equal(template("ΟΣ"), template("ος"));
  assert.equal(template("ꭰ"), template("Ꭰ"));
  assert.notEqual(template("ı"), template("I"));
  assert.notEqual(template("Card:1"), template("Card1"));
  assert.notEqual(field("Back"), field("Bäck"));
});

test("create-note-type rejects collisions with Anki-normalized field or template names", () => {
  const templates = [
    { name: "Café", front: "{{Front}}", back: "{{Back}}" },
    { name: "cafe\u0301", front: "{{Back}}", back: "{{Front}}" },
  ];
  const base = { modelName: "New", fields: ["Front", "Back"], templates: templates.slice(0, 1) };
  assert.ok(createNoteTypeConfig.inputSchema.safeParse(base).success);
  assert.equal(createNoteTypeConfig.inputSchema.safeParse({ ...base, fields: ["Front", "#f:rOnt"] }).success, false);
  assert.equal(createNoteTypeConfig.inputSchema.safeParse({ ...base, templates }).success, false);
});

test("structure edits block colliding previews and writes but allow renaming the same entry", async (t) => {
  const { ANKI_API_MODE, ANKI_URL } = process.env;
  process.env.ANKI_API_MODE = "legacy";
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (ANKI_API_MODE === undefined) delete process.env.ANKI_API_MODE;
    else process.env.ANKI_API_MODE = ANKI_API_MODE;
    if (ANKI_URL === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = ANKI_URL;
  });
  const modelName = "Fixture";
  const fields = ["Front", "Back"];
  const templates = {
    Café: { Front: "{{Front}}", Back: "{{Back}}" },
    Other: { Front: "{{Back}}", Back: "{{Front}}" },
  };
  const css = "";
  const expectedSchemaHash = calculateNoteTypeSchemaHash(fields);
  const expectedDesignHash = calculateNoteTypeDesignHash(css, normalizeAnkiTemplates(templates));
  const reads: Record<string, unknown> = {
    modelNamesAndIds: { Fixture: 123 }, modelFieldNames: fields, modelFieldsOnTemplates: {},
    modelTemplates: templates, modelStyling: { css }, findNotes: [],
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { action } = JSON.parse(String(init.body)) as { action: string };
    assert.ok(Object.hasOwn(reads, action), `Unexpected write or action: ${action}`);
    return Response.json({ result: reads[action], error: null });
  });
  const collided = (result: { applied: boolean; changed: boolean; validation: { valid: boolean; issues: { code: string }[] } }, code: string) => {
    assert.equal(result.applied, false);
    assert.equal(result.changed, false);
    assert.equal(result.validation.valid, false);
    assert.ok(result.validation.issues.some((issue) => issue.code === code));
  };
  for (const dryRun of [true, false]) {
    const fieldArgs = { modelName, dryRun, expectedSchemaHash };
    const templateArgs = { modelName, dryRun, expectedDesignHash, expectedNoteCount: 0, confirmCardCreation: true };
    const addField = await addNoteTypeField(addNoteTypeFieldConfig.inputSchema.parse({ ...fieldArgs, fieldName: "front" }));
    collided(addNoteTypeFieldConfig.outputSchema.parse(addField.structuredContent), "field_already_exists");
    const renameField = await renameNoteTypeField(renameNoteTypeFieldConfig.inputSchema.parse({ ...fieldArgs, oldFieldName: "Back", newFieldName: "^FR:ONT" }));
    collided(renameNoteTypeFieldConfig.outputSchema.parse(renameField.structuredContent), "field_already_exists");
    const addTemplate = await addNoteTypeTemplate(addNoteTypeTemplateConfig.inputSchema.parse({
      ...templateArgs, templateName: "cafe\u0301", front: "<b>{{Front}}</b>", back: "{{Back}}",
    }));
    collided(addNoteTypeTemplateConfig.outputSchema.parse(addTemplate.structuredContent), "template_already_exists");
    const renameTemplate = await renameNoteTypeTemplate(renameNoteTypeTemplateConfig.inputSchema.parse({
      ...templateArgs, oldTemplateName: "Other", newTemplateName: "CAFE\u0301",
    }));
    collided(renameNoteTypeTemplateConfig.outputSchema.parse(renameTemplate.structuredContent), "template_already_exists");
  }

  const renameField = await renameNoteTypeField(renameNoteTypeFieldConfig.inputSchema.parse({ modelName, oldFieldName: "Front", newFieldName: "front" }));
  const fieldPreview = renameNoteTypeFieldConfig.outputSchema.parse(renameField.structuredContent);
  assert.equal(fieldPreview.validation.valid, true);
  assert.equal(fieldPreview.fields[0]?.name, "front");
  const renameTemplate = await renameNoteTypeTemplate(renameNoteTypeTemplateConfig.inputSchema.parse({ modelName, oldTemplateName: "Café", newTemplateName: "CAFÉ" }));
  const templatePreview = renameNoteTypeTemplateConfig.outputSchema.parse(renameTemplate.structuredContent);
  assert.equal(templatePreview.validation.valid, true);
  assert.equal(templatePreview.templates[0]?.name, "CAFÉ");

  reads.modelFieldNames = ["Front", "front"];
  reads.modelTemplates = { ...templates, "cafe\u0301": templates.Other };
  const clone = await cloneNoteType(cloneNoteTypeConfig.inputSchema.parse({ sourceModelName: modelName, targetModelName: "Copy" }));
  const clonePreview = cloneNoteTypeConfig.outputSchema.parse(clone.structuredContent);
  assert.equal(clonePreview.created, false);
  assert.deepEqual(clonePreview.validation.issues.map(({ code }) => code), ["duplicate_field_names", "duplicate_template_names"]);
});
