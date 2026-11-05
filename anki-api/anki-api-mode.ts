import { AnkiRequestError } from "./anki-request-error.js";

/** Selects v1 for migrated operations; other operations keep their legacy path. */
export function useAnkiV1(action: string): boolean {
  const mode = process.env.ANKI_API_MODE?.trim() ?? "legacy";
  if (mode === "legacy") return false;
  if (mode === "v1") return true;
  throw new AnkiRequestError(
    "configuration", action, "ANKI_API_MODE must be legacy or v1.", false,
  );
}
