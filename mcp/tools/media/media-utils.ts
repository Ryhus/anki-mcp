import { createHash } from "node:crypto";
import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type { z } from "zod";
import {
  MEDIA_FILE_SIZE_LIMIT,
  type mediaFileDescriptorSchema,
  type mediaKindSchema,
} from "./shared-schemas.js";

export type MediaKind = z.infer<typeof mediaKindSchema>;
export type MediaFileDescriptor = z.infer<
  typeof mediaFileDescriptorSchema
>;

interface ExtensionDescriptor {
  kind: MediaKind;
  mimeType: string;
}

const EXTENSION_DESCRIPTORS: Record<string, ExtensionDescriptor> = {
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".png": { kind: "image", mimeType: "image/png" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
  ".oga": { kind: "audio", mimeType: "audio/ogg" },
  ".opus": { kind: "audio", mimeType: "audio/ogg" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".m4v": { kind: "video", mimeType: "video/mp4" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".ogv": { kind: "video", mimeType: "video/ogg" },
  ".ttf": { kind: "font", mimeType: "font/ttf" },
  ".otf": { kind: "font", mimeType: "font/otf" },
  ".woff": { kind: "font", mimeType: "font/woff" },
  ".woff2": { kind: "font", mimeType: "font/woff2" },
};

const MIME_KIND_OVERRIDES: Record<string, MediaKind> = {
  "application/font-sfnt": "font",
  "application/font-woff": "font",
  "application/vnd.ms-fontobject": "font",
};

/** Hashes bytes or text for optimistic concurrency and verification. */
export function calculateSha256(
  value: Uint8Array | string,
): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Validates base64 strictly instead of accepting Buffer's partial decoding. */
export function decodeBase64(data: string): Buffer {
  const normalized = data.replace(/\s+/gu, "");

  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error("Media data is not valid base64");
  }

  const bytes = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/u, "");
  const canonicalDecoded = bytes
    .toString("base64")
    .replace(/=+$/u, "");

  if (canonicalInput !== canonicalDecoded) {
    throw new Error("Media data is not valid base64");
  }

  return bytes;
}

/** Returns extension-based metadata without reading file contents. */
export function inferMediaFileSummary(filename: string): {
  kind: MediaKind;
  inferredMimeType: string;
} {
  const extension = normalizedExtension(filename);
  const known = EXTENSION_DESCRIPTORS[extension];

  return known === undefined
    ? { kind: "other", inferredMimeType: "application/octet-stream" }
    : { kind: known.kind, inferredMimeType: known.mimeType };
}

/** Describes exact bytes, preferring signature detection over extensions. */
export async function describeMediaFile(
  filename: string,
  bytes: Uint8Array,
): Promise<MediaFileDescriptor> {
  const extension = normalizedExtension(filename);
  const extensionDescriptor = EXTENSION_DESCRIPTORS[extension];
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;

  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch {
    detected = undefined;
  }

  const detectedKind =
    detected === undefined
      ? undefined
      : (MIME_KIND_OVERRIDES[detected.mime] ??
        mediaKindFromMimeType(detected.mime));
  const kind =
    detectedKind ??
    extensionDescriptor?.kind ??
    ("other" satisfies MediaKind);
  const mimeType =
    detected?.mime ??
    extensionDescriptor?.mimeType ??
    "application/octet-stream";

  return {
    filename,
    kind,
    mimeType,
    extension,
    byteLength: bytes.byteLength,
    sha256: calculateSha256(bytes),
    contentDetected: detected !== undefined,
  };
}

/** Rejects empty, oversized, unsupported, or misleading upload candidates. */
export function validateStorableMediaFile(
  descriptor: MediaFileDescriptor,
): string[] {
  const errors: string[] = [];
  const extensionDescriptor =
    EXTENSION_DESCRIPTORS[descriptor.extension];

  if (descriptor.byteLength === 0) {
    errors.push("Media file cannot be empty");
  }

  if (descriptor.byteLength > MEDIA_FILE_SIZE_LIMIT) {
    errors.push(
      `Media file exceeds the ${MEDIA_FILE_SIZE_LIMIT} byte limit`,
    );
  }

  if (descriptor.kind === "other") {
    errors.push(
      "Unsupported media type; supported files are common images, audio, video, and fonts",
    );
  }

  if (!descriptor.contentDetected) {
    errors.push(
      "Media type could not be verified from the file contents",
    );
  }

  if (
    extensionDescriptor !== undefined &&
    descriptor.kind !== "other" &&
    extensionDescriptor.kind !== descriptor.kind
  ) {
    errors.push(
      `File contents are ${descriptor.kind}, but extension ${descriptor.extension} indicates ${extensionDescriptor.kind}`,
    );
  }

  if (
    extensionDescriptor !== undefined &&
    descriptor.kind === extensionDescriptor.kind &&
    descriptor.mimeType !== extensionDescriptor.mimeType
  ) {
    errors.push(
      `File contents use MIME type ${descriptor.mimeType}, but extension ${descriptor.extension} indicates ${extensionDescriptor.mimeType}`,
    );
  }

  return errors;
}

export function isAttachableMediaKind(
  kind: MediaKind,
): kind is "image" | "audio" | "video" {
  return kind === "image" || kind === "audio" || kind === "video";
}

export function createFieldPreview(
  value: string,
  limit = 500,
): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1)}…`;
}

function normalizedExtension(filename: string): string {
  return extname(filename).toLowerCase();
}

function mediaKindFromMimeType(mimeType: string): MediaKind {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("font/")) {
    return "font";
  }

  return "other";
}
