/**
 * A small read-only client for a Qortal Core node's HTTP API (default
 * http://127.0.0.1:12391), used by the command-line tools to read QDN
 * resources. Publishing is not done here: it needs your Qortal key, so it
 * happens in Qortal Hub (or the Qortal app), where you approve each publish.
 *
 * Routes used (Qortal Core):
 *   GET /admin/status                                  node status
 *   GET /arbitrary/resources/search?service=&identifier=&limit=&reverse=true
 *   GET /arbitrary/{service}/{name}/{identifier}       the resource's data
 */

export const DEFAULT_CORE = "http://127.0.0.1:12391";

export class QortalCore {
  constructor(base = DEFAULT_CORE, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.base = String(base).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    let res;
    try {
      res = await this.fetch(this.base + path, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json, text/plain, */*" } });
    } catch (e) {
      throw new Error(`Qortal Core at ${this.base} is not reachable (${String(e && e.message || e).slice(0, 80)}). Is Qortal Hub or Core running on this machine?`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Qortal Core ${path.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 120)}`);
    return text;
  }

  async status() {
    return JSON.parse(await this.get("/admin/status"));
  }

  /** Resources of one service and identifier, newest first: [{ name, service, identifier, updated }]. */
  async search(service, identifier, { limit = 50 } = {}) {
    const q = new URLSearchParams({ service, identifier, prefix: "false", mode: "ALL", limit: String(limit), reverse: "true" });
    const rows = JSON.parse(await this.get(`/arbitrary/resources/search?${q}`));
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && typeof r.name === "string" && r.identifier === identifier && (r.service === service || r.service === undefined))
      .map((r) => ({ name: r.name.slice(0, 40), service, identifier, updated: Number(r.updated || r.created) || null }));
  }

  /** The text of a resource. */
  async fetchText(service, name, identifier) {
    if (!/^[A-Za-z0-9 ._@-]{1,40}$/.test(name)) throw new Error(`refusing an unusual name: ${String(name).slice(0, 40)}`);
    return this.get(`/arbitrary/${encodeURIComponent(service)}/${encodeURIComponent(name)}/${encodeURIComponent(identifier)}`);
  }
}
