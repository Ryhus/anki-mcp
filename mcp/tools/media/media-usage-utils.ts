import {
  getAnkiNoteTypeNameMap,
  getAnkiNoteTypeStyling,
  getAnkiNoteTypeTemplates,
} from "../../../anki-api/note-types/note-type-client.js";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { loadNotes } from "../notes/note-loader.js";
import {
  MEDIA_REFERENCE_SAMPLE_LIMIT,
  MEDIA_REFERENCE_SCAN_NOTE_LIMIT,
} from "./shared-schemas.js";
import {
  countMediaReferencesInCss,
  findMediaReferencesInHtml,
} from "./media-reference-utils.js";

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

export interface MediaUsage {
  filename: string;
  totalReferenceCount: number;
  noteReferenceCount: number;
  templateReferenceCount: number;
  cssReferenceCount: number;
  noteReferences: NoteMediaReference[];
  templateReferences: TemplateMediaReference[];
  cssReferences: CssMediaReference[];
  referencesTruncated: boolean;
  totalNoteCount: number;
  scannedNoteCount: number;
  scannedNoteTypeCount: number;
  scanComplete: boolean;
}

/** Scans exact note-field, template, and CSS references for one filename. */
export async function findMediaUsage(
  filename: string,
): Promise<MediaUsage> {
  const allNoteIds = await findAnkiNotes("");
  const scannedNoteIds = allNoteIds.slice(
    0,
    MEDIA_REFERENCE_SCAN_NOTE_LIMIT,
  );
  const noteReferences: NoteMediaReference[] = [];
  let noteReferenceCount = 0;
  let noteReferenceGroupCount = 0;

  for (
    let offset = 0;
    offset < scannedNoteIds.length;
    offset += NOTE_INFO_BATCH_SIZE
  ) {
    const noteIdBatch = scannedNoteIds.slice(
      offset,
      offset + NOTE_INFO_BATCH_SIZE,
    );
    const { notes } = await loadNotes(noteIdBatch);

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
  }

  const noteTypes = await getAnkiNoteTypeNameMap();
  const templateReferences: TemplateMediaReference[] = [];
  const cssReferences: CssMediaReference[] = [];
  let templateReferenceCount = 0;
  let cssReferenceCount = 0;
  let templateReferenceGroupCount = 0;
  let cssReferenceGroupCount = 0;

  for (const modelName of Object.keys(noteTypes)) {
    const [templates, styling] = await Promise.all([
      getAnkiNoteTypeTemplates(modelName),
      getAnkiNoteTypeStyling(modelName),
    ]);

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

    const occurrenceCount = countMediaReferencesInCss(
      styling.css,
      filename,
    );

    if (occurrenceCount > 0) {
      cssReferenceCount += occurrenceCount;
      cssReferenceGroupCount += 1;
      if (cssReferences.length < MEDIA_REFERENCE_SAMPLE_LIMIT) {
        cssReferences.push({ modelName, occurrenceCount });
      }
    }
  }

  const totalReferenceCount =
    noteReferenceCount +
    templateReferenceCount +
    cssReferenceCount;
  return {
    filename,
    totalReferenceCount,
    noteReferenceCount,
    templateReferenceCount,
    cssReferenceCount,
    noteReferences,
    templateReferences,
    cssReferences,
    referencesTruncated:
      noteReferences.length < noteReferenceGroupCount ||
      templateReferences.length < templateReferenceGroupCount ||
      cssReferences.length < cssReferenceGroupCount,
    totalNoteCount: allNoteIds.length,
    scannedNoteCount: scannedNoteIds.length,
    scannedNoteTypeCount: Object.keys(noteTypes).length,
    scanComplete: scannedNoteIds.length === allNoteIds.length,
  };
}
