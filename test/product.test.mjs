// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {canonical, digest, validateMessage, strictJson} from "../src/protocol.mjs";
import {openStore, TireStore, foundationProof} from "../src/store.mjs";
import {startBackend, adminOperation} from "../src/main.mjs";
const binding = {testSystemUid: "test-unit", productionSystemUid: "production-unit", systemUids: ["production-unit", "test-unit"]};
const names = ["tire-health-assessment", "tire-health-event", "tire-advisory-fact", "tire-function-status"];
function fixture(index = 0, uid = "test-unit") {
  const m = JSON.parse(readFileSync(new URL(`./fixtures/${names[index]}.valid.json`, import.meta.url)));
  delete m.$comment; m.unitSystemUid = uid; if (m.unitRole) m.unitRole = uid === "test-unit" ? "VALIDATION" : "PRODUCTION";
  m.contentSha256 = digest(canonical(m.content)); return m;
}
function withStore(callback) {
  const directory = mkdtempSync(join(tmpdir(), "tire-product-")), path = join(directory, "data.sqlite"); let db = openStore(path);
  try {callback(new TireStore(db, () => binding), db, () => {db.close(); db = openStore(path); return new TireStore(db, () => binding);});}
  finally {db.close(); rmSync(directory, {recursive: true, force: true});}
}
test("four closed messages, digest/duplicate/foreign/invalid schema rejection", () => {
  for (let i = 0; i < 4; i++) {
    const m = fixture(i); assert.equal(validateMessage(JSON.stringify(m)).message.messageType, m.messageType);
    assert.throws(() => validateMessage(JSON.stringify({...m, oracle: "HEALTHY"})));
    assert.throws(() => validateMessage(JSON.stringify({...m, contentSha256: "0".repeat(64)})));
    assert.throws(() => validateMessage(JSON.stringify({...m, serviceVersion: null})));
    assert.throws(() => strictJson(JSON.stringify(m).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')));
  }
  assert.throws(() => strictJson('{"x":"\\ud800"}'));
  assert.throws(() => validateMessage("not-json"), /INVALID_MESSAGE/);
  const status = fixture(3);
  assert.throws(() => validateMessage(JSON.stringify({...status, observedAt: "2026-02-31T12:00:00Z"})), /INVALID_MESSAGE/);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).aosedgeDemo.privateCleanupProtocol, "tire-product-v1");
});
test("durable receipt across restart, exact duplicate and envelope conflict quarantined", () => withStore((store, db, reopen) => {
  const m = fixture(), bytes = JSON.stringify(m), first = store.ingest(bytes);
  assert.equal(first.status, 201); assert.equal(first.body.messageKeySha256, digest(canonical([m.unitSystemUid, m.messageType, m.assessmentId])));
  store = reopen(); const duplicate = store.ingest(bytes); assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.receiptId, first.body.receiptId); assert.equal(duplicate.body.receivedAt, first.body.receivedAt);
  assert.equal(store.query("test-unit", "assessments").items.length, 1);
  assert.equal(store.ingest(JSON.stringify({...m, serviceArtifactSha256: "a".repeat(64)})).status, 409);
  assert.equal(store.emptyProof().recordCounts.quarantine, 1);
  assert.throws(() => store.ingest(JSON.stringify(fixture(0, "foreign"))), /UNIT_NOT_CURRENT/);
}));
test("transaction failure has no partial message/projection or receipt", () => withStore((store, db) => {
  db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON assessments BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => store.ingest(JSON.stringify(fixture())));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  db.exec("DROP TRIGGER reject_projection"); assert.equal(store.ingest(JSON.stringify(fixture())).status, 201);
}));
test("stable bounded cursor, independent product projections and function stale authority", () => withStore(store => {
  for (let i = 0; i < 4; i++) store.ingest(JSON.stringify(fixture(i)));
  const first = fixture(); first.assessmentId = "17847494-307d-5fb4-a96b-d9425a0e5093"; store.ingest(JSON.stringify(first));
  const page = store.query("test-unit", "assessments", {limit: 1}); assert.ok(page.nextCursor);
  first.assessmentId = "17847494-307d-5fb4-a96b-d9425a0e5094"; store.ingest(JSON.stringify(first));
  const second = store.query("test-unit", "assessments", {limit: 1, cursor: page.nextCursor}); assert.equal(second.nextCursor, null);
  assert.notEqual(page.items[0].message.assessmentId, second.items[0].message.assessmentId);
  assert.throws(() => store.query("production-unit", "assessments", {cursor: page.nextCursor}));
  const status = store.query("test-unit", "functionStatus").items[0]; assert.equal(status.authority, "FUNCTION_TEAM_REPORTED_STATUS"); assert.equal(status.stale, true);
  assert.equal(store.query("test-unit", "events").items.length, 1);
  assert.equal(store.query("test-unit", "advisories").items.length, 1);
}));
test("Test-only cleanup rejects arbitrary selectors, proves peer preservation, staleness and empty store", () => withStore(store => {
  assert.equal(store.emptyProof().state, "EMPTY");
  for (const bad of [[], ["test-unit", "test-unit"], ["foreign"], ["production-unit"]]) assert.throws(() => store.preview(bad));
  for (let i = 0; i < 4; i++) for (const uid of binding.systemUids) store.ingest(JSON.stringify(fixture(i, uid)));
  const p = store.preview(["test-unit"]), m = fixture(); m.serviceArtifactSha256 = "b".repeat(64); store.ingest(JSON.stringify(m));
  assert.throws(() => store.execute(["test-unit"], p.confirmationToken), /STALE_PREVIEW/);
  const p2 = store.preview(["test-unit"]), result = store.execute(["test-unit"], p2.confirmationToken);
  assert.equal(result.nonmatchingRecordSetSha256, p2.nonmatchingRecordSetSha256);
  assert.deepEqual(result.nonmatchingRecordCounts, p2.nonmatchingRecordCounts);
  assert.ok(Object.values(result.remainingRecordCounts).every(n => n === 0));
  assert.equal(store.emptyProof().state, "NONEMPTY");
  const all = store.preview(binding.systemUids); store.execute(binding.systemUids, all.confirmationToken); assert.equal(store.emptyProof().state, "EMPTY");
}));
test("unknown schema cannot produce empty proof; private proof works without Unit context", () => withStore((store, db) => {
  assert.throws(() => foundationProof(db));
  db.exec("CREATE TABLE unexpected(value TEXT)"); assert.throws(() => store.emptyProof());
}));
test("HTTP product/read scope, browser denial, private cleanup and post-retire context reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tire-http-product-"));
  const options = {databasePath: join(directory, "data.sqlite"), adminSocketPath: join(directory, "admin.sock"), contextPath: join(directory, "context.json")};
  let app;
  const request = async (path, init) => {const response = await fetch(`http://127.0.0.1:${app.port}${path}`, init); return {status: response.status, body: await response.json()};};
  try {
    app = await startBackend(options);
    const empty = await adminOperation("empty-proof", {schemaVersion: 1, contractVersion: "1.0.0"}, options.adminSocketPath); assert.equal(empty.body.state, "EMPTY");
    assert.equal((await request("/health/ready")).body.productIngestion, true);
    assert.equal((await request("/api/v1/tire/units/test-unit/assessments")).status, 503);
    writeFileSync(options.contextPath, JSON.stringify({schemaVersion: 1, contractVersion: "1.0.0", source: "CURRENT_RUN_PROVISIONING_JOURNAL", testUnit: {systemUid: "test-unit", unitRole: "VALIDATION", userFacingRole: "Test Vehicle"}}));
    const post = {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(fixture())};
    assert.equal((await request("/api/v1/tire/messages", {...post, headers: {...post.headers, origin: "http://localhost"}})).status, 403);
    // fetch includes sec-fetch-mode, intentionally denied as browser-like input.
    const {request: httpRequest} = await import("node:http");
    const accepted = await new Promise((done, reject) => {const r = httpRequest(`http://127.0.0.1:${app.port}/api/v1/tire/messages`, {method: "POST", headers: post.headers}, response => {response.resume(); response.on("end", () => done(response.statusCode));}); r.on("error", reject); r.end(post.body);});
    assert.equal(accepted, 201); assert.equal((await request("/api/v1/tire/units/test-unit/assessments")).body.items.length, 1);
    assert.equal((await request("/api/v1/tire/units/foreign/assessments")).status, 404);
    assert.equal((await request("/api/v1/tire/admin/storage/empty-proof", post)).status, 404);
    const preview = await adminOperation("preview", {schemaVersion: 1, contractVersion: "1.0.0", systemUids: ["test-unit"]}, options.adminSocketPath);
    const cleaned = await adminOperation("execute", {schemaVersion: 1, contractVersion: "1.0.0", systemUids: ["test-unit"], confirmationToken: preview.body.confirmationToken}, options.adminSocketPath);
    assert.equal(cleaned.body.state, "CLEANED"); rmSync(options.contextPath); assert.equal((await request("/health/context")).status, 503);
  } finally {if (app) await app.shutdown(); rmSync(directory, {recursive: true, force: true});}
});
