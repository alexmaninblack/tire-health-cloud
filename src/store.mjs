// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import {DatabaseSync} from "node:sqlite";
import {randomUUID, randomBytes} from "node:crypto";
import {canonical, digest, validateMessage} from "./protocol.mjs";

const ledger = "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT";
const schema = [ledger,
  "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_key TEXT NOT NULL UNIQUE, system_uid TEXT NOT NULL, kind TEXT NOT NULL, content_digest TEXT NOT NULL, message_digest TEXT NOT NULL, canonical TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL) STRICT",
  ...["assessments", "condition_events", "advisory_facts", "function_status"].map(name => `CREATE TABLE ${name} (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE) STRICT`),
  "CREATE TABLE quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, system_uid TEXT NOT NULL, message_key TEXT NOT NULL, message_digest TEXT NOT NULL, canonical TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(message_key, message_digest)) STRICT"
];
const categories = {messages: "messages", assessments: "assessments", events: "condition_events", advisories: "advisory_facts", functionStatus: "function_status", quarantine: "quarantine"};
const kinds = {TIRE_HEALTH_ASSESSMENT: "assessments", TIRE_CONDITION_BAND_CHANGED: "condition_events", TIRE_ADVISORY_FACT: "advisory_facts", TIRE_FUNCTION_STATUS: "function_status"};
function validateSchema(database, version = 2) {
  const actualVersion = database.prepare("PRAGMA user_version").get().user_version;
  if (actualVersion > 2) throw new Error("UNKNOWN_NEWER_SCHEMA");
  const objects = database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY sql").all().map(r => r.sql);
  if (actualVersion !== version || canonical(objects) !== canonical((version === 1 ? [ledger] : schema).toSorted())) throw new Error("SCHEMA_INVALID");
  const rows = database.prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version").all();
  if (rows.length !== version || rows[0]?.name !== "tire_lifecycle_foundation" || rows[0]?.version !== 1 ||
      (version === 2 && (rows[1]?.version !== 2 || rows[1]?.name !== "tire_product_v1")) || rows.some(r => !Number.isFinite(Date.parse(r.applied_at)))) throw new Error("SCHEMA_INVALID");
  if (database.prepare("PRAGMA quick_check").get().quick_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SCHEMA_INVALID");
}
export function foundationProof(database) {
  validateSchema(database, 1);
  return {scope: "FOUNDATION_ONLY", productIngestion: false, schemaVersion: 1, noProductTablesOrRecords: true, unknownTables: false, removalEligible: true};
}
function transaction(database, operation, write = true) {
  database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {const result = operation(); database.exec("COMMIT"); return result;}
  catch (error) {if (database.isTransaction) database.exec("ROLLBACK"); throw error;}
}
export function openStore(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    let version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 2) throw new Error("UNKNOWN_NEWER_SCHEMA");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length) throw new Error("SCHEMA_INVALID");
      transaction(db, () => {db.exec(ledger); db.prepare("INSERT INTO schema_version VALUES(1,'tire_lifecycle_foundation',?)").run(new Date().toISOString()); db.exec("PRAGMA user_version=1");}); version = 1;
    }
    if (version === 1) {
      validateSchema(db, 1);
      transaction(db, () => {for (const sql of schema.slice(1)) db.exec(sql); db.prepare("INSERT INTO schema_version VALUES(2,'tire_product_v1',?)").run(new Date().toISOString()); db.exec("PRAGMA user_version=2");});
    }
    validateSchema(db); db.exec("BEGIN IMMEDIATE; UPDATE schema_version SET name=name WHERE version=2; ROLLBACK;"); return db;
  } catch (error) {db.close(); throw error;}
}
export class TireStore {
  constructor(database, currentBinding, clock = () => new Date()) {this.db = database; this.currentBinding = currentBinding; this.clock = clock; this.previews = new Map();}
  ready() {validateSchema(this.db); return true;}
  ingest(bytes) {
    const input = validateMessage(bytes), message = input.message, binding = this.currentBinding();
    if (!binding) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
    if (!binding.systemUids.includes(message.unitSystemUid)) throw new Error("UNIT_NOT_CURRENT");
    if (message.unitRole && message.unitRole !== (message.unitSystemUid === binding.testSystemUid ? "VALIDATION" : "PRODUCTION")) throw new Error("INVALID_MESSAGE");
    return transaction(this.db, () => {
      const previous = this.db.prepare("SELECT * FROM messages WHERE message_key=?").get(input.key);
      if (previous && previous.message_digest !== input.messageDigest) {
        this.db.prepare("INSERT OR IGNORE INTO quarantine(system_uid,message_key,message_digest,canonical,received_at) VALUES(?,?,?,?,?)").run(message.unitSystemUid, input.key, input.messageDigest, input.canonical, this.clock().toISOString());
        return {status: 409, body: {schemaVersion: 1, contractVersion: "1.0.0", errorCode: "DELIVERY_CONFLICT", retryable: false}};
      }
      const receipt = previous ?? {receipt_id: randomUUID(), received_at: this.clock().toISOString()};
      if (!previous) {
        const inserted = this.db.prepare("INSERT INTO messages(message_key,system_uid,kind,content_digest,message_digest,canonical,receipt_id,received_at) VALUES(?,?,?,?,?,?,?,?)").run(input.key, message.unitSystemUid, message.messageType, message.contentSha256, input.messageDigest, input.canonical, receipt.receipt_id, receipt.received_at);
        this.db.prepare(`INSERT INTO ${kinds[message.messageType]}(message_id) VALUES(?)`).run(inserted.lastInsertRowid);
      }
      return {status: previous ? 200 : 201, body: {schemaVersion: 1, contractVersion: "1.0.0", receiptId: receipt.receipt_id, messageKeySha256: input.key, contentSha256: message.contentSha256, state: previous ? "DUPLICATE_ACCEPTED" : "DURABLE_ACCEPTED", receivedAt: receipt.received_at}, systemUid: message.unitSystemUid};
    });
  }
  query(uid, category, {limit = 50, cursor} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !["assessments", "events", "advisories", "functionStatus"].includes(category)) throw new Error("INVALID_REQUEST");
    let anchor = this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM messages").get().n, before = anchor + 1;
    if (cursor) {
      try {
        if (cursor.length > 512) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (Object.keys(value).sort().join() !== "anchor,before,category,uid" || value.uid !== uid || value.category !== category || !Number.isSafeInteger(value.anchor) || value.anchor < 0 || !Number.isSafeInteger(value.before) || value.before < 1 || value.before > value.anchor + 1) throw new Error();
        anchor = value.anchor; before = value.before;
      } catch {throw new Error("INVALID_REQUEST");}
    }
    const rows = this.db.prepare(`SELECT m.* FROM ${categories[category]} p JOIN messages m ON m.id=p.message_id WHERE m.system_uid=? AND m.id<=? AND m.id<? ORDER BY m.id DESC LIMIT ?`).all(uid, anchor, before, limit + 1);
    const items = rows.slice(0, limit).map(r => ({message: JSON.parse(r.canonical), backendReceivedAt: r.received_at, deliveryState: "DURABLE_ACCEPTED",
      ...(category === "functionStatus" ? {authority: "FUNCTION_TEAM_REPORTED_STATUS", stale: this.clock().getTime() - Date.parse(JSON.parse(r.canonical).observedAt) > 90000} : {})}));
    return {schemaVersion: 2, contractVersion: "2.0.0", unitSystemUid: uid, items, nextCursor: rows.length > limit ? Buffer.from(canonical({uid, category, anchor, before: rows[limit - 1].id})).toString("base64url") : null};
  }
  selector(systemUids) {
    const binding = this.currentBinding();
    if (!binding) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
    if (!Array.isArray(systemUids) || systemUids.length < 1 || systemUids.length > 2 || new Set(systemUids).size !== systemUids.length || systemUids.some(uid => typeof uid !== "string" || !binding.systemUids.includes(uid))) throw new Error("INVALID_SELECTOR");
    const sorted = systemUids.toSorted();
    if (canonical(sorted) !== canonical(binding.systemUids) && canonical(sorted) !== canonical([binding.testSystemUid])) throw new Error("INVALID_SELECTOR");
    return sorted;
  }
  records(systemUids, matching) {
    const where = systemUids.length ? `system_uid ${matching ? "IN" : "NOT IN"} (${systemUids.map(() => "?").join(",")})` : "1=1";
    const counts = {}, all = {};
    for (const [name, table] of Object.entries(categories)) {
      const sql = ["messages", "quarantine"].includes(name) ? `SELECT * FROM ${table} WHERE ${where} ORDER BY id` : `SELECT p.message_id FROM ${table} p JOIN messages m ON m.id=p.message_id WHERE ${where} ORDER BY p.message_id`;
      const rows = this.db.prepare(sql).all(...systemUids); counts[name] = rows.length; all[name] = rows;
    }
    return {counts, digest: digest(canonical(all))};
  }
  emptyProof() {
    return transaction(this.db, () => {this.ready(); const records = this.records([], true); return {schemaVersion: 1, contractVersion: "1.0.0", databaseSchemaVersion: 2, state: Object.values(records.counts).every(n => n === 0) ? "EMPTY" : "NONEMPTY", recordCounts: records.counts, observedAt: this.clock().toISOString()};}, false);
  }
  preview(systemUids) {
    const selector = this.selector(systemUids); this.ready();
    const [selected, rest] = transaction(this.db, () => [this.records(selector, true), this.records(selector, false)], false);
    const now = this.clock().getTime();
    for (const [token, value] of this.previews) if (Date.parse(value.expiresAt) <= now) this.previews.delete(token);
    if (this.previews.size >= 16) throw new Error("TEMPORARILY_UNAVAILABLE");
    const result = {schemaVersion: 1, systemUids: selector, recordCounts: selected.counts, recordSetSha256: selected.digest, nonmatchingRecordCounts: rest.counts, nonmatchingRecordSetSha256: rest.digest, confirmationToken: randomBytes(32).toString("hex"), expiresAt: new Date(now + 60000).toISOString()};
    this.previews.set(result.confirmationToken, result); return result;
  }
  execute(systemUids, token) {
    const selector = this.selector(systemUids), preview = this.previews.get(token);
    if (!preview || Date.parse(preview.expiresAt) <= this.clock().getTime() || canonical(selector) !== canonical(preview.systemUids)) throw new Error("INVALID_PREVIEW");
    this.ready();
    return transaction(this.db, () => {
      const selected = this.records(selector, true), rest = this.records(selector, false);
      if (selected.digest !== preview.recordSetSha256 || rest.digest !== preview.nonmatchingRecordSetSha256) throw new Error("STALE_PREVIEW");
      const placeholders = selector.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM messages WHERE system_uid IN (${placeholders})`).run(...selector);
      this.db.prepare(`DELETE FROM quarantine WHERE system_uid IN (${placeholders})`).run(...selector);
      const remaining = this.records(selector, true), nonmatching = this.records(selector, false);
      if (Object.values(remaining.counts).some(n => n !== 0) || nonmatching.digest !== rest.digest) throw new Error("CLEANUP_PROOF_FAILED");
      this.previews.delete(token);
      return {schemaVersion: 1, contractVersion: "1.0.0", state: "CLEANED", systemUids: selector, deletedRecordCounts: selected.counts, remainingRecordCounts: remaining.counts, nonmatchingRecordCounts: nonmatching.counts, nonmatchingRecordSetSha256: nonmatching.digest, completedAt: this.clock().toISOString()};
    });
  }
}
