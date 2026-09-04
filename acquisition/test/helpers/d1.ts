// A fake D1Database backed by node:sqlite.
//
// D1 *is* SQLite, so running the real migration and the real queries against a
// real SQLite engine tests the SQL itself — not just our string building. This
// catches schema mistakes that a mocked database would happily accept.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// node:sqlite is a recent builtin that Vite's resolver does not know about, so
// load it at runtime rather than letting the bundler try to resolve it.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

type Row = Record<string, unknown>;

function normalizeRow(row: Row): Row {
  // node:sqlite returns null-prototype objects; give tests plain ones.
  return { ...row };
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values);
  }

  private stmt() {
    return this.db.prepare(this.sql);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.stmt().get(...(this.values as never[])) as Row | undefined;
    if (row === undefined) return null;
    const plain = normalizeRow(row);
    return (colName ? (plain[colName] as T) : (plain as T)) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Row }> {
    const rows = this.stmt().all(...(this.values as never[])) as Row[];
    return { results: rows.map(normalizeRow) as T[], success: true, meta: {} };
  }

  async run<T = Row>(): Promise<{ results: T[]; success: true; meta: Row }> {
    // SQLite's run() throws on statements that return rows (RETURNING), so
    // route through all() and let both shapes work, exactly as D1 does.
    const rows = this.stmt().all(...(this.values as never[])) as Row[];
    return { results: rows.map(normalizeRow) as T[], success: true, meta: {} };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.stmt().all(...(this.values as never[])) as Row[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

export interface FakeD1 {
  prepare(sql: string): FakeStatement;
  batch(statements: FakeStatement[]): Promise<{ results: Row[]; success: true; meta: Row }[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  /** Test-only escape hatch. */
  __raw: DatabaseSync;
}

export function createTestDb(migrationPath = "migrations/0001_init.sql"): FakeD1 {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = ON;");
  db.exec(readFileSync(migrationPath, "utf8"));

  return {
    prepare: (sql: string) => new FakeStatement(db, sql),
    async batch(statements) {
      db.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec("commit");
        return out as { results: Row[]; success: true; meta: Row }[];
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    __raw: db,
  };
}
