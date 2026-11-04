import assert from "node:assert/strict";
import test from "node:test";
import { scanMediaReferencesInCss } from "../mcp/tools/media/media-css-reference-scanner.js";

const FILENAME = "cat.png";

test("CSS scans count exact URLs in rules, nested rules, fonts, and custom properties", () => {
  const css = `
    :root { --image: url("cat.png"); }
    @media (min-width: 100px) { .card { background: url(./cat.png); } }
    @font-face { src: url(cat.png); }
    .card { background-image: var(--image); }
  `;
  assert.deepEqual(scanMediaReferencesInCss(css, FILENAME), { occurrenceCount: 3, error: null });
});

test("valid CSS without matching references is distinguishable from a failed scan", () => {
  for (const css of ["", "/* url(cat.png) */", '.x { content: "url(cat.png)"; }', ".x { background: url(other.png); }"]) {
    assert.deepEqual(scanMediaReferencesInCss(css, FILENAME), { occurrenceCount: 0, error: null });
  }
});

test("URL scanning respects CSS escapes and does not confuse escaped delimiters with missing closures", () => {
  assert.deepEqual(scanMediaReferencesInCss(String.raw`.x { background: url(c\61 t.png); }`, FILENAME), {
    occurrenceCount: 1, error: null,
  });
  assert.deepEqual(scanMediaReferencesInCss(String.raw`.x { background: url(cat.png\)); content: "quote\""; }`, "cat.png)"), {
    occurrenceCount: 1, error: null,
  });
});

test("harmless empty declarations do not make the reference scan incomplete", () => {
  assert.deepEqual(scanMediaReferencesInCss(".x { ;; --empty: ; background: url(cat.png);; }", FILENAME), {
    occurrenceCount: 1, error: null,
  });
});

test("speculative grammar retries in valid nested supports conditions are not failures", () => {
  const css = `
    @supports ((-webkit-transform-style: preserve-3d) or (transform-style: preserve-3d)) {
      .card { background: url(cat.png); }
    }
  `;
  assert.deepEqual(scanMediaReferencesInCss(css, FILENAME), { occurrenceCount: 1, error: null });
});

test("recovered parser errors retain known references but mark their count incomplete", () => {
  const result = scanMediaReferencesInCss(".x { invalid; background: url(cat.png); }", FILENAME);
  assert.equal(result.occurrenceCount, 1);
  assert.match(result.error ?? "", /Colon is expected.*line 1, column/u);
});

test("unsupported opaque CSS cannot masquerade as a complete zero-reference scan", () => {
  const result = scanMediaReferencesInCss(".x { --opaque: { image: url(cat.png) }; }", FILENAME);
  assert.ok(result.error);
});

test("CSS failure positions handle CRLF, CR, LF, and form-feed line breaks", () => {
  for (const separator of ["\r\n", "\r", "\n", "\f"]) {
    const result = scanMediaReferencesInCss(`/* valid */${separator}/* unclosed`, FILENAME);
    assert.match(result.error ?? "", /line 2, column 1/u);
  }
});

for (const [label, css] of [
  ["unterminated comment", "/* url(cat.png)"],
  ["unterminated string", '.x { content: "cat.png'],
  ["escaped final quote", String.raw`.x { content: "cat.png\"`],
  ["unclosed block", ".x { background: url(cat.png);"],
  ["unclosed outer block after a closed inner block", "@media screen { .x { background: url(cat.png); }"],
  ["unclosed quoted URL", '.x { background: url("cat.png"'],
  ["unclosed unquoted URL", ".x { background: url(cat.png"],
  ["escaped final URL delimiter", String.raw`.x { background: url(cat.png\)`],
  ["malformed URL", '.x { background: url(cat.png"bad); }'],
  ["newline in string", '.x { content: "cat\n.png"; }'],
  ["unmatched closing delimiter", ".x { color: red; }}"],
  ["unclosed nested function", ".x { width: calc(1px + var(--width)"],
  ["opaque malformed supports condition", "@supports ((broken;)) { .x { background: url(cat.png); } }"],
] as const) {
  test(`CSS scan rejects ${label}, including implicit EOF recovery`, () => {
    const result = scanMediaReferencesInCss(css, FILENAME);
    assert.ok(result.error, `${label} must not be reported as a complete scan`);
    assert.match(result.error, /line \d+, column \d+/u);
    assert.ok(result.error.length < 400, "Only a bounded first diagnostic should be retained");
  });
}
