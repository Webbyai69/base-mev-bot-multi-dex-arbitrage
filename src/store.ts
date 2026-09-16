/**
 * Append-only JSONL storage (one record per line) with BigInt support, plus
 * small JSON documents for snapshots/state. No database needed; files are
 * easy to inspect, grep and load into a spreadsheet.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bigintReplacer } from "./log.js";

export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  append(name: string, record: unknown): void {
    appendFileSync(this.path(name), JSON.stringify(record, bigintReplacer) + "\n");
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
