import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAnkiCardReviews } from "../../../anki-api/cards/card-client.js";
import type { AnkiCardReview } from "../../../anki-api/cards/card-types.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCardInfo } from "./card-loader.js";
import { toCardInterval } from "./card-normalizers.js";
import {
  cardHistoryIdListSchema,
  cardIdSchema,
  cardIntervalSchema,
} from "./shared-schemas.js";

const reviewRatingSchema = z.enum([
  "again",
  "hard",
  "good",
  "easy",
  "unknown",
]);

const reviewTypeSchema = z.enum([
  "learning",
  "review",
  "relearning",
  "filtered",
  "unknown",
]);

const cardReviewSchema = z.object({
  reviewedAt: z.string().describe("Review time as an ISO 8601 timestamp"),
  rating: reviewRatingSchema,
  previousInterval: cardIntervalSchema,
  newInterval: cardIntervalSchema,
  easePercent: z.number().nonnegative().nullable(),
  answerTimeMs: z.number().int().nonnegative(),
  type: reviewTypeSchema,
});

const getCardReviewHistoryInputSchema = z.object({
  cardIds: cardHistoryIdListSchema,
  limitPerCard: z.number().int().min(1).max(100).default(20),
});

type GetCardReviewHistoryInput = z.infer<
  typeof getCardReviewHistoryInputSchema
>;

export const getCardReviewHistoryConfig = {
  title: "Get card review history",
  description:
    "Returns the most recent review events for up to 20 cards, with ratings and intervals converted into readable values.",
  inputSchema: getCardReviewHistoryInputSchema,
  outputSchema: z.object({
    cards: z.array(
      z.object({
        cardId: cardIdSchema,
        totalReviews: z.number().int().nonnegative(),
        reviews: z.array(cardReviewSchema),
      }),
    ),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Returns bounded, newest-first review history without Anki sync internals. */
export async function getCardReviewHistory({
  cardIds,
  limitPerCard,
}: GetCardReviewHistoryInput): Promise<CallToolResult> {
  const { cards: cardInfo, missingCardIds } = await loadCardInfo(cardIds);
  const existingCardIds = cardInfo.map(({ cardId }) => cardId);
  const reviewsByCard =
    existingCardIds.length === 0
      ? {}
      : await getAnkiCardReviews(existingCardIds);
  const cards = existingCardIds.map((cardId) => {
    const allReviews = reviewsByCard[String(cardId)] ?? [];

    return {
      cardId,
      totalReviews: allReviews.length,
      reviews: [...allReviews]
        .sort((left, right) => right.id - left.id)
        .slice(0, limitPerCard)
        .map(toCardReview),
    };
  });

  return createToolResult(
    `Returned review history for ${cards.length} card${cards.length === 1 ? "" : "s"}${missingCardIds.length === 0 ? "." : `; ${missingCardIds.length} card ID${missingCardIds.length === 1 ? " was" : "s were"} not found.`}`,
    { cards, missingCardIds },
  );
}

function toCardReview(review: AnkiCardReview) {
  return {
    reviewedAt: new Date(review.id).toISOString(),
    rating: toReviewRating(review.ease),
    previousInterval: toCardInterval(review.lastIvl),
    newInterval: toCardInterval(review.ivl),
    easePercent: review.factor === 0 ? null : review.factor / 10,
    answerTimeMs: review.time,
    type: toReviewType(review.type),
  };
}

function toReviewRating(
  ease: number,
): z.infer<typeof reviewRatingSchema> {
  switch (ease) {
    case 1:
      return "again";
    case 2:
      return "hard";
    case 3:
      return "good";
    case 4:
      return "easy";
    default:
      return "unknown";
  }
}

function toReviewType(type: number): z.infer<typeof reviewTypeSchema> {
  switch (type) {
    case 0:
      return "learning";
    case 1:
      return "review";
    case 2:
      return "relearning";
    case 3:
      return "filtered";
    default:
      return "unknown";
  }
}
