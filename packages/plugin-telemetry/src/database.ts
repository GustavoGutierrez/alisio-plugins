/**
 * The host-provided SQLite storage port.
 *
 * The database is opened by the host through `api.storage.sqlite(path)`, so the
 * plugin never depends on a runtime SQLite driver. The host port applies its
 * file permissions only when it creates the file and sets no pragmas, so this
 * module hardens the port immediately after it is opened: it enables WAL, a
 * `busy_timeout`, foreign keys and NORMAL synchronous mode, and defensively
 * tightens the database file to 0600 and its parent directory to 0700.
 * `PRAGMA optimize` runs periodically from the store.
 *
 * The types are re-exported from `@alisio/sdk` so the rest of the plugin stays
 * driver-agnostic. Tests must run without a host; they inject an equivalent
 * `SqlDatabase` from `test/sqlite-driver.ts`, which is never shipped.
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDatabase } from "@alisio/sdk";

export type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "@alisio/sdk";

export interface ConfigureDatabaseOptions {
  /** Milliseconds a locked database waits before failing. Defaults to 5000. */
  busyTimeoutMs?: number;
  /** Skip the WAL/busy_timeout/foreign_keys pragmas (used only by focused tests). */
  minimal?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** File mode bits of `path`, or null when it does not exist. Exposed for tests. */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Create (if needed) and tighten the parent directory to 0700. */
function ensureParent(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // `mkdirSync`'s mode is masked by the process umask, so tighten explicitly.
  try {
    chmodSync(parent, 0o700);
  } catch {
    // A read-only or foreign filesystem is not a reason to fail telemetry.
  }
}

/** Best-effort 0600 on the database file; permissions are hardening, not a gate. */
function tightenFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignore: some filesystems reject chmod.
  }
}

/**
 * Harden an already-open host port with the telemetry pragmas and file
 * permissions. The port is returned unchanged so callers can chain it.
 */
export function configureDatabase(
  database: SqlDatabase,
  path: string,
  options: ConfigureDatabaseOptions = {},
): SqlDatabase {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) {
    ensureParent(path);
    tightenFile(path);
  }

  if (!options.minimal) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(
      `PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`,
    );
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = NORMAL");
  }

  return database;
}
