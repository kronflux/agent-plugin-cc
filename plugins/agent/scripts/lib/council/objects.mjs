// Digest-named council objects under `<runDir>/objects/` and the exports rebuilt from them.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OBJECT_NAME = /^[0-9a-f]{64}$/;
const EXTENSIONS = new Set(["md", "json"]);

/** A referenced object that is missing or whose bytes no longer have its digest. */
export class ObjectDamagedError extends Error {
  constructor({ sha256 }) {
    super(`The council object ${sha256} is missing or damaged.`);
    this.name = "ObjectDamagedError";
    this.sha256 = sha256;
  }
}

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkName(sha256, ext) {
  if (typeof sha256 !== "string" || !OBJECT_NAME.test(sha256)) {
    throw new TypeError(`Not a council object digest: ${sha256}`);
  }
  if (!EXTENSIONS.has(ext)) {
    throw new TypeError(`Not a council object extension: ${ext}`);
  }
}

function objectPath(runDir, sha256, ext) {
  return path.join(runDir, "objects", `${sha256}.${ext}`);
}

// Writes `bytes` to a new file at `file` and flushes it to disk before closing it.
function writeSynced(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function digestOfFile(file) {
  try {
    return digestOf(fs.readFileSync(file));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A temporary name left behind is harmless; no reader looks at it.
  }
}

/**
 * Installs `bytes` (a Buffer or string) as `objects/<sha256>.<ext>` and returns the digest. The
 * bytes go to a temporary file that is flushed and then hard-linked to the final name, so a
 * reader never sees a partial object. An existing object is kept when its bytes have the digest
 * and replaced when they do not.
 */
export function installObject(runDir, bytes, ext) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const sha256 = digestOf(buffer);
  checkName(sha256, ext);
  const dir = path.join(runDir, "objects");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = objectPath(runDir, sha256, ext);
  const temporary = path.join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  writeSynced(temporary, buffer);
  try {
    try {
      fs.linkSync(temporary, final);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (digestOfFile(final) !== sha256) {
        fs.renameSync(temporary, final);
      }
    }
  } finally {
    removeQuietly(temporary);
  }
  return sha256;
}

/** The bytes of `objects/<sha256>.<ext>`; throws ObjectDamagedError when missing or changed. */
export function readObject(runDir, sha256, ext) {
  checkName(sha256, ext);
  let bytes;
  try {
    bytes = fs.readFileSync(objectPath(runDir, sha256, ext));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ObjectDamagedError({ sha256 });
    }
    throw error;
  }
  if (digestOf(bytes) !== sha256) {
    throw new ObjectDamagedError({ sha256 });
  }
  return bytes;
}

/**
 * Rebuilds the export `name` (a path relative to `runDir`, such as `brief.md` or
 * `private/anonymisation.json`) from the object `sha256`: a flushed temporary file renamed over
 * the export. `readCurrentSha()` returns the digest the committed row names now; it is read
 * before and after the rename. When it no longer names this object before the rename, the earlier
 * export stays; when it changes after the rename, the export this call wrote is removed. Returns
 * whether the export now holds this object. Throws ObjectDamagedError when the object is.
 */
export function publishExport(runDir, name, sha256, readCurrentSha) {
  const ext = path.extname(name).slice(1);
  const bytes = readObject(runDir, sha256, ext);
  const target = path.join(runDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.tmp-${randomBytes(8).toString("hex")}`);
  writeSynced(temporary, bytes);
  try {
    if (readCurrentSha() !== sha256) {
      return false;
    }
    fs.renameSync(temporary, target);
    if (readCurrentSha() !== sha256) {
      if (digestOfFile(target) === sha256) {
        removeQuietly(target);
      }
      return false;
    }
    return true;
  } finally {
    removeQuietly(temporary);
  }
}
