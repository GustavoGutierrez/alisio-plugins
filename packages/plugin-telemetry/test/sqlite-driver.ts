/**
 * Test-only SQLite driver.
 *
 * Tests must not require an Alisio host, so this helper implements the SDK's
 * `SqlDatabase` port over the Node `node:sqlite` built-in. It is referenced only
 * from `test/` and is excluded from the published package (`package.json#files`
 * ships `dist`, not `test`). Production code opens its database through
 * `api.storage.sqlite` and never imports this file.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "@alisio/sdk";
import { type ConfigureDatabaseOptions, configureDatabase } from "../src/database.js";

const requireBuiltin = createRequire(import.meta.url);

/**
 * Load `node:sqlite` lazily. A static import would emit Node's experimental
 * warning merely by loading the test suite.
 */
let sqliteModule: typeof import("node:sqlite") | null = null;
function loadSqlite(): typeof import("node:sqlite") {
  sqliteModule ??= requireBuiltin("node:sqlite") as typeof import("node:sqlite");
  return sqliteModule;
}

/**
 * Open a private SQLite database with the telemetry pragmas, mirroring the host
 * port that production receives. The parent directory must exist before
 * `node:sqlite` creates the file, exactly as `api.storage.sqlite` does for us.
 */
export function openSqlite(path: string, options: ConfigureDatabaseOptions = {}): SqlDatabase {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const database = new (loadSqlite().DatabaseSync)(inMemory ? ":memory:" : path);
  const cache = new Map<string, ReturnType<typeof database.prepare>>();

  const statement = (sql: string) => {
    let prepared = cache.get(sql);
    if (prepared === undefined) {
      prepared = database.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  };

  const port: SqlDatabase = {
    exec(sql: string): void {
      database.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const prepared = statement(sql);
      return {
        run(...params: SqlValue[]) {
          const result = prepared.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get(...params: SqlValue[]): SqlRow | undefined {
          return prepared.get(...params) as SqlRow | undefined;
        },
        all(...params: SqlValue[]): SqlRow[] {
          return prepared.all(...params) as SqlRow[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The transaction may already be closed; the original error wins.
        }
        throw error;
      }
    },
    close(): void {
      cache.clear();
      database.close();
    },
  };

  return configureDatabase(port, path, options);
}
