import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import {
  delimiter,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import type { z } from "zod";
import type { mediaSourceSchema } from "./shared-schemas.js";
import { MEDIA_FILE_SIZE_LIMIT } from "./shared-schemas.js";
import { decodeBase64 } from "./media-utils.js";

const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000;
const MEDIA_DOWNLOAD_REDIRECT_LIMIT = 3;

export type MediaSource = z.infer<typeof mediaSourceSchema>;

export interface LoadedMediaSource {
  bytes: Buffer;
  sourceType: MediaSource["type"];
  sourceDescription: string;
}

/** Loads bounded bytes without delegating arbitrary URL or path access to Anki. */
export async function loadMediaSource(
  source: MediaSource,
): Promise<LoadedMediaSource> {
  if (source.type === "base64") {
    const bytes = decodeBase64(source.data);
    enforceSize(bytes.byteLength);

    return {
      bytes,
      sourceType: source.type,
      sourceDescription: "base64 input",
    };
  }

  if (source.type === "url") {
    const { bytes, finalUrl } = await downloadPublicHttpsUrl(
      source.url,
    );

    return {
      bytes,
      sourceType: source.type,
      sourceDescription: finalUrl,
    };
  }

  const path = await resolveAllowedLocalMediaPath(source.path);
  const fileStats = await stat(path);

  if (!fileStats.isFile()) {
    throw new Error("Local media source must be a regular file");
  }

  enforceSize(fileStats.size);
  const bytes = await readFile(path);
  enforceSize(bytes.byteLength);

  return {
    bytes,
    sourceType: source.type,
    sourceDescription: path,
  };
}

async function downloadPublicHttpsUrl(
  sourceUrl: string,
): Promise<{ bytes: Buffer; finalUrl: string }> {
  let currentUrl = new URL(sourceUrl);

  for (
    let redirectCount = 0;
    redirectCount <= MEDIA_DOWNLOAD_REDIRECT_LIMIT;
    redirectCount += 1
  ) {
    await validatePublicHttpsUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      headers: {
        accept: "image/*,audio/*,video/*,font/*,application/octet-stream",
        "user-agent": "anki-mcp-media/0.1",
      },
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");

      if (
        location === null ||
        redirectCount === MEDIA_DOWNLOAD_REDIRECT_LIMIT
      ) {
        throw new Error(
          "Media URL redirected too many times or omitted a destination",
        );
      }

      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Media download failed with status ${response.status}`,
      );
    }

    const declaredLength = response.headers.get("content-length");

    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);

      if (Number.isFinite(parsedLength)) {
        enforceSize(parsedLength);
      }
    }

    if (response.body === null) {
      throw new Error("Media URL returned an empty response body");
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalLength += value.byteLength;
      enforceSize(totalLength);
      chunks.push(Buffer.from(value));
    }

    return {
      bytes: Buffer.concat(chunks, totalLength),
      finalUrl: redactUrl(currentUrl),
    };
  }

  throw new Error("Media URL could not be downloaded");
}

async function validatePublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("Media URL must use HTTPS");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Media URL cannot contain credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Media URL cannot target localhost");
  }

  if (isIP(hostname) !== 0) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Media URL cannot target a private IP address");
    }
    return;
  }

  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new Error(
      "Media URL must resolve only to public IP addresses",
    );
  }
}

/** Recognizes loopback, private, link-local, and unspecified addresses. */
export function isPrivateIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();

  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    const third = octets[2] ?? -1;

    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 &&
        second === 0 &&
        (third === 0 || third === 2)) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }

  if (isIP(normalized) === 6) {
    const mappedIpv4 = parseMappedIpv4Address(normalized);

    if (mappedIpv4 !== null) {
      return isPrivateIpAddress(mappedIpv4);
    }

    const firstHextet = Number.parseInt(normalized.split(":")[0] ?? "", 16);

    if (
      !Number.isFinite(firstHextet) ||
      firstHextet < 0x2000 ||
      firstHextet > 0x3fff ||
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("2001:db8")
    ) {
      return true;
    }

    return false;
  }

  return true;
}

async function resolveAllowedLocalMediaPath(
  submittedPath: string,
): Promise<string> {
  if (!isAbsolute(submittedPath)) {
    throw new Error("Local media source path must be absolute");
  }

  const configuredRoots = (process.env.ANKI_MEDIA_IMPORT_DIRS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);

  if (configuredRoots.length === 0) {
    throw new Error(
      "Local media imports are disabled; configure ANKI_MEDIA_IMPORT_DIRS first",
    );
  }

  const resolvedFile = await realpath(resolve(submittedPath));

  for (const configuredRoot of configuredRoots) {
    let resolvedRoot: string;

    try {
      resolvedRoot = await realpath(resolve(configuredRoot));
    } catch {
      continue;
    }

    const relativePath = relative(resolvedRoot, resolvedFile);

    if (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    ) {
      return resolvedFile;
    }
  }

  throw new Error(
    "Local media source is outside ANKI_MEDIA_IMPORT_DIRS",
  );
}

function enforceSize(byteLength: number): void {
  if (byteLength <= 0) {
    throw new Error("Media source is empty");
  }

  if (byteLength > MEDIA_FILE_SIZE_LIMIT) {
    throw new Error(
      `Media source exceeds the ${MEDIA_FILE_SIZE_LIMIT} byte limit`,
    );
  }
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function parseMappedIpv4Address(address: string): string | null {
  const dotted = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];

  if (dotted !== undefined) {
    return dotted;
  }

  const hexadecimal = address.match(
    /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u,
  );

  if (hexadecimal?.[1] === undefined || hexadecimal[2] === undefined) {
    return null;
  }

  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function redactUrl(url: URL): string {
  const redacted = new URL(url);
  redacted.search = "";
  redacted.hash = "";
  return redacted.toString();
}
