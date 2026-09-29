import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export async function downloadFile(
  url: string,
  file: string,
  hash: string,
  algorithm: "sha1" | "sha256" = "sha1",
) {
  if (
    !/^https:\/\//.test(url) ||
    !new RegExp(`^[a-f0-9]{${algorithm === "sha1" ? 40 : 64}}$`, "i").test(hash)
  )
    throw new Error("Invalid verified download");
  const matches = (bytes: Buffer) =>
    createHash(algorithm).update(bytes).digest("hex") === hash.toLowerCase();
  try {
    if (matches(await readFile(file))) return;
  } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok)
    throw new Error(
      `Download failed: ${response.status} ${new URL(url).hostname}`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!matches(bytes))
    throw new Error(`Checksum mismatch: ${new URL(url).pathname}`);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}
export async function readJson<T = any>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new Error(
      `Metadata download failed (${response.status}): ${new URL(url).hostname}`,
    );
  return response.json() as Promise<T>;
}
export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Minimal bounded ZIP extraction for verified launcher/toolchain archives. */
export async function extractZip(file: string, directory: string) {
  const bytes = await readFile(file),
    target = resolve(directory);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    bytes.readUInt32LE(end) !== 0x06054b50
  )
    end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50)
    throw new Error("Invalid ZIP directory");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16),
    total = 0;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP entry");
    const compression = bytes.readUInt16LE(cursor + 10),
      packed = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24),
      length = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + length)
      .toString("utf8");
    const path = resolve(target, name.replace(/\\/g, "/"));
    if (
      !path.startsWith(target + sep) ||
      name.includes("\0") ||
      ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000
    )
      throw new Error("Unsafe ZIP path");
    total += size;
    if (size > 200 * 1024 * 1024 || total > 1200 * 1024 * 1024)
      throw new Error("ZIP extraction budget exceeded");
    if (name.endsWith("/")) await mkdir(path, { recursive: true });
    else {
      if (bytes.readUInt32LE(offset) !== 0x04034b50)
        throw new Error("Invalid ZIP local entry");
      const start =
        offset +
        30 +
        bytes.readUInt16LE(offset + 26) +
        bytes.readUInt16LE(offset + 28);
      const encoded = bytes.subarray(start, start + packed);
      const decoded =
        compression === 0
          ? encoded
          : compression === 8
            ? inflateRawSync(encoded, { maxOutputLength: size || 1 })
            : undefined;
      if (!decoded || decoded.length !== size)
        throw new Error("Unsupported or truncated ZIP entry");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, decoded, {
        mode: (bytes.readUInt32LE(cursor + 38) >>> 16) & 0o777 || 0o644,
      });
    }
    cursor += 46 + length + extra + comment;
  }
}
