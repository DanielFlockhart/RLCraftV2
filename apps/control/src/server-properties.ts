import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Raise the player limit without replacing other server settings or lowering a higher limit. */
export function ensurePlayerCapacity(path: string, minimum: number) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existing = [
    ...text.matchAll(/^[ \t]*max-players\s*[:=]\s*([^\r\n]*)/gm),
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const capacity = Math.max(100, minimum, ...existing);
  const pattern = /^[ \t]*max-players\s*[:=][^\r\n]*/gm;
  const updated =
    existing.length || pattern.test(text)
      ? text.replace(pattern, `max-players=${capacity}`)
      : text +
        (text && !text.endsWith("\n") ? "\n" : "") +
        `max-players=${capacity}\n`;
  if (updated !== text) writeFileSync(path, updated);
  return capacity;
}
