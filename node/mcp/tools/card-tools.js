import { callAnki } from "../../anki-api/anki-request.js";
import { formatResult } from "../utils/formatting.js";

/**
 * Gets ease factors for cards.
 */
export async function getEaseFactors({ cards }) {
  const { result } = await callAnki("getEaseFactors", {
    cards,
  });

  return formatResult(result);
}

/**
 * Sets ease factors for cards.
 */
export async function setEaseFactors({ cards, easeFactors }) {
  const { result } = await callAnki("setEaseFactors", {
    cards,
    easeFactors,
  });

  return formatResult(result);
}

/**
 * Sets a specific internal card value.
 */
export async function setSpecificValueOfCard({ card, keys, newValues }) {
  const { result } = await callAnki("setSpecificValueOfCard", {
    card,
    keys,
    newValues,
  });

  return formatResult(result);
}

/**
 * Suspends cards.
 */
export async function suspend({ cards }) {
  const { result } = await callAnki("suspend", {
    cards,
  });

  return formatResult(result);
}

/**
 * Unsuspends cards.
 */
export async function unsuspend({ cards }) {
  const { result } = await callAnki("unsuspend", {
    cards,
  });

  return formatResult(result);
}

/**
 * Checks whether a card is suspended.
 */
export async function suspended({ card }) {
  const { result } = await callAnki("suspended", {
    card,
  });

  return formatResult(result);
}

/**
 * Checks suspension state for multiple cards.
 */
export async function areSuspended({ cards }) {
  const { result } = await callAnki("areSuspended", {
    cards,
  });

  return formatResult(result);
}

/**
 * Checks whether cards are due.
 */
export async function areDue({ cards }) {
  const { result } = await callAnki("areDue", {
    cards,
  });

  return formatResult(result);
}

/**
 * Gets card intervals.
 */
export async function getIntervals({ cards }) {
  const { result } = await callAnki("getIntervals", {
    cards,
  });

  return formatResult(result);
}

/**
 * Finds cards by Anki search query.
 */
export async function findCards({ query }) {
  const { result } = await callAnki("findCards", {
    query,
  });

  return formatResult(result);
}

/**
 * Converts cards to notes.
 */
export async function cardsToNotes({ cards }) {
  const { result } = await callAnki("cardsToNotes", {
    cards,
  });

  return formatResult(result);
}

/**
 * Gets card modification times.
 */
export async function cardsModTime({ cards }) {
  const { result } = await callAnki("cardsModTime", {
    cards,
  });

  return formatResult(result);
}

/**
 * Gets card information.
 */
export async function cardsInfo({ cards }) {
  const { result } = await callAnki("cardsInfo", {
    cards,
  });

  return formatResult(result);
}

/**
 * Resets cards to new state.
 */
export async function forgetCards({ cards }) {
  const { result } = await callAnki("forgetCards", {
    cards,
  });

  return formatResult(result);
}

/**
 * Moves cards into relearning.
 */
export async function relearnCards({ cards }) {
  const { result } = await callAnki("relearnCards", {
    cards,
  });

  return formatResult(result);
}

/**
 * Answers cards.
 */
export async function answerCards({ answers }) {
  const { result } = await callAnki("answerCards", {
    answers,
  });

  return formatResult(result);
}

/**
 * Sets due date for cards.
 */
export async function setDueDate({ cards, days }) {
  const { result } = await callAnki("setDueDate", {
    cards,
    days,
  });

  return formatResult(result);
}
