import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_ANKI_REQUEST_TIMEOUT_MS,
  MAX_ANKI_REQUEST_TIMEOUT_MS,
  resolveAnkiRequestConfig,
} from "../anki-api/anki-request-config.js";
import { AnkiRequestError, callAnki } from "../anki-api/anki-request.js";

function configure(t: TestContext): void {
  const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  delete process.env.ANKI_REQUEST_TIMEOUT_MS;
}

test("request configuration resolves default, environment, and per-call deadlines", (t) => {
  configure(t);
  assert.equal(DEFAULT_ANKI_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(resolveAnkiRequestConfig("version", {}).timeoutMs, 30_000);
  process.env.ANKI_REQUEST_TIMEOUT_MS = " 12000 ";
  assert.equal(resolveAnkiRequestConfig("version", {}).timeoutMs, 12_000);
  assert.equal(resolveAnkiRequestConfig("version", { timeoutMs: 50 }).timeoutMs, 50);
  process.env.ANKI_REQUEST_TIMEOUT_MS = "invalid";
  assert.equal(resolveAnkiRequestConfig("version", { timeoutMs: 75 }).timeoutMs, 75);
  for (const timeoutMs of [1, MAX_ANKI_REQUEST_TIMEOUT_MS]) {
    assert.equal(resolveAnkiRequestConfig("version", { timeoutMs }).timeoutMs, timeoutMs);
  }
  process.env.ANKI_URL = " https://example.com/api?token=secret ";
  assert.equal(resolveAnkiRequestConfig("version", { timeoutMs: 1 }).url, "https://example.com/api?token=secret");
});

test("invalid endpoint configuration fails before fetch without disclosing the endpoint", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send"));
  for (const value of [undefined, "", " ", "secret", "/secret", "file:///secret", "ftp://secret", "http://user:secret@example.com"]) {
    if (value === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = value;
    await assert.rejects(callAnki("version"), (error: unknown) => {
      assert.ok(error instanceof AnkiRequestError);
      assert.equal(error.kind, "configuration");
      assert.equal(error.mayHaveExecuted, false);
      assert.match(error.message, /No HTTP request was sent/u);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    });
  }
});

test("invalid deadline values fail before fetch rather than disabling the timeout", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send"));
  for (const value of ["", " ", "0", "-1", "1.5", "1e3", "Infinity", "NaN", "300001", "secret", "9007199254740992"]) {
    process.env.ANKI_REQUEST_TIMEOUT_MS = value;
    await assert.rejects(callAnki("version"), (error: unknown) =>
      error instanceof AnkiRequestError && error.kind === "configuration" && !error.mayHaveExecuted,
    );
  }
  delete process.env.ANKI_REQUEST_TIMEOUT_MS;
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 300_001]) {
    await assert.rejects(callAnki("version", undefined, { timeoutMs }), (error: unknown) =>
      error instanceof AnkiRequestError && error.kind === "configuration" && !error.mayHaveExecuted,
    );
  }
});

test("unserializable parameters fail before fetch without exposing their contents", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send"));
  const circular: Record<string, unknown> = { secret: "private-note" };
  circular.self = circular;
  for (const params of [{ id: 1n }, circular, { toJSON: () => { throw new Error("private-note"); } }]) {
    await assert.rejects(callAnki("updateNoteFields", params), (error: unknown) => {
      assert.ok(error instanceof AnkiRequestError);
      assert.equal(error.kind, "invalid-request");
      assert.equal(error.mayHaveExecuted, false);
      assert.doesNotMatch(error.message, /private-note/u);
      return true;
    });
  }
});
