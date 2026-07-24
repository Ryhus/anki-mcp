const ANKI_CONNECT_VERSION = 6;

export type AnkiRequestParams = Record<string, unknown>;

export interface AnkiResponse<TResult = unknown> {
  result: TResult;
  error: string | null;
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
