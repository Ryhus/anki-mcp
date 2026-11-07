import assert from "node:assert/strict";
import test from "node:test";
import {
  AnkiMultiActionError,
  createAnkiAction,
  invokeAnkiMulti,
} from "../anki-api/anki-request.js";

test("invokeAnkiMulti unwraps aligned nested responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalAnkiUrl = process.env.ANKI_URL;

  process.env.ANKI_URL = "http://127.0.0.1:8765";
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      action: string;
      params: {
        actions: Array<{ action: string; version: number }>;
      };
    };

    assert.equal(request.action, "multi");
    assert.deepEqual(
      request.params.actions.map(({ action }) => action),
      ["version", "findNotes"],
    );
    assert.deepEqual(
      request.params.actions.map(({ version }) => version),
      [6, 6],
    );

    return Response.json({
      result: [
        { result: 6, error: null },
        { result: [1, 2], error: null },
      ],
      error: null,
    });
  };

  try {
    const [version, noteIds] = await invokeAnkiMulti([
      createAnkiAction<number>("version"),
      createAnkiAction<number[]>("findNotes", { query: "cat" }),
    ] as const);

    assert.equal(version, 6);
    assert.deepEqual(noteIds, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreAnkiUrl(originalAnkiUrl);
  }
});

test("invokeAnkiMulti reports the failing nested action", async () => {
  const originalFetch = globalThis.fetch;
  const originalAnkiUrl = process.env.ANKI_URL;

  process.env.ANKI_URL = "http://127.0.0.1:8765";
  globalThis.fetch = async () =>
    Response.json({
      result: [
        { result: [], error: null },
        { result: null, error: "invalid search" },
      ],
      error: null,
    });

  try {
    await assert.rejects(
      invokeAnkiMulti([
        createAnkiAction<number[]>("findNotes", { query: "" }),
        createAnkiAction<number[]>("findNotes", {
          query: '"re:invalid"',
        }),
      ] as const),
      (error: unknown) =>
        error instanceof AnkiMultiActionError &&
        error.actionIndex === 1 &&
        error.action === "findNotes",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreAnkiUrl(originalAnkiUrl);
  }
});

function restoreAnkiUrl(originalAnkiUrl: string | undefined): void {
  if (originalAnkiUrl === undefined) {
    delete process.env.ANKI_URL;
  } else {
    process.env.ANKI_URL = originalAnkiUrl;
  }
}
