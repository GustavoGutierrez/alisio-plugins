import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlValue } from "@alisio/sdk";

/** `SqlDatabase` over `node:sqlite`, standing in for the host's `api.storage.sqlite`. */
export function openTestDb(path: string): SqlDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => statement.run(...(params as never[])) as never,
        get: (...params: SqlValue[]) => statement.get(...(params as never[])) as never,
        all: (...params: SqlValue[]) => statement.all(...(params as never[])) as never,
      };
    },
    transaction(fn) {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
