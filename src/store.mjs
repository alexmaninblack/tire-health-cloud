// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from "node:sqlite";

// Foundation bookkeeping only. No Tire product table, model or receipt is
// created by P1. Product ingestion must remain closed until its real migration.
const schema = "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT";
export function foundationProof(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) throw new Error("UNKNOWN_NEWER_SCHEMA");
  const objects = database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (version !== 1 || objects.length !== 1 || objects[0].type !== "table" || objects[0].name !== "schema_version" || objects[0].sql !== schema) throw new Error("SCHEMA_INVALID");
  const rows = database.prepare("SELECT version, name, applied_at FROM schema_version").all();
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].name !== "tire_lifecycle_foundation" || !Number.isFinite(Date.parse(rows[0].applied_at))) throw new Error("SCHEMA_INVALID");
  return {scope: "FOUNDATION_ONLY", productIngestion: false, schemaVersion: 1, noProductTablesOrRecords: true, unknownTables: false, removalEligible: true};
}

export function openStore(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = database.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("UNKNOWN_NEWER_SCHEMA");
    if (version === 0) {
      if (database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length !== 0) throw new Error("SCHEMA_INVALID");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(schema);
        database.prepare("INSERT INTO schema_version VALUES (1, 'tire_lifecycle_foundation', ?)").run(new Date().toISOString());
        database.exec("PRAGMA user_version=1; COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    foundationProof(database);
    database.exec("BEGIN IMMEDIATE; UPDATE schema_version SET name=name WHERE version=1; ROLLBACK;");
    return database;
  } catch (error) { database.close(); throw error; }
}
