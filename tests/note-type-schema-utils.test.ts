import assert from "node:assert/strict";
import test from "node:test";
import { addNoteTypeFieldConfig } from "../mcp/tools/note-types/add-note-type-field.js";
import {
  calculateNoteTypeSchemaHash,
  createSchemaRevisionIssue,
  hasSameFieldOrder,
  repositionFieldNames,
} from "../mcp/tools/note-types/note-type-schema-utils.js";
import { renameNoteTypeFieldConfig } from "../mcp/tools/note-types/rename-note-type-field.js";
import { repositionNoteTypeFieldConfig } from "../mcp/tools/note-types/reposition-note-type-field.js";
import { newNoteTypeFieldNameSchema } from "../mcp/tools/note-types/shared-schemas.js";

test("schema hashes are stable and include field order", () => {
  const original = calculateNoteTypeSchemaHash(["Front", "Back"]);
  const repeated = calculateNoteTypeSchemaHash(["Front", "Back"]);
  const reordered = calculateNoteTypeSchemaHash(["Back", "Front"]);
  const added = calculateNoteTypeSchemaHash([
    "Front",
    "Back",
    "Hint",
  ]);

  assert.equal(original, repeated);
  assert.notEqual(original, reordered);
  assert.notEqual(original, added);
  assert.match(original, /^[a-f0-9]{64}$/);
});

test("field repositioning preserves values and moves only one name", () => {
  const original = ["Front", "Back", "Hint"];
  const reordered = repositionFieldNames(original, "Hint", 0);

  assert.deepEqual(reordered, ["Hint", "Front", "Back"]);
  assert.deepEqual(original, ["Front", "Back", "Hint"]);
  assert.equal(
    hasSameFieldOrder(reordered, ["Hint", "Front", "Back"]),
    true,
  );
  assert.equal(hasSameFieldOrder(reordered, original), false);
});

test("schema revision checks reject stale hashes", () => {
  const currentHash = calculateNoteTypeSchemaHash(["Front", "Back"]);

  assert.equal(
    createSchemaRevisionIssue(currentHash, currentHash),
    undefined,
  );
  assert.equal(
    createSchemaRevisionIssue(undefined, currentHash),
    undefined,
  );
  assert.equal(
    createSchemaRevisionIssue("a".repeat(64), currentHash)?.code,
    "note_type_schema_changed",
  );
});

test("new field names reject Anki special fields", () => {
  assert.equal(newNoteTypeFieldNameSchema.safeParse("Hint").success, true);
  assert.equal(newNoteTypeFieldNameSchema.safeParse("Tags").success, false);
  assert.equal(
    newNoteTypeFieldNameSchema.safeParse("frontside").success,
    false,
  );
});

test("field mutations require a schema hash when dryRun is false", () => {
  const add = addNoteTypeFieldConfig.inputSchema.safeParse({
    modelName: "Basic",
    fieldName: "Hint",
    dryRun: false,
  });
  const rename = renameNoteTypeFieldConfig.inputSchema.safeParse({
    modelName: "Basic",
    oldFieldName: "Back",
    newFieldName: "Answer",
    dryRun: false,
  });
  const reposition =
    repositionNoteTypeFieldConfig.inputSchema.safeParse({
      modelName: "Basic",
      fieldName: "Back",
      newOrder: 0,
      dryRun: false,
    });

  assert.equal(add.success, false);
  assert.equal(rename.success, false);
  assert.equal(reposition.success, false);
});
