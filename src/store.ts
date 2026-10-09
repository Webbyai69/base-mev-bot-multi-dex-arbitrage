/**
 * Append-only JSONL storage (one record per line) with BigInt support, plus
 * small JSON documents for snapshots/state. No database needed; files are
 * easy to inspect, grep and load into a spreadsheet.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bigintReplacer } from "./log.js";

export type AppendListener = (file: string, record: unknown) => void;

export class Store {
  private listeners: AppendListener[] = [];

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  append(name: string, record: unknown): void {
    appendFileSync(this.path(name), JSON.stringify(record, bigintReplacer) + "\n");
    // The dashboard's live feed and the Telegram alerts listen here. A listener
    // can never break the write or the bot loop.
    for (const fn of this.listeners) {
      try {
        fn(name, record);
      } catch {
        /* ignore */
      }
    }
  }

  /** Be told about every record appended from now on. Returns an unsubscribe function. */
  onAppend(fn: AppendListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  /** Stream every record of a JSONL file; `filter` can stop early by returning false. */
  async *read<T = Record<string, unknown>>(name: string): AsyncGenerator<T> {
    const file = this.path(name);
    if (!existsSync(file)) return;
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // skip a torn last line from an interrupted write
      }
    }
  }

  /** The last records of a JSONL file, reading at most `maxBytes` from its end (cheap on big files). */
  tail<T = Record<string, unknown>>(name: string, maxBytes = 256 * 1024): T[] {
    const file = this.path(name);
    if (!existsSync(file)) return [];
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      const out: T[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          /* torn line */
        }
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }

  async readAll<T = Record<string, unknown>>(name: string, predicate?: (r: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for await (const r of this.read<T>(name)) if (!predicate || predicate(r)) out.push(r);
    return out;
  }

  writeJson(name: string, value: unknown): void {
    writeFileSync(this.path(name), JSON.stringify(value, bigintReplacer, 2));
  }

  readJson<T>(name: string): T | undefined {
    const file = this.path(name);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }
}

/** Date key (UTC) for grouping records by day. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}
