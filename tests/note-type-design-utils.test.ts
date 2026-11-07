import assert from "node:assert/strict";
import test from "node:test";
import { validateCss } from "../mcp/tools/note-types/css-validator.js";
import { calculateNoteTypeDesignHash } from "../mcp/tools/note-types/note-type-design-utils.js";
import { validateTemplateSide } from "../mcp/tools/note-types/template-validator.js";
import type { NoteTypeTemplateDesign } from "../mcp/tools/note-types/shared-schemas.js";

const templates: NoteTypeTemplateDesign[] = [
  {
    name: "Card 1",
    order: 0,
    front: "{{Front}}",
    back: "{{FrontSide}}<hr>{{Back}}",
  },
];

test("design hashes are stable and change with CSS or HTML", () => {
  const original = calculateNoteTypeDesignHash(".card {}", templates);
  const repeated = calculateNoteTypeDesignHash(".card {}", templates);
  const changedCss = calculateNoteTypeDesignHash(
    ".card { color: blue; }",
    templates,
  );
  const changedHtml = calculateNoteTypeDesignHash(".card {}", [
    { ...templates[0]!, front: "<strong>{{Front}}</strong>" },
  ]);

  assert.equal(original, repeated);
  assert.notEqual(original, changedCss);
  assert.notEqual(original, changedHtml);
  assert.match(original, /^[a-f0-9]{64}$/);
});

test("CSS validation accepts balanced blocks, strings, and comments", () => {
  const validation = validateCss(`
    /* braces in comments do not count: { */
    .card::before { content: "}"; }
    @media (prefers-color-scheme: dark) {
      .card { color: white; }
    }
  `);

  assert.equal(validation.valid, true);
  assert.equal(validation.errorCount, 0);
});

test("CSS validation reports unclosed blocks and external resources", () => {
  const validation = validateCss(`
    @import url("https://example.com/cards.css");
    .card { color: red;
  `);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.issues.some(({ code }) => code === "unclosed_block"),
  );
  assert.ok(
    validation.issues.some(({ code }) => code === "external_resource"),
  );
});

test("CSS validation reports syntax errors recovered by css-tree", () => {
  const validation = validateCss(".card { color red; }");

  assert.equal(validation.valid, false);
  assert.ok(
    validation.issues.some(({ code }) => code === "css_syntax_error"),
  );
  assert.ok(
    validation.issues.some(({ message }) =>
      message.includes("line 1, column 15"),
    ),
  );
});

test("CSS validation reports unterminated comments and strings", () => {
  const unterminatedComment = validateCss("/* not closed");
  const unterminatedString = validateCss('.card { content: "not closed }');

  assert.ok(
    unterminatedComment.issues.some(
      ({ code }) => code === "unterminated_comment",
    ),
  );
  assert.ok(
    unterminatedString.issues.some(
      ({ code }) => code === "unterminated_string",
    ),
  );
});

test("template validation accepts Anki filters and conditional sections", () => {
  const validation = validateTemplateSide({
    html: "{{#Hint}}{{hint:Hint}}{{/Hint}}{{type:Front}}",
    fieldNames: ["Front", "Hint"],
    path: "front",
    requireFieldReference: true,
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.errorCount, 0);
});

test("template validation recognizes Anki's voice-list directive", () => {
  const validation = validateTemplateSide({
    html: "{{tts-voices:}}{{Front}}",
    fieldNames: ["Front"],
    path: "front",
    requireFieldReference: true,
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.errorCount, 0);
});

test("template validation rejects unknown fields and missing front fields", () => {
  const unknownField = validateTemplateSide({
    html: "{{Missing}}",
    fieldNames: ["Front"],
    path: "front",
    requireFieldReference: true,
  });
  const staticFront = validateTemplateSide({
    html: "<p>Static question</p>",
    fieldNames: ["Front"],
    path: "front",
    requireFieldReference: true,
  });

  assert.ok(
    unknownField.issues.some(({ code }) => code === "unknown_field"),
  );
  assert.ok(
    staticFront.issues.some(({ code }) => code === "front_without_field"),
  );
});

test("template validation warns about executable content", () => {
  const validation = validateTemplateSide({
    html: "{{Front}}<script>console.log('review')</script>",
    fieldNames: ["Front"],
    path: "front",
    requireFieldReference: true,
  });

  assert.equal(validation.valid, true);
  assert.ok(
    validation.issues.some(({ code }) => code === "executable_content"),
  );
});
