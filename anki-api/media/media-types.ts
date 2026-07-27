export interface AnkiStoreMediaFileInput {
  filename: string;
  data: string;
  deleteExisting: boolean;
}

export type AnkiStoredMediaFilename = string | null;
export type AnkiRetrievedMediaData = string | false;
