import crypto from "node:crypto";

/**
 * A PostgREST-shaped in-memory backend for billing suites that exercise real
 * modules end to end (rows, idempotent replays, ledger writes) without a
 * database. Supports the filter grammar the billing store emits: eq/neq/is/
 * lt/gt/gte/lte/in and `or=(...)`, plus order/limit and `Prefer` upserts.
 */
export type Row = Record<string, any>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const UNIQUE: Record<string, { match: (row: Row, incoming: Row) => boolean; constraint: string }> = {
  billing_shipments: { match: (row, incoming) => row.order_id === incoming.order_id, constraint: "billing_shipments_order_id_key" },
  billing_ledger: { match: (row, incoming) => row.kind === incoming.kind && row.stripe_ref === incoming.stripe_ref, constraint: "billing_ledger_kind_stripe_ref_unique" },
};

export class FakePostgrest {
  tables: Record<string, Row[]> = {};
  tokens = new Map<string, string>();
  inserts: string[] = [];
  seq = 0;

  constructor(readonly tableNames: string[]) { this.reset(); }

  reset(): void {
    this.tables = Object.fromEntries(this.tableNames.map((name) => [name, []]));
    this.tokens.clear();
    this.inserts = [];
    this.seq = 0;
  }

  private parse(raw: string): [string, string] {
    const dot = raw.indexOf(".");
    return [raw.slice(0, dot), raw.slice(dot + 1)];
  }

  private matches(row: Row, column: string, operation: string, raw: string): boolean {
    if (column === "or") {
      return raw.replace(/^\(|\)$/g, "").split(",").some((clause) => {
        const col = clause.slice(0, clause.indexOf("."));
        const [op, value] = this.parse(clause.slice(clause.indexOf(".") + 1));
        return this.matches(row, col, op, value);
      });
    }
    const value = row[column];
    if (operation === "eq") return String(value ?? "") === raw;
    if (operation === "neq") return String(value ?? "") !== raw;
    if (operation === "is" && raw === "null") return value == null;
    if (operation === "lt") return String(value) < raw;
    if (operation === "gt") return String(value) > raw;
    if (operation === "gte") return String(value) >= raw;
    if (operation === "lte") return String(value) <= raw;
    if (operation === "in") return raw.replace(/^\(|\)$/g, "").split(",").includes(String(value));
    throw new Error(`Unsupported fake filter: ${column} ${operation} ${raw}`);
  }

  private select(url: URL, rows: Row[]): Row[] {
    const filters: Array<[string, string, string]> = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      if (key === "or") { filters.push(["or", "", raw]); return; }
      const [op, value] = this.parse(raw);
      filters.push([key, op, value]);
    });
    return rows.filter((row) => filters.every(([column, op, raw]) => this.matches(row, column, op, raw)));
  }

  private stamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 8, 20, 0, 0, this.seq)).toISOString();
  }

  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/auth/v1/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /i, "") ?? "";
      const id = this.tokens.get(token);
      return id ? json(200, { id }) : json(401, { message: "invalid token" });
    }
    const match = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
    if (!match) return json(404, { message: `Unhandled fake path ${url.pathname}` });
    const table = match[1];
    const rows = this.tables[table];
    if (!rows) return json(404, { message: `Unknown fake table ${table}` });
    if (method === "GET") {
      let selected = this.select(url, rows);
      const order = url.searchParams.get("order");
      if (order) {
        const keys = order.split(",").map((part) => part.split("."));
        selected = [...selected].sort((a, b) => {
          for (const [column, direction] of keys) {
            const cmp = String(a[column]).localeCompare(String(b[column]));
            if (cmp) return direction === "desc" ? -cmp : cmp;
          }
          return 0;
        });
      }
      const limit = Number(url.searchParams.get("limit"));
      if (limit) selected = selected.slice(0, limit);
      return json(200, selected);
    }
    if (method === "POST") {
      const incoming = JSON.parse(String(init?.body ?? "{}"));
      const prefer = new Headers(init?.headers).get("prefer") ?? "";
      const unique = UNIQUE[table];
      const duplicate = unique ? (row: Row) => unique.match(row, incoming) : (row: Row) => Boolean(incoming.id) && row.id === incoming.id;
      if (rows.some(duplicate)) {
        if (prefer.includes("merge-duplicates")) {
          const existing = rows.find(duplicate)!;
          Object.assign(existing, incoming, { updated_at: this.stamp() });
          return json(200, [existing]);
        }
        return json(409, { code: "23505", message: `duplicate key value violates unique constraint "${unique?.constraint ?? `${table}_pkey`}"` });
      }
      const stamp = this.stamp();
      const row = { id: incoming.id ?? crypto.randomUUID(), created_at: stamp, updated_at: stamp, ...incoming };
      rows.push(row);
      this.inserts.push(table);
      if (table === "billing_orders" && this.tables.billing_shipments) {
        // Mirrors the after-insert trigger: every order starts with a processing shipment.
        this.tables.billing_shipments.push({
          id: crypto.randomUUID(), order_id: row.id, provider_id: row.provider_id, status: "processing", carrier: null,
          tracking_number: null, tracking_url: null, source: "staff", external_id: null, label_created_at: null,
          shipped_at: null, delivered_at: null, canceled_at: null, canceled_reason: null, events: [], updated_by: null,
          created_at: stamp, updated_at: stamp,
        });
      }
      return json(201, [row]);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      const changed = this.select(url, rows);
      changed.forEach((row) => Object.assign(row, patch, { updated_at: this.stamp() }));
      return json(200, changed);
    }
    if (method === "DELETE") {
      const doomed = new Set(this.select(url, rows));
      this.tables[table] = rows.filter((row) => !doomed.has(row));
      return json(204, []);
    }
    return json(405, { message: "Unsupported fake method" });
  }

  /** Routes fetches for `hostname` here and leaves everything else to the real fetch. */
  fetchStub(hostname: string): typeof fetch {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    return ((input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(href).hostname === hostname ? Promise.resolve(this.handle(href, init)) : nativeFetch(input as string, init);
    }) as typeof fetch;
  }
}
