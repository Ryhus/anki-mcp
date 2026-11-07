import assert from "node:assert/strict";
import test from "node:test";
import { addNoteTypeTemplateConfig } from "../mcp/tools/note-types/add-note-type-template.js";
import { deleteNoteTypeTemplateConfig } from "../mcp/tools/note-types/delete-note-type-template.js";
import { renameNoteTypeTemplateConfig } from "../mcp/tools/note-types/rename-note-type-template.js";
import { repositionNoteTypeTemplateConfig } from "../mcp/tools/note-types/reposition-note-type-template.js";
import {
  buildOtherTemplateCardsSearchQuery,
  buildTemplateCardsSearchQuery,
  createDesignRevisionIssue,
  hasSameTemplateDesign,
  repositionNoteTypeTemplates,
} from "../mcp/tools/note-types/note-type-template-utils.js";
import type { NoteTypeTemplateDesign } from "../mcp/tools/note-types/shared-schemas.js";

const templates: NoteTypeTemplateDesign[] = [
  {
    name: "Forward",
    order: 0,
    front: "{{Front}}",
    back: "{{Back}}",
  },
  {
    name: "Reverse",
    order: 1,
    front: "{{Back}}",
    back: "{{Front}}",
  },
  {
    name: "Listening",
    order: 2,
    front: "{{Audio}}",
    back: "{{Front}}",
  },
];

test("template repositioning preserves HTML and normalizes order", () => {
  const repositioned = repositionNoteTypeTemplates(
    templates,
    "Listening",
    0,
  );

  assert.deepEqual(
    repositioned.map(({ name, order }) => ({ name, order })),
    [
      { name: "Listening", order: 0 },
      { name: "Forward", order: 1 },
      { name: "Reverse", order: 2 },
    ],
  );
  assert.equal(repositioned[0]?.front, "{{Audio}}");
  assert.equal(
    hasSameTemplateDesign(repositioned, repositioned),
    true,
  );
  assert.equal(hasSameTemplateDesign(repositioned, templates), false);
});

test("template card searches escape names and support exclusion", () => {
  assert.equal(
    buildTemplateCardsSearchQuery('My "Type"', "Reverse_*"),
    'note:"My \\"Type\\"" card:"Reverse\\_\\*"',
  );
  assert.equal(
    buildOtherTemplateCardsSearchQuery("Basic", "Card 2"),
    'note:"Basic" -card:"Card 2"',
  );
});

test("template revision checks reject stale designs", () => {
  const currentHash = "b".repeat(64);

  assert.equal(
    createDesignRevisionIssue(currentHash, currentHash),
    undefined,
  );
  assert.equal(
    createDesignRevisionIssue("a".repeat(64), currentHash)?.code,
    "design_changed",
  );
});

test("template lifecycle apply inputs require reviewed impact", () => {
  const hash = "a".repeat(64);
  const addWithoutImpact = addNoteTypeTemplateConfig.inputSchema.safeParse({
    modelName: "Basic",
    templateName: "Reverse",
    front: "{{Back}}",
    back: "{{Front}}",
    dryRun: false,
    expectedDesignHash: hash,
  });
  const addConfirmed = addNoteTypeTemplateConfig.inputSchema.safeParse({
    modelName: "Basic",
    templateName: "Reverse",
    front: "{{Back}}",
    back: "{{Front}}",
    dryRun: false,
    expectedDesignHash: hash,
    expectedNoteCount: 10,
    confirmCardCreation: true,
  });
  const renameWithoutHash =
    renameNoteTypeTemplateConfig.inputSchema.safeParse({
      modelName: "Basic",
      oldTemplateName: "Card 1",
      newTemplateName: "Forward",
      dryRun: false,
    });
  const repositionWithoutHash =
    repositionNoteTypeTemplateConfig.inputSchema.safeParse({
      modelName: "Basic",
      templateName: "Card 1",
      newOrder: 0,
      dryRun: false,
    });
  const deleteWithoutImpact =
    deleteNoteTypeTemplateConfig.inputSchema.safeParse({
      modelName: "Basic",
      templateName: "Reverse",
      dryRun: false,
      expectedDesignHash: hash,
      confirmCardDeletion: true,
    });
  const deleteConfirmed =
    deleteNoteTypeTemplateConfig.inputSchema.safeParse({
      modelName: "Basic",
      templateName: "Reverse",
      dryRun: false,
      expectedDesignHash: hash,
      expectedCardCount: 10,
      expectedNotesLosingLastCardCount: 0,
      confirmCardDeletion: true,
    });

  assert.equal(addWithoutImpact.success, false);
  assert.equal(addConfirmed.success, true);
  assert.equal(renameWithoutHash.success, false);
  assert.equal(repositionWithoutHash.success, false);
  assert.equal(deleteWithoutImpact.success, false);
  assert.equal(deleteConfirmed.success, true);
});
