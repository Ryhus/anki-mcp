import type { AnkiRequestOptions } from "./anki-request-config.js";
import { AnkiRequestError } from "./anki-request-error.js";

const SAFE_NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED",
]);

/**
 * Sends exactly one POST, with no retry or redirect. The deadline includes
 * response-body loading. Racing abort also bounds non-cooperative adapters;
 * aborting the socket cannot undo a request that Anki has already received.
 */
export async function postAnkiRequest(
  action: string,
  body: string,
  config: { url: string; timeoutMs: number },
  options: AnkiRequestOptions,
): Promise<unknown> {
  if (options.signal?.aborted) {
    throw new AnkiRequestError(
      "cancelled", action, "Request was cancelled before sending.", false,
    );
  }
  const controller = new AbortController();
  let started = false;
  let completed = false;
  let response: Response | undefined;
  let interruption: AnkiRequestError | undefined;
  const { promise: aborted, reject: rejectAbort } = Promise.withResolvers<never>();
  const interrupt = (kind: "timeout" | "cancelled"): void => {
    if (interruption !== undefined) return;
    interruption = new AnkiRequestError(
      kind, action,
      kind === "timeout"
        ? `HTTP exchange timed out after ${config.timeoutMs} ms.`
        : "HTTP exchange was cancelled.",
      started, { timeoutMs: config.timeoutMs },
    );
    rejectAbort(interruption);
    controller.abort();
  };
  const onAbort = (): void => interrupt("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => interrupt("timeout"), config.timeoutMs);
  const execute = async (): Promise<unknown> => {
    try {
      started = true;
      response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body, signal: controller.signal, redirect: "manual",
      });
    } catch (error) {
      if (interruption) throw interruption;
      throw networkError(
        action, error,
        "Could not complete the connection. Check that Anki is running, AnkiConnect is enabled, and ANKI_URL and TLS settings are correct.",
      );
    }
    // A mocked/custom fetch can finish after the caller's deadline. Do not
    // read that late body; release it without creating another HTTP request.
    if (interruption) {
      discardBody(response);
      throw interruption;
    }
    if (!response.ok) {
      throw new AnkiRequestError(
        "http", action,
        `The endpoint returned HTTP ${response.status}. Check the API endpoint and any proxy/authentication settings; API redirects are not followed.`,
        true, { status: response.status },
      );
    }
    try {
      const payload: unknown = await response.json();
      if (interruption) throw interruption;
      return payload;
    } catch (error) {
      if (interruption) throw interruption;
      if (error instanceof SyntaxError) {
        throw new AnkiRequestError(
          "invalid-json", action,
          "The endpoint returned invalid JSON. Check that ANKI_URL points to the API, not an HTML page or login screen.", true,
        );
      }
      throw networkError(
        action, error,
        "The response body could not be read completely; the connection may have closed early.",
      );
    }
  };
  try {
    const payload = await Promise.race([execute(), aborted]);
    completed = true;
    return payload;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      controller.abort();
      if (response) discardBody(response);
    }
  }
}

function discardBody(response: Response): void {
  if (response.body && !response.body.locked) {
    void response.body.cancel().catch(() => {});
  }
}

function networkError(
  action: string, error: unknown, detail: string,
): AnkiRequestError {
  let current: unknown = error;
  let code: string | undefined;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string" && SAFE_NETWORK_CODES.has(current.code)) {
      code = current.code;
      break;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  // Do not retain native error messages/causes: these can embed URL credentials,
  // query tokens, response fragments, or request content.
  return new AnkiRequestError(
    "network", action, `${detail}${code ? ` Network code: ${code}.` : ""}`, true,
  );
}
