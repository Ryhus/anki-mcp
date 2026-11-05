import { createHash } from "node:crypto";
import {
  readConversionNoteType, readNativeConversionPlan,
  type ConversionMapping, type ConversionNoteType,
} from "../../../anki-api/notes/note-conversion-client.js";
import type { V1AdapterContext } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { getV1Cards } from "../../../anki-api/v1/anki-v1-cards-adapter.js";
import { getV1Notes } from "../../../anki-api/v1/anki-v1-note-client.js";
import { calculateNoteFieldHash } from "./note-field-utils.js";
import {
  CONVERSION_CARD_LIMIT, CONVERSION_FIELD_LIMIT, CONVERSION_SAMPLE_LIMIT, CONVERSION_TEMPLATE_LIMIT,
  type NoteConversionInput, type NoteConversionOutput,
} from "./note-conversion-schemas.js";

export type ConversionNote = Awaited<ReturnType<typeof getV1Notes>>["notes"][number];
type ConversionCard = NonNullable<Awaited<ReturnType<typeof getV1Cards>>[number]>;
type Preview = Omit<NoteConversionOutput, "dryRun" | "applied" | "verified" | "convertedNotes">;

export interface PreparedConversion {
  source: ConversionNoteType;
  target: ConversionNoteType;
  notes: ConversionNote[];
  token: string;
  fields: ConversionMapping[];
  templates: ConversionMapping[];
  preserved: Map<number, { card: ConversionCard; targetIndex: number }>;
  removed: ConversionCard[];
}

const warnings = [
  "Unmapped nonempty fields are not carried over. Removing a Card can make its scheduling and review history unavailable.",
  "Anki decides which open target template slots generate new Cards. The preview does not render or predict their content or placement.",
  "Preview and apply are separate. There is no MCP backup, retry, or rollback; Anki may require a full sync after this schema change.",
];

/** Validates complete, one-to-one target-to-source maps in target ordinal order. */
function orderMapping(
  proposed: ConversionMapping[], sourceNames: string[], targetNames: string[],
): ConversionMapping[] | null {
  const targets = new Map(proposed.map(({ target, source }) => [target, source]));
  const sources = proposed.flatMap(({ source }) => source === null ? [] : [source]);
  if (proposed.length !== targetNames.length || targets.size !== proposed.length ||
      targetNames.some((target) => !targets.has(target)) || new Set(sources).size !== sources.length ||
      sources.some((source) => !sourceNames.includes(source))) return null;
  return targetNames.map((target) => ({ target, source: targets.get(target)! }));
}

export function mappedFieldValues(note: ConversionNote, fields: ConversionMapping[]): Record<string, string> {
  return Object.fromEntries(fields.map(({ target, source }) => [target, source === null ? "" : note.fields[source]!]));
}

function summary({ id, name, kind }: ConversionNoteType) {
  return { id, name, kind };
}

export async function prepareNoteConversion(
  ctx: V1AdapterContext & { profile: string }, input: NoteConversionInput,
): Promise<{ preview: Preview; plan: PreparedConversion | null }> {
  const ids = [...new Set(input.noteIds)].sort((a, b) => a - b);
  const { notes, missingNoteIds } = await getV1Notes(ids, ctx.session, ctx.options);
  const preview: Preview = {
    sourceNoteType: null, targetNoteType: null, fields: [], templates: [],
    impactHash: null, impact: null, missingNoteIds, blockers: [], warnings: [...warnings],
  };
  const block = (message: string) => {
    preview.blockers.push(message);
    return { preview, plan: null };
  };
  if (missingNoteIds.length > 0) return block("At least one selected Note could not be loaded; no partial batch can be converted.");
  const sourceRef = notes[0]?.noteType;
  if (!sourceRef || notes.some(({ noteType }) => noteType.id !== sourceRef.id)) {
    return block("Select Notes belonging to one source Note Type.");
  }
  if (sourceRef.id === input.targetNoteTypeId) return block("Source and target Note Types must differ.");

  // The native token is minted before the public impact snapshot. It is
  // refreshed on apply and checked by Anki against the live schemas.
  const native = await readNativeConversionPlan(ctx, sourceRef.id, input.targetNoteTypeId);
  const [source, target] = await Promise.all([
    readConversionNoteType(ctx, sourceRef.id), readConversionNoteType(ctx, input.targetNoteTypeId),
  ]);
  preview.sourceNoteType = summary(source);
  preview.targetNoteType = summary(target);
  if (source.kind !== "normal" || target.kind !== "normal") {
    return block("This tool supports Normal to Normal conversion only; Cloze uses different native Card rules.");
  }
  if (source.name !== native.source.name || target.name !== native.target.name ||
      notes.some(({ noteType }) => noteType.name !== source.name)) {
    return block("A Note Type changed while its conversion was being planned. Preview again.");
  }
  if ([source, target].some((type) => type.fields.length > CONVERSION_FIELD_LIMIT ||
    type.templates.length > CONVERSION_TEMPLATE_LIMIT)) {
    return block("A Note Type exceeds this tool's field or template review limits.");
  }
  const sourceFields = source.fields.map(({ name }) => name);
  const targetFields = target.fields.map(({ name }) => name);
  const fields = orderMapping(input.fields ?? native.fields, sourceFields, targetFields);
  const templates = orderMapping(input.templates ?? native.templates,
    source.templates.map(({ name }) => name), target.templates.map(({ name }) => name));
  if (fields === null || templates === null) {
    return block("Mappings must cover every target exactly once and use exact, distinct source names or null.");
  }
  preview.fields = fields;
  preview.templates = templates;
  if (notes.some((note) => Object.keys(note.fields).length !== sourceFields.length ||
      sourceFields.some((field) => !Object.hasOwn(note.fields, field)))) {
    return block("Selected Note fields do not match the current source schema.");
  }
  const cardIds = notes.flatMap(({ cardIds }) => cardIds).sort((a, b) => a - b);
  if (cardIds.length > CONVERSION_CARD_LIMIT || notes.length * target.templates.length > CONVERSION_CARD_LIMIT) {
    return block(`The conversion exceeds the ${CONVERSION_CARD_LIMIT}-Card review limit. Select fewer Notes.`);
  }
  if (new Set(cardIds).size !== cardIds.length) return block("Selected Notes reported duplicate Card IDs.");
  const cards = await getV1Cards(ctx, cardIds, true);
  if (cards.some((card) => card === null)) return block("A selected Card could not be read reliably.");
  const cardsById = new Map(cards.flatMap((card) => card === null ? [] : [[card.id, card] as const]));
  const targetIndexBySource = new Map(templates.flatMap(({ source }, index) => source === null ? [] : [[source, index] as const]));
  const preserved: PreparedConversion["preserved"] = new Map();
  const removed: ConversionCard[] = [];
  let possibleNewCardCount = 0;
  for (const note of notes) {
    const seenOrdinals = new Set<number>();
    let kept = 0;
    for (const id of note.cardIds) {
      const card = cardsById.get(id);
      if (!card || card.noteId !== note.id || seenOrdinals.has(card.templateIndex) || !source.templates[card.templateIndex]) {
        return block("Card ownership or template ordinals changed during preflight.");
      }
      if (card.homeDeck !== null || card.scheduling.queue === "preview") {
        return block("Move selected Cards out of filtered decks before converting their Notes.");
      }
      seenOrdinals.add(card.templateIndex);
      const targetIndex = targetIndexBySource.get(source.templates[card.templateIndex]!.name);
      if (targetIndex === undefined) removed.push(card);
      else {
        kept++;
        preserved.set(id, { card, targetIndex });
      }
    }
    if (kept === 0) preview.blockers.push(`Note ${note.id} would keep no existing Card. Map at least one of its templates.`);
    if (mappedFieldValues(note, fields)[targetFields[0]!]!.trim() === "") {
      preview.blockers.push(`Note ${note.id} would have an empty first target field.`);
    }
    possibleNewCardCount += target.templates.length - kept;
  }
  const retainedFields = new Set(fields.flatMap(({ source }) => source === null ? [] : [source]));
  const droppedFields = sourceFields.filter((name) => !retainedFields.has(name)).map((fieldName) => {
    const nonempty = notes.filter((note) => note.fields[fieldName] !== "");
    return { fieldName, nonEmptyNoteCount: nonempty.length, sampleNoteIds: nonempty.map(({ id }) => id).slice(0, CONVERSION_SAMPLE_LIMIT) };
  });
  preview.impact = {
    noteCount: notes.length,
    preservedCardCount: preserved.size, removedCardCount: removed.length, possibleNewCardCount,
    droppedFields,
    droppedNonEmptyFieldValueCount: droppedFields.reduce((total, { nonEmptyNoteCount }) => total + nonEmptyNoteCount, 0),
    samplePreservedCardIds: [...preserved.keys()].sort((a, b) => a - b).slice(0, CONVERSION_SAMPLE_LIMIT),
    sampleRemovedCardIds: removed.map(({ id }) => id).sort((a, b) => a - b).slice(0, CONVERSION_SAMPLE_LIMIT),
  };
  if (preview.blockers.length > 0) return { preview, plan: null };
  preview.impactHash = createHash("sha256").update(JSON.stringify(orderedJson({
    version: 1, profile: ctx.profile, session: ctx.session, ids, source, target, fields, templates,
    notes: notes.map(({ id, modifiedAt, tags, fields, cardIds }) => ({
      id, modifiedAt, tags: [...tags].sort(), cardIds: [...cardIds].sort((a, b) => a - b),
      fieldHashes: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, calculateNoteFieldHash(value)])),
    })),
    cards,
  }))).digest("hex");
  return { preview, plan: { source, target, notes, token: native.token, fields, templates, preserved, removed } };
}

function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, orderedJson(item)]));
  }
  return value;
}
