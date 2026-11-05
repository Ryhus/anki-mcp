import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const PACKAGE_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function isDeckPackageName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".apkg") && lower !== "collection.apkg";
}

export async function resolvePackageDirectory(envKey: "ANKI_PACKAGE_IMPORT_DIR" | "ANKI_PACKAGE_EXPORT_DIR") {
  const configured = process.env[envKey]?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error(`Configure ${envKey} with an absolute path to an existing, trusted directory.`);
  }
  try {
    const root = await realpath(configured);
    if (!(await stat(root)).isDirectory()) throw new Error("Not a directory.");
    return root;
  } catch {
    throw new Error(`${envKey} must resolve to an accessible directory.`);
  }
}

export async function resolvePackageImportPath(root: string, submittedPath: string) {
  if (!isAbsolute(submittedPath) || !isDeckPackageName(basename(submittedPath))) {
    throw new Error("Use an absolute .apkg deck package path. Collection backups are not supported.");
  }
  let path: string;
  try {
    path = await realpath(submittedPath);
  } catch {
    throw new Error("The package file could not be resolved.");
  }
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("The package file is outside ANKI_PACKAGE_IMPORT_DIR.");
  }
  if (!isDeckPackageName(basename(path))) throw new Error("The resolved file is not a supported .apkg deck package.");
  return path;
}

/** Bounded streaming fingerprint; optionally copies the same bytes into a private directory. */
export async function inspectPackageFile(path: string, maxBytes = Number.MAX_SAFE_INTEGER, copyTo?: string) {
  if (!(await lstat(path)).isFile()) throw new Error("The package must be a regular file.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < BigInt(zipHeader.length) || before.size > BigInt(maxBytes)) {
      throw new Error(`The package must be a nonempty regular file no larger than ${maxBytes} bytes.`);
    }
    const header = Buffer.alloc(zipHeader.length);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.equals(zipHeader)) {
      throw new Error("The package does not have a ZIP archive header.");
    }
    const size = Number(before.size);
    const hash = createHash("sha256");
    const copy = copyTo === undefined ? null : await open(copyTo, "wx", 0o600);
    let read = 0;
    try {
      for await (const chunk of file.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
        hash.update(chunk);
        if (copy !== null) await copy.writeFile(chunk);
        read += chunk.length;
      }
    } finally {
      await copy?.close();
    }
    const after = await file.stat({ bigint: true });
    if (read !== size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("The package file changed while it was being read.");
    }
    return { byteSize: size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function createExportDestination(root: string, fileName: string) {
  return join(await mkdtemp(join(root, "anki-export-")), fileName);
}

export async function createImportSnapshotPath() {
  return join(await mkdtemp(join(await realpath(tmpdir()), "anki-mcp-import-")), "input.apkg");
}

/** Removes only our known staging file and empty private directory. */
export async function cleanImportSnapshot(path: string): Promise<boolean> {
  try {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(dirname(path));
    return true;
  } catch {
    return false;
  }
}
