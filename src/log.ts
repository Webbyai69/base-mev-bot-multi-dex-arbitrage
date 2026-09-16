/** Tiny leveled logger with timestamps; no dependencies. */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: Level = "info";

export function setLogLevel(level: Level): void {
  current = level;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = args
    .map((a) => (typeof a === "string" ? a : typeof a === "bigint" ? a.toString() : JSON.stringify(a, bigintReplacer)))
    .join(" ");
  const out = `${ts()} ${level.toUpperCase().padEnd(5)} ${line}`;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
