import { z } from "zod";
import { findAnkiCards } from "../../../anki-api/cards/card-client.js";

interface DueRange {
  start: number;
  end: number;
}

export const cardDueSchema = z.string().trim().max(32).regex(
  /^\d+(?:-\d+)?!?$/u,
  'Use Anki Set Due Date syntax such as "0", "1!", or "3-7"',
).refine((value) => {
  const { start, end } = parseDueRange(value);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end >= start && end <= 2_147_483_647;
}, { message: "Due dates must be ascending nonnegative 32-bit integer day offsets" });

function parseDueRange(value: string): DueRange {
  const [first, last] = value.replace(/!$/u, "").split("-");
  const start = Number(first);
  return { start, end: last === undefined ? start : Number(last) };
}

/** Uses Anki's own scheduler day/rollover, not the MCP host's calendar date. */
export async function verifyCardDueDates(cardIds: number[], due: string): Promise<void> {
  if (cardIds.length === 0) return;
  const { start, end } = parseDueRange(due);
  const matches: unknown = await findAnkiCards(
    `cid:${cardIds.join(",")} prop:due>=${start} prop:due<=${end}`,
  );
  const expected = new Set(cardIds);
  if (
    !Array.isArray(matches) || matches.length !== expected.size ||
    new Set(matches).size !== expected.size ||
    matches.some((id: unknown) => typeof id !== "number" || !expected.has(id))
  ) {
    throw new Error("Anki's native search did not verify the requested due-date range for every selected Card");
  }
}
