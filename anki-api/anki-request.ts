import { postAnkiRequest } from "./anki-http-client.js";
import {
  resolveAnkiRequestConfig,
  type AnkiRequestOptions,
} from "./anki-request-config.js";
import { AnkiRequestError } from "./anki-request-error.js";

export { AnkiRequestError } from "./anki-request-error.js";
export type { AnkiRequestErrorKind } from "./anki-request-error.js";
export type { AnkiRequestOptions } from "./anki-request-config.js";

const ANKI_CONNECT_VERSION = 6;

export type AnkiRequestParams = Record<string, unknown>;

export interface AnkiAction<TResult = unknown> {
  action: string;
  params?: AnkiRequestParams;
  readonly __resultType?: TResult;
}

export interface AnkiResponse<TResult = unknown> {
  result: TResult;
  error: string | null;
}

type AnkiActionResult<TAction> =
  TAction extends AnkiAction<infer TResult> ? TResult : never;

type AnkiMultiResults<TActions extends readonly AnkiAction[]> = {
  -readonly [TIndex in keyof TActions]: AnkiActionResult<
    TActions[TIndex]
  >;
};

export class AnkiMultiActionError extends Error {
  readonly actionIndex: number;
  readonly action: string;

  constructor(actionIndex: number, action: string, message: string) {
    super(
      `AnkiConnect multi action ${actionIndex} "${action}" failed: ${message}`,
    );
    this.name = "AnkiMultiActionError";
    this.actionIndex = actionIndex;
    this.action = action;
  }
}

function isAnkiResponse(value: unknown): value is AnkiResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    Object.hasOwn(value, "result") &&
    Object.hasOwn(value, "error") && "error" in value &&
    (typeof value.error === "string" || value.error === null)
  );
}

/** Sends one bounded request and validates the AnkiConnect response envelope. */
export async function callAnki<TResult = unknown>(
  action: string,
  params?: AnkiRequestParams,
  options: AnkiRequestOptions = {},
): Promise<AnkiResponse<TResult>> {
  const config = resolveAnkiRequestConfig(action, options);
  let body: string;
  try {
    body = JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params });
  } catch {
    throw new AnkiRequestError(
      "invalid-request", action,
      "Request parameters could not be serialized as JSON.", false,
    );
  }
  const payload = await postAnkiRequest(action, body, config, options);
  if (!isAnkiResponse(payload)) {
    throw new AnkiRequestError(
      "invalid-response", action,
      "The endpoint returned an invalid AnkiConnect response envelope (expected result and error).", true,
    );
  }

  return payload as AnkiResponse<TResult>;
}

/**
 * Calls an AnkiConnect action and unwraps its result.
 *
 * @throws AnkiRequestError for configuration/transport failures, or Error when
 * AnkiConnect reports an action-level error. Requests are never retried here.
 */
export async function invokeAnki<TResult = unknown>(
  action: string,
  params?: AnkiRequestParams,
  options: AnkiRequestOptions = {},
): Promise<TResult> {
  const { result, error } = await callAnki<TResult>(action, params, options);

  if (error !== null) {
    throw new Error(`AnkiConnect action "${action}" failed: ${error}`);
  }

  return result;
}

/** Describes one typed action that can be bundled through AnkiConnect multi. */
export function createAnkiAction<TResult>(
  action: string,
  params?: AnkiRequestParams,
): AnkiAction<TResult> {
  return params === undefined ? { action } : { action, params };
}

/**
 * Runs multiple AnkiConnect actions in one HTTP request.
 *
 * AnkiConnect executes nested actions sequentially and returns one response
 * per action. This reduces HTTP round trips but is not an atomic transaction.
 */
export async function invokeAnkiMulti<
  const TActions extends readonly AnkiAction[],
>(
  actions: TActions,
  options: AnkiRequestOptions = {},
): Promise<AnkiMultiResults<TActions>> {
  if (actions.length === 0) {
    return [] as unknown as AnkiMultiResults<TActions>;
  }

  const nestedActions = actions.map(({ action, params }) => ({
    action,
    version: ANKI_CONNECT_VERSION,
    ...(params === undefined ? {} : { params }),
  }));
  const replies = await invokeAnki<unknown>(
    "multi", { actions: nestedActions }, options,
  );

  if (!Array.isArray(replies) || replies.length !== actions.length) {
    throw new AnkiRequestError(
      "invalid-response", "multi",
      "The endpoint returned a misaligned multi-action response.", true,
    );
  }

  const results = replies.map((reply, index) => {
    if (!isAnkiResponse(reply)) {
      throw new AnkiRequestError(
        "invalid-response", "multi",
        `The endpoint returned an invalid response for multi action ${index}.`, true,
      );
    }

    const action = actions[index];

    if (action === undefined) {
      throw new AnkiRequestError(
        "invalid-response", "multi",
        `The endpoint returned an unexpected multi action at index ${index}.`, true,
      );
    }

    if (reply.error !== null) {
      throw new AnkiMultiActionError(
        index,
        action.action,
        reply.error,
      );
    }

    return reply.result;
  });

  return results as AnkiMultiResults<TActions>;
}
