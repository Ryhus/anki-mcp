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
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "result" in value &&
    "error" in value &&
    (typeof value.error === "string" || value.error === null)
  );
}

export async function callAnki<TResult = unknown>(
  action: string,
  params?: AnkiRequestParams,
): Promise<AnkiResponse<TResult>> {
  const ankiUrl = process.env.ANKI_URL;

  if (ankiUrl === undefined) {
    throw new Error("ANKI_URL environment variable is not set");
  }

  const response = await fetch(ankiUrl, {
    method: "POST",
    body: JSON.stringify({
      action,
      version: ANKI_CONNECT_VERSION,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();

  if (!isAnkiResponse(payload)) {
    throw new Error("AnkiConnect returned an invalid response");
  }

  return payload as AnkiResponse<TResult>;
}

/**
 * Calls an AnkiConnect action and unwraps its result.
 *
 * @throws When AnkiConnect reports an action-level error.
 */
export async function invokeAnki<TResult = unknown>(
  action: string,
  params?: AnkiRequestParams,
): Promise<TResult> {
  const { result, error } = await callAnki<TResult>(action, params);

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
>(actions: TActions): Promise<AnkiMultiResults<TActions>> {
  if (actions.length === 0) {
    return [] as unknown as AnkiMultiResults<TActions>;
  }

  const nestedActions = actions.map(({ action, params }) => ({
    action,
    version: ANKI_CONNECT_VERSION,
    ...(params === undefined ? {} : { params }),
  }));
  const replies = await invokeAnki<unknown>("multi", {
    actions: nestedActions,
  });

  if (!Array.isArray(replies) || replies.length !== actions.length) {
    throw new Error(
      "AnkiConnect returned a misaligned multi-action response",
    );
  }

  const results = replies.map((reply, index) => {
    if (!isAnkiResponse(reply)) {
      throw new Error(
        `AnkiConnect returned an invalid response for multi action ${index}`,
      );
    }

    const action = actions[index];

    if (action === undefined) {
      throw new Error(
        `AnkiConnect returned an unexpected multi action at index ${index}`,
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
