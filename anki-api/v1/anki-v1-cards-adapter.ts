import { z } from "zod";
import type { AnkiCardInfoResult, AnkiCardReviewMap } from "../cards/card-types.js";
import { v1EntityIdSchema, v1EntitySummarySchema } from "./anki-v1-collection-client.js";
import {
  readAllV1Pages, readV1Acks, readV1Items, searchAllV1Ids, stringIds,
  type V1AdapterContext, type V1Route,
} from "./anki-v1-adapter-utils.js";
import { loadV1NoteInfo } from "./anki-v1-notes-adapter.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";
import { predictV1Card, v1CardRatings } from "./anki-v1-scheduling-client.js";

const type = ["new", "learning", "review", "relearning"] as const;
const queues = ["buriedByUser", "buriedByScheduler", "suspended", "new", "learning", "review", "dayLearning", "preview"] as const;
const kind = ["learning", "review", "relearning", "filtered", "manual", "rescheduled"] as const;
const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("position"), position: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("timestamp"), at: z.iso.datetime() }),
  z.object({ kind: z.literal("day"), day: z.number().int() }),
]);
const cardSchema = z.object({
  id: v1EntityIdSchema, noteId: v1EntityIdSchema,
  deck: v1EntitySummarySchema, homeDeck: v1EntitySummarySchema.nullable(),
  templateIndex: z.number().int().nonnegative(), flags: z.number().int().min(0).max(7),
  modifiedAt: z.iso.datetime(),
  scheduling: z.object({
    type: z.enum(type), queue: z.enum(queues), due: dueSchema,
    intervalDays: z.number().int().nonnegative(), remainingSteps: z.number().int().nonnegative(),
    repetitions: z.number().int().nonnegative(), lapses: z.number().int().nonnegative(),
    sm2EasePermille: z.number().int().nonnegative(),
  }),
});
const renderedSchema = z.object({
  cardId: v1EntityIdSchema, questionHtml: z.string(), answerHtml: z.string(), css: z.string(),
});
const intervalSchema = z.object({ value: z.number().int().nonnegative(), unit: z.enum(["seconds", "days"]) });
const reviewsPageSchema = z.object({
  items: z.array(z.object({
    id: v1EntityIdSchema, cardId: v1EntityIdSchema, rating: z.enum(v1CardRatings).nullable(),
    interval: intervalSchema, previousInterval: intervalSchema, factor: z.object({ value: z.number().int() }),
    elapsedMs: z.number().int().nonnegative(), kind: z.enum(kind), syncSequence: z.number().int(),
  })),
  nextCursor: z.string().min(1).nullable(),
});

export async function getV1Cards(ctx: V1AdapterContext, ids: readonly number[], allowMissing: boolean) {
  if (ids.length === 0) return [];
  const method = "cards.getMany";
  const cards = await readV1Items(ctx, method, { ids: stringIds(ids) }, ids.length, cardSchema, allowMissing);
  if (cards.some((card, index) => card !== null && card.id !== ids[index])) throw invalidAnkiV1Response(method);
  return cards;
}

function dueNumber(due: z.infer<typeof dueSchema>): number {
  switch (due.kind) {
    case "position": return due.position;
    case "day": return due.day;
    case "timestamp": return Math.floor(Date.parse(due.at) / 1_000);
  }
}

export async function loadV1CardInfo(ctx: V1AdapterContext, ids: readonly number[], render: boolean): Promise<AnkiCardInfoResult[]> {
  const cards = await getV1Cards(ctx, ids, true);
  const notes = await loadV1NoteInfo(ctx, cards.flatMap((card) => card === null ? [] : [card.noteId]));
  return Promise.all(cards.map(async (card) => {
    if (card === null) return {};
    const note = notes.get(card.noteId);
    if (note === undefined) throw invalidAnkiV1Response("notes.getMany");
    const source = render ? await ctx.request("cards.render", { id: String(card.id) }, renderedSchema) : null;
    if (source !== null && source.cardId !== card.id) throw invalidAnkiV1Response("cards.render");
    const schedule = card.scheduling;
    return {
      cardId: card.id, note: card.noteId, modelName: note.modelName, deckName: card.deck.name,
      ord: card.templateIndex, fieldOrder: card.templateIndex, fields: note.fields,
      question: source?.questionHtml ?? "", answer: source?.answerHtml ?? "", css: source?.css ?? "",
      factor: schedule.sm2EasePermille, interval: schedule.intervalDays,
      type: type.indexOf(schedule.type), queue: queues.indexOf(schedule.queue) - 3,
      due: dueNumber(schedule.due), reps: schedule.repetitions, lapses: schedule.lapses,
      left: schedule.remainingSteps, mod: Math.floor(Date.parse(card.modifiedAt) / 1_000), flags: card.flags,
    };
  }));
}

export const v1CardRoutes = {
  findCards: ({ query }, ctx) => searchAllV1Ids(ctx, "cards.search", query as string),
  async cardsToNotes({ cards }, ctx) {
    const found = await getV1Cards(ctx, cards as number[], true);
    return [...new Set(found.flatMap((card) => card === null ? [] : [card.noteId]))];
  },
  cardsInfo: ({ cards, render }, ctx) => loadV1CardInfo(ctx, cards as number[], render === true),
  async areDue({ cards }, ctx) {
    const ids = cards as number[];
    if (ids.length === 0) return [];
    const due = new Set(await searchAllV1Ids(
      ctx, "cards.search", `cid:${ids.join(",")} (is:new or is:due) -is:suspended -is:buried`,
    ));
    return ids.map((id) => due.has(id));
  },
  async areSuspended({ cards }, ctx) {
    return (await getV1Cards(ctx, cards as number[], true))
      .map((card) => card === null ? null : card.scheduling.queue === "suspended");
  },
  async suspend({ cards }, ctx) {
    const ids = stringIds(cards as number[]);
    return (await readV1Acks(ctx, "cards.setSuspended", { ids, suspended: true }, ids.length)).some(Boolean);
  },
  async unsuspend({ cards }, ctx) {
    const ids = stringIds(cards as number[]);
    await readV1Acks(ctx, "cards.setSuspended", { ids, suspended: false }, ids.length);
    return null;
  },
  async setSpecificValueOfCard({ card, keys, newValues }, ctx) {
    // The MCP API only exposes supported user flags, not arbitrary scheduler fields.
    if (!Array.isArray(keys) || keys.length !== 1 || keys[0] !== "flags" || !Array.isArray(newValues) || newValues.length !== 1) {
      throw new Error("Only card flag updates are supported.");
    }
    await readV1Acks(ctx, "cards.setFlags", { ids: [String(card)], flag: newValues[0] }, 1);
    return [true];
  },
  async setDueDate({ cards, days }, ctx) {
    const cardIds = stringIds(cards as number[]);
    return (await readV1Acks(ctx, "scheduling.setDueDate", { cardIds, days }, cardIds.length)).every(Boolean);
  },
  async forgetCards({ cards }, ctx) {
    const method = "scheduling.reset";
    const cardIds = stringIds(cards as number[]);
    if (!(await readV1Acks(ctx, method, { cardIds, restorePosition: true, resetCounts: false, log: true }, cardIds.length)).every(Boolean)) {
      throw invalidAnkiV1Response(method);
    }
    return null;
  },
  async relearnCards({ cards }, ctx) {
    const ids = cards as number[];
    const records = await getV1Cards(ctx, ids, false);
    if (records.some((card) => card === null || card.scheduling.queue !== "review" || card.homeDeck !== null)) {
      throw new Error("Relearning requires unfiltered active review cards.");
    }
    for (const id of ids) {
      const cardId = String(id);
      const prediction = await predictV1Card(ctx, id);
      if (!prediction.answers.some((answer) => answer.rating === "again")) {
        throw invalidAnkiV1Response("scheduling.predict");
      }
      const ack = await ctx.request("scheduling.answer", { cardId, rating: "again", stateToken: prediction.stateToken },
        z.object({ cardId: v1EntityIdSchema }));
      if (ack.cardId !== id) throw invalidAnkiV1Response("scheduling.answer");
    }
    return null;
  },
  async getReviewsOfCards({ cards }, ctx) {
    const ids = cards as number[];
    const byCard: AnkiCardReviewMap = Object.fromEntries(ids.map((id) => [String(id), []]));
    if (ids.length === 0) return byCard;
    const reviews = await readAllV1Pages("reviews.list", (cursor) => ctx.request("reviews.list", {
      cardIds: stringIds(ids), includeManual: true, limit: 1_000, ...(cursor === undefined ? {} : { cursor }),
    }, reviewsPageSchema));
    const signed = ({ value, unit }: z.infer<typeof intervalSchema>) => unit === "seconds" ? -value : value;
    const seen = new Set<number>();
    for (const review of reviews) {
      const target = byCard[String(review.cardId)];
      if (target === undefined || seen.has(review.id)) throw invalidAnkiV1Response("reviews.list");
      seen.add(review.id);
      target.push({
        id: review.id, usn: review.syncSequence, ease: review.rating === null ? 0 : v1CardRatings.indexOf(review.rating) + 1,
        ivl: signed(review.interval), lastIvl: signed(review.previousInterval), factor: review.factor.value,
        time: review.elapsedMs, type: kind.indexOf(review.kind),
      });
    }
    return byCard;
  },
} satisfies Record<string, V1Route>;
