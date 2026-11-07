import { AnkiRequestError } from "./anki-request-error.js";

export const DEFAULT_ANKI_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ANKI_REQUEST_TIMEOUT_MS = 300_000;

export interface AnkiRequestOptions {
  /** Overrides the deadline for queue waiting and one complete HTTP exchange. */
  timeoutMs?: number;
  /** Optional low-level caller cancellation; MCP context is not wired here. */
  signal?: AbortSignal;
}

/** Resolves per-call configuration without logging potentially sensitive URLs. */
export function resolveAnkiRequestConfig(
  action: string,
  options: AnkiRequestOptions,
): { url: string; timeoutMs: number } {
  const rawUrl = process.env.ANKI_URL?.trim();
  if (!rawUrl) {
    throw new AnkiRequestError(
      "configuration", action,
      "ANKI_URL environment variable is not set or is empty.", false,
    );
  }
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Invalid endpoint");
    }
  } catch {
    throw new AnkiRequestError(
      "configuration", action,
      "ANKI_URL must be an absolute HTTP(S) URL without embedded credentials.", false,
    );
  }
  const configured = process.env.ANKI_REQUEST_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? (
    configured === undefined ? DEFAULT_ANKI_REQUEST_TIMEOUT_MS : Number(configured.trim())
  );
  const validText = options.timeoutMs !== undefined || configured === undefined ||
    /^\d+$/u.test(configured.trim());
  if (
    !validText || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 || timeoutMs > MAX_ANKI_REQUEST_TIMEOUT_MS
  ) {
    throw new AnkiRequestError(
      "configuration", action,
      `ANKI_REQUEST_TIMEOUT_MS or timeoutMs must be an integer from 1 to ${MAX_ANKI_REQUEST_TIMEOUT_MS} milliseconds.`, false,
    );
  }
  return { url: rawUrl, timeoutMs };
}
