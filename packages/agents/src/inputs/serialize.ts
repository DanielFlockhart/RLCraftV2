import type { InputValue } from "@mlcraft/core";
export function inputJson(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): InputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : { type: "nonFinite", value: String(value) };
  if (typeof value === "bigint")
    return { type: "bigint", value: String(value) };
  if (Buffer.isBuffer(value))
    return {
      encoding: "base64",
      data: value.toString("base64"),
      bytes: value.length,
    };
  if (ArrayBuffer.isView(value))
    return {
      encoding: "base64",
      data: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
      type: value.constructor.name,
      bytes: value.byteLength,
    };
  if (typeof value !== "object")
    return { type: "unsupported", value: typeof value };
  if (depth > 24) return { truncated: true, reason: "maximum nesting" };
  if (seen.has(value)) return { reference: true };
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry) => inputJson(entry, depth + 1, seen));
    if (value instanceof Map)
      return Object.fromEntries(
        [...value].map(([key, entry]) => [
          String(key),
          inputJson(entry, depth + 1, seen),
        ]),
      );
    const record = value as Record<string, unknown>;
    // Avoid following client sockets or entity backreferences on high-level events.
    const omitted = new Set([
      "_client",
      "_events",
      "_eventsCount",
      "_maxListeners",
      "bot",
      "player",
      "vehicle",
      "passengers",
    ]);
    return Object.fromEntries(
      Object.entries(record)
        .filter(
          ([key, entry]) =>
            !omitted.has(key) &&
            typeof entry !== "function" &&
            entry !== undefined,
        )
        .map(([key, entry]) => [key, inputJson(entry, depth + 1, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}
export function projectFields(
  value: InputValue,
  fields?: string[],
): InputValue {
  if (!fields) return value;
  if (!value || Array.isArray(value) || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => fields.includes(key)),
  );
}
