import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { MediaKind } from "./media-utils.js";
import { calculateSha256 } from "./media-utils.js";

const MEDIA_SOURCE_TAGS = new Set(["audio", "img", "source", "video"]);

export interface MediaReferenceMatch {
  kind: "html" | "sound";
  markup: string;
  startOffset: number;
  endOffset: number;
}

export interface RemovedMediaReferences {
  value: string;
  removedReferenceCount: number;
}

/** Creates the field markup Anki expects for an existing media filename. */
export function buildMediaFieldReference(
  filename: string,
  kind: MediaKind,
  altText?: string,
): string {
  if (kind === "image") {
    const alt =
      altText === undefined
        ? ""
        : ` alt="${escapeHtmlAttribute(altText)}"`;
    return `<img src="${escapeHtmlAttribute(filename)}"${alt}>`;
  }

  if (kind === "audio" || kind === "video") {
    return `[sound:${filename}]`;
  }

  throw new Error(
    `Media kind "${kind}" cannot be attached to a note field`,
  );
}

/** Adds one reference while preserving the complete existing field value. */
export function attachMediaReferenceToField(
  value: string,
  filename: string,
  kind: MediaKind,
  placement: "append" | "prepend",
  altText?: string,
): { value: string; reference: string; changed: boolean } {
  const reference = buildMediaFieldReference(filename, kind, altText);

  if (findMediaReferencesInHtml(value, filename).length > 0) {
    return { value, reference, changed: false };
  }

  return {
    value:
      placement === "prepend"
        ? `${reference}${value}`
        : `${value}${reference}`,
    reference,
    changed: true,
  };
}

/** Finds exact HTML and [sound:...] references without rewriting the field. */
export function findMediaReferencesInHtml(
  html: string,
  filename: string,
): MediaReferenceMatch[] {
  const matches: MediaReferenceMatch[] = [];
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
  });

  visitHtmlNode(fragment, (element) => {
    const location = element.sourceCodeLocation;

    if (location === undefined || location === null) {
      return;
    }

    const referencesFilename =
      MEDIA_SOURCE_TAGS.has(element.tagName) &&
      element.attrs.some(
        ({ name, value }) =>
          name === "src" &&
          normalizeMediaReference(value) === filename,
      );

    if (referencesFilename) {
      matches.push({
        kind: "html",
        markup: html.slice(location.startOffset, location.endOffset),
        startOffset: location.startOffset,
        endOffset: location.endOffset,
      });
    }
  });

  const soundPattern = /\[sound:([^\]\r\n]+)\]/giu;

  for (const match of html.matchAll(soundPattern)) {
    const matchedFilename = match[1];
    const markup = match[0];
    const startOffset = match.index;

    if (
      matchedFilename === undefined ||
      markup === undefined ||
      startOffset === undefined ||
      normalizeMediaReference(matchedFilename) !== filename
    ) {
      continue;
    }

    matches.push({
      kind: "sound",
      markup,
      startOffset,
      endOffset: startOffset + markup.length,
    });
  }

  return deduplicateAndSortMatches(matches);
}

/** Removes exact references by source offsets, preserving unrelated HTML. */
export function removeMediaReferencesFromField(
  value: string,
  filename: string,
): RemovedMediaReferences {
  const matches = findMediaReferencesInHtml(value, filename);
  let updatedValue = value;
  const ranges = mergeReferenceRanges(matches);

  for (const range of [...ranges].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    updatedValue =
      updatedValue.slice(0, range.startOffset) +
      updatedValue.slice(range.endOffset);
  }

  return {
    value: updatedValue,
    removedReferenceCount: matches.length,
  };
}

export function calculateFieldHash(value: string): string {
  return calculateSha256(value);
}

function visitHtmlNode(
  node:
    | DefaultTreeAdapterTypes.DocumentFragment
    | DefaultTreeAdapterTypes.ChildNode,
  visit: (element: DefaultTreeAdapterTypes.Element) => void,
): void {
  if ("tagName" in node) {
    visit(node);
  }

  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      visitHtmlNode(child, visit);
    }
  }

  if ("content" in node) {
    visitHtmlNode(node.content, visit);
  }
}

function deduplicateAndSortMatches(
  matches: MediaReferenceMatch[],
): MediaReferenceMatch[] {
  const matchesByRange = new Map<string, MediaReferenceMatch>();

  for (const match of matches) {
    matchesByRange.set(
      `${match.startOffset}:${match.endOffset}`,
      match,
    );
  }

  return [...matchesByRange.values()].sort(
    (left, right) => left.startOffset - right.startOffset,
  );
}

function mergeReferenceRanges(
  matches: MediaReferenceMatch[],
): Array<{ startOffset: number; endOffset: number }> {
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];

  for (const match of matches) {
    const previous = ranges.at(-1);

    if (
      previous !== undefined &&
      match.startOffset < previous.endOffset
    ) {
      previous.endOffset = Math.max(
        previous.endOffset,
        match.endOffset,
      );
      continue;
    }

    ranges.push({
      startOffset: match.startOffset,
      endOffset: match.endOffset,
    });
  }

  return ranges;
}

function normalizeMediaReference(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("./")) {
    return trimmed.slice(2);
  }

  return trimmed;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
