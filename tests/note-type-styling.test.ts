import assert from "node:assert/strict";
import test from "node:test";
import { updateAnkiNoteTypeStyling } from "../anki-api/note-types/note-type-client.js";
import { updateNoteTypeStyling, updateNoteTypeStylingConfig } from "../mcp/tools/note-types/update-note-type-styling.js";
import { ORIGINAL_CSS, STYLE_MODEL_NAME, UPDATED_CSS, mockNoteTypeStyling, stylingHash, stylingInput } from "./helpers/note-type-styling-fixture.js";

test("styling defaults to dry run without adding input or output parameters", async (t) => {
  const state = mockNoteTypeStyling(t);
  const input = stylingInput();
  assert.equal(input.dryRun, true);
  assert.equal(input.expectedDesignHash, undefined);
  const result = updateNoteTypeStylingConfig.outputSchema.parse((await updateNoteTypeStyling(input)).structuredContent);
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.equal(result.beforeHash, stylingHash(state));
  assert.notEqual(result.afterHash, result.beforeHash);
  assert.equal(state.writes, 0);
  assert.equal(state.requests.length, 4);
  assert.deepEqual(Object.keys(result).sort(), ["modelName", "dryRun", "applied", "changed", "beforeHash", "afterHash", "previousCss", "css", "validation", "scopeWarning"].sort());
});

test("styling writes once and reports the exact verified CSS/design hash", async (t) => {
  const state = mockNoteTypeStyling(t);
  const beforeHash = stylingHash(state);
  const templates = structuredClone(state.templates);
  const response = await updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: beforeHash }));
  const result = updateNoteTypeStylingConfig.outputSchema.parse(response.structuredContent);
  assert.equal(result.applied, true);
  assert.equal(result.beforeHash, beforeHash);
  assert.equal(result.afterHash, stylingHash(state));
  assert.equal(result.previousCss, ORIGINAL_CSS);
  assert.equal(result.css, UPDATED_CSS);
  assert.equal(state.css, UPDATED_CSS);
  assert.deepEqual(state.templates, templates);
  assert.equal(state.writes, 1);
  assert.equal(state.requests.length, 9);
  assert.deepEqual(state.requests[4], { action: "updateModelStyling", params: { model: { name: STYLE_MODEL_NAME, css: UPDATED_CSS } } });
  assert.match(JSON.stringify(response.content), /Updated and verified/u);
});

for (const css of ["", '.card::before { content: "猫 🏠"; }\n\n']) {
  test(`exact CSS preservation supports ${css === "" ? "empty" : "Unicode and whitespace"} content`, async (t) => {
    const state = mockNoteTypeStyling(t);
    const response = await updateNoteTypeStyling(stylingInput({ css, dryRun: false, expectedDesignHash: stylingHash(state) }));
    assert.equal(updateNoteTypeStylingConfig.outputSchema.parse(response.structuredContent).css, css);
    assert.equal(state.css, css);
  });
}

test("matching CSS skips the write and all extra readback requests", async (t) => {
  const state = mockNoteTypeStyling(t);
  const response = await updateNoteTypeStyling(stylingInput({ css: ORIGINAL_CSS, dryRun: false, expectedDesignHash: stylingHash(state) }));
  const result = updateNoteTypeStylingConfig.outputSchema.parse(response.structuredContent);
  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.equal(result.beforeHash, result.afterHash);
  assert.equal(state.writes, 0);
  assert.equal(state.requests.length, 4);
});

test("invalid CSS and stale design hashes block writing", async (t) => {
  const state = mockNoteTypeStyling(t);
  for (const patch of [{ css: ".card { color red; }", expectedDesignHash: stylingHash(state) }, { expectedDesignHash: "0".repeat(64) }]) {
    const response = await updateNoteTypeStyling(stylingInput({ dryRun: false, ...patch }));
    const result = updateNoteTypeStylingConfig.outputSchema.parse(response.structuredContent);
    assert.equal(result.applied, false);
    assert.equal(result.validation.valid, false);
  }
  assert.equal(state.writes, 0);
});

test("the exported handler also refuses apply without a current design hash", async (t) => {
  const state = mockNoteTypeStyling(t);
  const response = await updateNoteTypeStyling({ modelName: STYLE_MODEL_NAME, css: UPDATED_CSS, dryRun: false });
  const result = updateNoteTypeStylingConfig.outputSchema.parse(response.structuredContent);
  assert.equal(result.applied, false);
  assert.ok(result.validation.issues.some(({ code }) => code === "design_hash_required"));
  assert.equal(state.writes, 0);
});

test("a noop acknowledgement cannot be reported as applied CSS", async (t) => {
  const state = mockNoteTypeStyling(t);
  state.noop = true;
  await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /acknowledged.*verification failed.*No automatic retry.*saved CSS or Card Templates/u);
  assert.equal(state.writes, 1);
  assert.equal(state.css, ORIGINAL_CSS);
});

test("even whitespace-only backend normalization fails exact CSS verification", async (t) => {
  const state = mockNoteTypeStyling(t);
  state.afterWrite = () => { state.css = state.css.trimEnd(); };
  await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /acknowledged.*verification failed/u);
  assert.equal(state.writes, 1);
});

for (const phase of ["before", "after"] as const) {
  test(`${phase}-write connection failures report uncertainty without retrying`, async (t) => {
    const state = mockNoteTypeStyling(t);
    state.throwBefore = phase === "before";
    state.throwAfter = phase === "after";
    await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /Could not confirm.*CSS may already have changed.*No automatic retry or rollback/u);
    assert.equal(state.writes, 1);
    assert.equal(state.css, phase === "before" ? ORIGINAL_CSS : UPDATED_CSS);
    assert.equal(state.requests.length, 5, "no extra read, retry, or rollback after an unconfirmed write");
  });
}

for (const acknowledgement of [true, false, 0, "null", [], {}]) {
  test(`invalid update acknowledgement ${JSON.stringify(acknowledgement)} fails even if CSS was saved`, async (t) => {
    const state = mockNoteTypeStyling(t);
    state.acknowledgement = acknowledgement;
    await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /Could not confirm.*invalid CSS update acknowledgement/u);
    assert.equal(state.css, UPDATED_CSS);
    assert.equal(state.writes, 1);
    assert.equal(state.requests.length, 5);
  });
}

test("valid null CSS acknowledgement remains compatible for low-level callers", async (t) => {
  const state = mockNoteTypeStyling(t);
  assert.equal(await updateAnkiNoteTypeStyling(STYLE_MODEL_NAME, UPDATED_CSS), null);
  assert.equal(state.writes, 1);
});

for (const action of ["modelNamesAndIds", "modelFieldNames", "modelStyling", "modelTemplates"]) {
  test(`failure reading ${action} after a write is an acknowledged verification failure`, async (t) => {
    const state = mockNoteTypeStyling(t);
    state.failReadbackAction = action;
    await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /acknowledged.*verification failed.*CSS may already have changed/u);
    assert.equal(state.css, UPDATED_CSS);
    assert.equal(state.writes, 1);
  });
}

for (const mutation of ["front", "back", "name", "order", "added", "removed"] as const) {
  test(`an unexpected template ${mutation} change prevents successful CSS verification`, async (t) => {
    const state = mockNoteTypeStyling(t);
    state.afterWrite = () => {
      const forward = state.templates.Forward!;
      const reverse = state.templates.Reverse!;
      switch (mutation) {
        case "front": forward.Front = "<b>{{Front}}</b>"; break;
        case "back": forward.Back = "<b>{{Back}}</b>"; break;
        case "name": state.templates = { Renamed: forward, Reverse: reverse }; break;
        case "order": state.templates = { Reverse: reverse, Forward: forward }; break;
        case "added": state.templates.Third = { Front: "{{Front}}", Back: "{{Back}}" }; break;
        case "removed": delete state.templates.Reverse; break;
      }
    };
    await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /acknowledged.*verification failed.*saved CSS or Card Templates/u);
    assert.equal(state.writes, 1);
  });
}

test("a same-name replacement Note Type cannot pass CSS verification", async (t) => {
  const state = mockNoteTypeStyling(t);
  state.afterWrite = () => { state.id += 1; };
  await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), /verification failed.*identity changed/u);
});

for (const [action, result] of [
  ["modelNamesAndIds", {}], ["modelNamesAndIds", { [STYLE_MODEL_NAME]: "123" }],
  ["modelStyling", {}], ["modelStyling", { css: 123 }],
  ["modelTemplates", { Forward: { Front: "private-html", Back: null } }],
] as const) {
  for (const phase of ["before", "after"] as const) {
    test(`invalid ${action} payload ${JSON.stringify(result)} ${phase} writing cannot produce success`, async (t) => {
      const state = mockNoteTypeStyling(t);
      (phase === "before" ? state.initialOverrides : state.readbackOverrides).set(action, result);
      await assert.rejects(updateNoteTypeStyling(stylingInput({ dryRun: false, expectedDesignHash: stylingHash(state) })), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-html/u);
        if (phase === "after") assert.match(error.message, /acknowledged.*verification failed/u);
        return true;
      });
      assert.equal(state.writes, phase === "before" ? 0 : 1);
    });
  }
}
