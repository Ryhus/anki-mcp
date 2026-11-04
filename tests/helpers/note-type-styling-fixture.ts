import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { calculateNoteTypeDesignHash, normalizeAnkiTemplates } from "../../mcp/tools/note-types/note-type-design-utils.js";
import { updateNoteTypeStylingConfig } from "../../mcp/tools/note-types/update-note-type-styling.js";

export const STYLE_MODEL_NAME = "Styling fixture";
export const ORIGINAL_CSS = ".card { color: black; }";
export const UPDATED_CSS = ".card { color: blue; }\n";

export function mockNoteTypeStyling(t: TestContext) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  const state = {
    id: 123, css: ORIGINAL_CSS, fields: ["Front", "Back"],
    templates: {
      Forward: { Front: "{{Front}}", Back: "{{FrontSide}}<hr>{{Back}}" },
      Reverse: { Front: "{{Back}}", Back: "{{Front}}" },
    } as Record<string, { Front: string; Back: string }>,
    requests: [] as Array<{ action: string; params: Record<string, unknown> }>,
    writes: 0, noop: false, throwBefore: false, throwAfter: false,
    acknowledgement: null as unknown,
    initialOverrides: new Map<string, unknown>(),
    readbackOverrides: new Map<string, unknown>(),
    failReadbackAction: "",
    afterWrite: undefined as (() => void) | undefined,
  };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { action, params = {} } = JSON.parse(String(init?.body)) as (typeof state.requests)[number];
    state.requests.push({ action, params });
    let result: unknown;
    if (action === "updateModelStyling") {
      state.writes += 1;
      assert.deepEqual(Object.keys(params), ["model"]);
      const model = params.model as { name: string; css: string };
      assert.equal(model.name, STYLE_MODEL_NAME);
      if (state.throwBefore) throw new TypeError("Simulated connection failure");
      if (!state.noop) state.css = model.css;
      state.afterWrite?.();
      if (state.throwAfter) throw new TypeError("Simulated lost acknowledgement");
      result = state.acknowledgement;
    } else {
      assert.ok(["modelNamesAndIds", "modelFieldNames", "modelStyling", "modelTemplates"].includes(action));
      if (state.writes > 0 && state.failReadbackAction === action) {
        return Response.json({ result: null, error: "Simulated readback failure" });
      }
      if (action !== "modelNamesAndIds") assert.equal(params.modelName, STYLE_MODEL_NAME);
      const overrides = state.writes > 0 ? state.readbackOverrides : state.initialOverrides;
      if (overrides.has(action)) result = overrides.get(action);
      else switch (action) {
        case "modelNamesAndIds": result = { [STYLE_MODEL_NAME]: state.id }; break;
        case "modelFieldNames": result = state.fields; break;
        case "modelStyling": result = { css: state.css }; break;
        case "modelTemplates": result = state.templates; break;
      }
    }
    return Response.json({ result, error: null });
  });
  return state;
}

export function stylingHash(state: ReturnType<typeof mockNoteTypeStyling>): string {
  return calculateNoteTypeDesignHash(state.css, normalizeAnkiTemplates(state.templates));
}

export function stylingInput(overrides: Record<string, unknown> = {}) {
  return updateNoteTypeStylingConfig.inputSchema.parse({
    modelName: STYLE_MODEL_NAME, css: UPDATED_CSS, ...overrides,
  });
}
