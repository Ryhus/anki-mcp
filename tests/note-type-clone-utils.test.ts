import assert from "node:assert/strict";
import test from "node:test";
import { buildNoteTypeCloneDefinition } from "../mcp/tools/note-types/note-type-clone-utils.js";
import type { NoteTypeDesign } from "../mcp/tools/note-types/shared-schemas.js";

const sourceDesign: NoteTypeDesign = {
  noteType: {
    id: 123,
    name: "Vocabulary",
    fields: [
      { name: "Back", order: 1 },
      { name: "Front", order: 0 },
    ],
  },
  css: ".card { color: navy; }",
  templates: [
    {
      name: "Reverse",
      order: 1,
      front: "{{Back}}",
      back: "{{Front}}",
    },
    {
      name: "Forward",
      order: 0,
      front: "{{Front}}",
      back: "{{Back}}",
    },
  ],
  designHash:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scopeWarning: "Shared design.",
};

test("clone definitions preserve ordered fields, templates, and CSS", () => {
  const definition = buildNoteTypeCloneDefinition(sourceDesign);

  assert.deepEqual(definition.inOrderFields, ["Front", "Back"]);
  assert.deepEqual(
    definition.cardTemplates.map(({ Name }) => Name),
    ["Forward", "Reverse"],
  );
  assert.equal(definition.css, sourceDesign.css);
  assert.equal(definition.isCloze, false);
  assert.equal(definition.isClozeDetected, false);
});

test("clone definitions detect cloze filters and allow an override", () => {
  const clozeDesign: NoteTypeDesign = {
    ...sourceDesign,
    templates: [
      {
        name: "Cloze",
        order: 0,
        front: "{{cloze:Text}}",
        back: "{{cloze:Text}}<br>{{Extra}}",
      },
    ],
  };

  const detected = buildNoteTypeCloneDefinition(clozeDesign);
  const overridden = buildNoteTypeCloneDefinition(clozeDesign, false);

  assert.equal(detected.isClozeDetected, true);
  assert.equal(detected.isCloze, true);
  assert.equal(overridden.isClozeDetected, true);
  assert.equal(overridden.isCloze, false);
});
