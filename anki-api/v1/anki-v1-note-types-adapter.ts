import { getManagedNoteTypeTemplateFields } from "../note-types/note-type-management-client.js";
import type { AnkiCreateNoteTypeInput, AnkiCreateNoteTypeTemplate, AnkiNoteTypeTemplateUpdates } from "../note-types/note-type-types.js";
import { getV1NameMap, getV1NoteTypeDesign, v1EntitySummarySchema } from "./anki-v1-collection-client.js";
import { ref, type V1AdapterContext, type V1Route } from "./anki-v1-adapter-utils.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";

const templateInput = ({ Name, Front, Back }: AnkiCreateNoteTypeTemplate) => ({
  name: Name, questionHtml: Front, answerHtml: Back,
});

function readDesign(ctx: V1AdapterContext, name: unknown) {
  return getV1NoteTypeDesign(name as string, ctx.session, ctx.options);
}

async function edit(ctx: V1AdapterContext, name: unknown, edits: Record<string, unknown>[]) {
  const method = "noteTypes.editStructure";
  const saved = await ctx.request(method, { noteType: ref(name as string), edits }, v1EntitySummarySchema);
  if (saved.name !== name) throw invalidAnkiV1Response(method);
  return null;
}

export const v1NoteTypeRoutes = {
  modelNamesAndIds: (_params, ctx) => getV1NameMap("noteTypes.list", ctx.session, ctx.options),
  async modelFieldNames({ modelName }, ctx) {
    return (await readDesign(ctx, modelName)).fields.map(({ name }) => name);
  },
  modelFieldsOnTemplates: ({ modelName }, ctx) => getManagedNoteTypeTemplateFields(ctx, ref(modelName as string)),
  async modelTemplates({ modelName }, ctx) {
    const { templates } = await readDesign(ctx, modelName);
    return Object.fromEntries(templates.map(({ name, questionHtml, answerHtml }) => [name, { Front: questionHtml, Back: answerHtml }]));
  },
  async modelStyling({ modelName }, ctx) {
    return { css: (await readDesign(ctx, modelName)).css };
  },
  async createModel(params, ctx) {
    const { modelName, inOrderFields, cardTemplates, css, isCloze } = params as unknown as AnkiCreateNoteTypeInput;
    const method = "noteTypes.create";
    const created = await ctx.request(method, {
      name: modelName, fields: inOrderFields.map(ref), templates: cardTemplates.map(templateInput),
      css, kind: isCloze ? "cloze" : "normal",
    }, v1EntitySummarySchema);
    if (created.name !== modelName) throw invalidAnkiV1Response(method);
    return created;
  },
  modelFieldAdd: ({ modelName, fieldName, index }, ctx) =>
    edit(ctx, modelName, [{ op: "addField", field: ref(fieldName as string), ...(index === undefined ? {} : { index }) }]),
  modelFieldRename: ({ modelName, oldFieldName, newFieldName }, ctx) =>
    edit(ctx, modelName, [{ op: "updateField", name: oldFieldName, patch: { name: newFieldName } }]),
  modelFieldReposition: ({ modelName, fieldName, index }, ctx) =>
    edit(ctx, modelName, [{ op: "moveField", name: fieldName, index }]),
  modelFieldRemove: ({ modelName, fieldName }, ctx) =>
    edit(ctx, modelName, [{ op: "removeField", name: fieldName }]),
  modelTemplateAdd: ({ modelName, template }, ctx) =>
    edit(ctx, modelName, [{ op: "addTemplate", template: templateInput(template as AnkiCreateNoteTypeTemplate) }]),
  modelTemplateRename: ({ modelName, oldTemplateName, newTemplateName }, ctx) =>
    edit(ctx, modelName, [{ op: "updateTemplate", name: oldTemplateName, patch: { name: newTemplateName } }]),
  modelTemplateReposition: ({ modelName, templateName, index }, ctx) =>
    edit(ctx, modelName, [{ op: "moveTemplate", name: templateName, index }]),
  modelTemplateRemove: ({ modelName, templateName }, ctx) =>
    edit(ctx, modelName, [{ op: "removeTemplate", name: templateName }]),
  updateModelTemplates: ({ model }, ctx) => {
    const { name, templates } = model as { name: string; templates: AnkiNoteTypeTemplateUpdates };
    return edit(ctx, name, Object.entries(templates).map(([name, { Front, Back }]) => ({
      op: "updateTemplate", name,
      patch: { ...(Front === undefined ? {} : { questionHtml: Front }), ...(Back === undefined ? {} : { answerHtml: Back }) },
    })));
  },
  async updateModelStyling({ model }, ctx) {
    const { name, css } = model as { name: string; css: string };
    const method = "noteTypes.update";
    const updated = await ctx.request(method, { noteType: ref(name), patch: { css } }, v1EntitySummarySchema);
    if (updated.name !== name) throw invalidAnkiV1Response(method);
    return null;
  },
} satisfies Record<string, V1Route>;
