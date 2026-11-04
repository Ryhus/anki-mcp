import {
  AnkiMultiActionError,
  createAnkiAction,
  invokeAnkiMulti,
  type AnkiAction,
} from "../../../anki-api/anki-request.js";
import type {
  AnkiNoteTypeNameMap,
  AnkiNoteTypeStyling,
  AnkiNoteTypeTemplates,
} from "../../../anki-api/note-types/note-type-types.js";
import type {
  AnkiNoteInfoResult,
  NoteId,
} from "../../../anki-api/notes/note-types.js";
import { normalizeLoadedNotes } from "../notes/note-loader.js";
import {
  MEDIA_REFERENCE_SAMPLE_LIMIT,
  MEDIA_REFERENCE_SCAN_NOTE_LIMIT,
} from "./shared-schemas.js";
import { buildMediaReferenceCandidateQuery } from "./media-reference-search.js";
import {
  calculateMediaReferenceFingerprint,
  type MediaReferenceFingerprintEntry,
} from "./media-reference-fingerprint.js";
import { findMediaReferencesInHtml } from "./media-reference-utils.js";
import { scanMediaReferencesInCss } from "./media-css-reference-scanner.js";

const NOTE_INFO_BATCH_SIZE = 250;

export interface NoteMediaReference {
  noteId: number;
  modelName: string;
  fieldName: string;
  occurrenceCount: number;
}

export interface TemplateMediaReference {
  modelName: string;
  templateName: string;
  side: "front" | "back";
  occurrenceCount: number;
}

export interface CssMediaReference {
  modelName: string;
  occurrenceCount: number;
}

export interface CssMediaScanFailure {
  modelName: string;
  error: string;
}

export interface MediaUsage {
  filename: string;
  referenceFingerprint: string | null;
  totalReferenceCount: number;
  noteReferenceCount: number;
  templateReferenceCount: number;
  cssReferenceCount: number;
  cssScanFailureCount: number;
  cssScanFailures: CssMediaScanFailure[];
  noteReferences: NoteMediaReference[];
  templateReferences: TemplateMediaReference[];
  cssReferences: CssMediaReference[];
  referencesTruncated: boolean;
  totalNoteCount: number;
  candidateNoteCount: number;
  scannedNoteCount: number;
  scannedNoteTypeCount: number;
  scanStrategy: "native-candidates" | "full-scan-fallback";
  nativeSearchQuery: string;
  scanFallbackReason: string | null;
  scanComplete: boolean;
}

interface MediaScanScope {
  allNoteIds: NoteId[];
  candidateNoteIds: NoteId[];
  noteTypes: AnkiNoteTypeNameMap;
  scanStrategy: MediaUsage["scanStrategy"];
  nativeSearchQuery: string;
  scanFallbackReason: string | null;
}

type MediaDetailAction =
  | {
      kind: "notes";
      noteIds: NoteId[];
      action: AnkiAction<AnkiNoteInfoResult[]>;
    }
  | {
      kind: "templates";
      modelName: string;
      action: AnkiAction<AnkiNoteTypeTemplates>;
    }
  | {
      kind: "styling";
      modelName: string;
      action: AnkiAction<AnkiNoteTypeStyling>;
    };

/** Finds candidate Notes natively, then verifies exact field/design references. */
export async function findMediaUsage(
  filename: string,
): Promise<MediaUsage> {
  const scope = await loadMediaScanScope(filename);
  const uniqueCandidateNoteIds = [...new Set(scope.candidateNoteIds)];
  const scannedNoteIds = uniqueCandidateNoteIds.slice(
    0,
    MEDIA_REFERENCE_SCAN_NOTE_LIMIT,
  );
  const modelNames = Object.keys(scope.noteTypes);
  const detailActions = createMediaDetailActions(
    scannedNoteIds,
    modelNames,
  );
  const detailResults = await invokeAnkiMulti(
    detailActions.map(({ action }) => action),
  );
  const noteReferences: NoteMediaReference[] = [];
  const templateReferences: TemplateMediaReference[] = [];
  const cssReferences: CssMediaReference[] = [];
  const cssScanFailures: CssMediaScanFailure[] = [];
  let cssScanFailureCount = 0;
  const fingerprintEntries: MediaReferenceFingerprintEntry[] = [];
  let scannedNoteCount = 0;
  let noteReferenceCount = 0;
  let noteReferenceGroupCount = 0;
  let templateReferenceCount = 0;
  let cssReferenceCount = 0;
  let templateReferenceGroupCount = 0;
  let cssReferenceGroupCount = 0;
  const templatesByModel = new Map<string, AnkiNoteTypeTemplates>();
  const stylingByModel = new Map<string, AnkiNoteTypeStyling>();

  detailActions.forEach((detailAction, index) => {
    const result = detailResults[index];

    if (result === undefined) {
      throw new Error(
        `AnkiConnect omitted media scan detail action ${index}`,
      );
    }

    if (detailAction.kind === "notes") {
      if (!Array.isArray(result)) {
        throw new Error(
          "AnkiConnect returned invalid notesInfo data during media scan",
        );
      }

      const { notes } = normalizeLoadedNotes(
        detailAction.noteIds,
        result as AnkiNoteInfoResult[],
      );
      scannedNoteCount += notes.length;

      for (const note of notes) {
        for (const [fieldName, field] of Object.entries(note.fields)) {
          const occurrenceCount = findMediaReferencesInHtml(
            field.value,
            filename,
          ).length;

          if (occurrenceCount === 0) {
            continue;
          }

          noteReferenceCount += occurrenceCount;
          noteReferenceGroupCount += 1;
          fingerprintEntries.push([
            "note", note.noteId, note.modelName, fieldName, occurrenceCount,
          ]);
          if (noteReferences.length < MEDIA_REFERENCE_SAMPLE_LIMIT) {
            noteReferences.push({
              noteId: note.noteId,
              modelName: note.modelName,
              fieldName,
              occurrenceCount,
            });
          }
        }
      }
    } else if (detailAction.kind === "templates") {
      templatesByModel.set(
        detailAction.modelName,
        result as AnkiNoteTypeTemplates,
      );
    } else {
      stylingByModel.set(
        detailAction.modelName,
        result as AnkiNoteTypeStyling,
      );
    }
  });

  for (const modelName of modelNames) {
    const templates = templatesByModel.get(modelName);
    const styling = stylingByModel.get(modelName);

    if (templates === undefined || styling === undefined) {
      throw new Error(
        `AnkiConnect omitted design data for note type "${modelName}"`,
      );
    }

    for (const [templateName, template] of Object.entries(templates)) {
      const sides = [
        ["front", template.Front],
        ["back", template.Back],
      ] as const;

      for (const [side, html] of sides) {
        const occurrenceCount = findMediaReferencesInHtml(
          html,
          filename,
        ).length;

        if (occurrenceCount === 0) {
          continue;
        }

        templateReferenceCount += occurrenceCount;
        templateReferenceGroupCount += 1;
        fingerprintEntries.push([
          "template", modelName, templateName, side, occurrenceCount,
        ]);
        if (
          templateReferences.length < MEDIA_REFERENCE_SAMPLE_LIMIT
        ) {
          templateReferences.push({
            modelName,
            templateName,
            side,
            occurrenceCount,
          });
        }
      }
    }

    const cssScan = scanMediaReferencesInCss(
      styling.css,
      filename,
    );
    const { occurrenceCount } = cssScan;
    if (cssScan.error !== null) {
      cssScanFailureCount += 1;
      if (cssScanFailures.length < MEDIA_REFERENCE_SAMPLE_LIMIT) {
        cssScanFailures.push({ modelName, error: cssScan.error });
      }
    }

    if (occurrenceCount > 0) {
      cssReferenceCount += occurrenceCount;
      cssReferenceGroupCount += 1;
      fingerprintEntries.push(["css", modelName, occurrenceCount]);
      if (cssReferences.length < MEDIA_REFERENCE_SAMPLE_LIMIT) {
        cssReferences.push({ modelName, occurrenceCount });
      }
    }
  }

  const totalReferenceCount =
    noteReferenceCount +
    templateReferenceCount +
    cssReferenceCount;
  const scanComplete =
    scannedNoteCount === uniqueCandidateNoteIds.length && cssScanFailureCount === 0;
  return {
    filename,
    referenceFingerprint: scanComplete
      ? calculateMediaReferenceFingerprint(filename, fingerprintEntries)
      : null,
    totalReferenceCount,
    noteReferenceCount,
    templateReferenceCount,
    cssReferenceCount,
    cssScanFailureCount,
    cssScanFailures,
    noteReferences,
    templateReferences,
    cssReferences,
    referencesTruncated:
      noteReferences.length < noteReferenceGroupCount ||
      templateReferences.length < templateReferenceGroupCount ||
      cssReferences.length < cssReferenceGroupCount,
    totalNoteCount: scope.allNoteIds.length,
    candidateNoteCount: uniqueCandidateNoteIds.length,
    scannedNoteCount,
    scannedNoteTypeCount: modelNames.length,
    scanStrategy: scope.scanStrategy,
    nativeSearchQuery: scope.nativeSearchQuery,
    scanFallbackReason: scope.scanFallbackReason,
    scanComplete,
  };
}

async function loadMediaScanScope(
  filename: string,
): Promise<MediaScanScope> {
  const nativeSearchQuery =
    buildMediaReferenceCandidateQuery(filename);

  try {
    const [candidateNoteIds, allNoteIds, noteTypes] =
      await invokeAnkiMulti([
        createAnkiAction<NoteId[]>("findNotes", {
          query: nativeSearchQuery,
        }),
        createAnkiAction<NoteId[]>("findNotes", { query: "" }),
        createAnkiAction<AnkiNoteTypeNameMap>("modelNamesAndIds"),
      ] as const);

    return {
      allNoteIds,
      candidateNoteIds,
      noteTypes,
      scanStrategy: "native-candidates",
      nativeSearchQuery,
      scanFallbackReason: null,
    };
  } catch (error) {
    if (
      !(error instanceof AnkiMultiActionError) ||
      error.actionIndex !== 0
    ) {
      throw error;
    }

    const [allNoteIds, noteTypes] = await invokeAnkiMulti([
      createAnkiAction<NoteId[]>("findNotes", { query: "" }),
      createAnkiAction<AnkiNoteTypeNameMap>("modelNamesAndIds"),
    ] as const);

    return {
      allNoteIds,
      candidateNoteIds: allNoteIds,
      noteTypes,
      scanStrategy: "full-scan-fallback",
      nativeSearchQuery,
      scanFallbackReason: error.message,
    };
  }
}

function createMediaDetailActions(
  noteIds: NoteId[],
  modelNames: string[],
): MediaDetailAction[] {
  const actions: MediaDetailAction[] = [];

  for (
    let offset = 0;
    offset < noteIds.length;
    offset += NOTE_INFO_BATCH_SIZE
  ) {
    const noteIdBatch = noteIds.slice(
      offset,
      offset + NOTE_INFO_BATCH_SIZE,
    );
    actions.push({
      kind: "notes",
      noteIds: noteIdBatch,
      action: createAnkiAction<AnkiNoteInfoResult[]>("notesInfo", {
        notes: noteIdBatch,
      }),
    });
  }

  for (const modelName of modelNames) {
    actions.push(
      {
        kind: "templates",
        modelName,
        action: createAnkiAction<AnkiNoteTypeTemplates>(
          "modelTemplates",
          { modelName },
        ),
      },
      {
        kind: "styling",
        modelName,
        action: createAnkiAction<AnkiNoteTypeStyling>(
          "modelStyling",
          { modelName },
        ),
      },
    );
  }

  return actions;
}
