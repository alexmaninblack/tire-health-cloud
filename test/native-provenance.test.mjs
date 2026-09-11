// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync, mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {validateMessage, canonical} from "../src/protocol.mjs";
import {openStore, TireStore} from "../src/store.mjs";
const names = ["tire-health-assessment", "tire-health-event", "tire-advisory-fact", "tire-function-status"];
const categories = ["assessments", "events", "advisories", "functionStatus"];
function fixture(index, version = 2) {
  const value = JSON.parse(readFileSync(new URL(`./fixtures/${names[index]}${version === 2 ? ".v2" : ""}.valid.json`, import.meta.url)));
  delete value.$comment; return value;
}
const binding = {testSystemUid: fixture(0).unitSystemUid, systemUids: [fixture(0).unitSystemUid]};

test("all native Tire products accept the package release and reject invalid or fabricated provenance", () => {
  for (let index = 0; index < names.length; index++) {
    const original = fixture(index);
    assert.equal(validateMessage(JSON.stringify(original)).message.serviceVersion, "18.0.0");
    assert.equal(validateMessage(JSON.stringify(fixture(index, 1))).message.schemaVersion, 1);
    const mutations = [
      m => {delete m.serviceInstance;}, m => {m.serviceInstance = null;},
      m => {m.contractVersion = "1.0.0";}, m => {m.schemaVersion = 3;},
      m => {m.serviceArtifactSha256 = null;}, m => {m.serviceArtifactSha256 = "0".repeat(64);},
      m => {m.modelArtifactSha256 = "0".repeat(64);}, m => {delete m.unitRole;},
      m => {m.unitSystemUid = "x\n";}, m => {m.serviceInstance.extra = true;},
      ...["serviceId", "subjectId", "instanceId"].flatMap(key => [
        m => {delete m.serviceInstance[key];}, m => {m.serviceInstance[key] = "";},
        m => {m.serviceInstance[key] = "../x";}, m => {m.serviceInstance[key] = "x".repeat(129);},
        m => {m.serviceInstance[key] = "x\n";},
      ]),
      ...[-1, 0.1, "0", null, Number.MAX_SAFE_INTEGER + 1].map(value => m => {m.serviceInstance.instanceIndex = value;}),
      ...["01.0.0", "1.0", "1.0.0-dev", "1.0.0+build", "1.0.0\n", "1".repeat(33) + ".0.0"].map(value => m => {m.serviceVersion = value;}),
    ];
    for (const mutate of mutations) {const candidate = structuredClone(original); mutate(candidate); assert.throws(() => validateMessage(JSON.stringify(candidate)));}
  }
});

test("Tire keeps legacy and native bytes/receipts across reopen and rejects identity relabelling", () => {
  const directory = mkdtempSync(join(tmpdir(), "tire-native-provenance-")), path = join(directory, "fixture.sqlite");
  let db = openStore(path), store = new TireStore(db, () => binding);
  try {
    const before = [];
    for (let index = 0; index < names.length; index++) {
      const old = fixture(index, 1), current = fixture(index);
      // New logical events use new IDs, never a schema prefix in the stored key.
      const id = ["assessmentId", "eventId", "requestId", "statusId"][index];
      current[id] = "8c6e4a48-9561-5dd8-8036-8a842d92cee0";
      for (const message of [old, current]) {
        const receipt = store.ingest(JSON.stringify(message)); assert.equal(receipt.status, 201);
        before.push({message, receipt: receipt.body});
      }
    }
    const originalRows = db.prepare("SELECT * FROM messages ORDER BY id").all();
    db.close(); db = openStore(path); store = new TireStore(db, () => binding);
    for (const {message, receipt} of before) {
      const again = store.ingest(JSON.stringify(message));
      assert.equal(again.status, 200); assert.equal(again.body.receiptId, receipt.receiptId);
      assert.equal(again.body.receivedAt, receipt.receivedAt);
    }
    for (let index = 0; index < names.length; index++) {
      const page = store.query(binding.testSystemUid, categories[index]);
      assert.equal(page.schemaVersion, 2); assert.equal(page.contractVersion, "2.0.0");
      assert.deepEqual(page.items.map(item => item.message.schemaVersion), [2, 1]);
      const original = page.items[0].message;
      for (const key of ["serviceId", "subjectId", "instanceIndex", "instanceId"]) {
        const changed = structuredClone(original);
        changed.serviceInstance[key] = key === "instanceIndex" ? 1 : "different";
        assert.equal(store.ingest(JSON.stringify(changed)).status, 409);
      }
      assert.equal(canonical(store.query(binding.testSystemUid, categories[index]).items[0].message), canonical(original));
    }
    assert.deepEqual(db.prepare("SELECT * FROM messages ORDER BY id").all(), originalRows);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(store.ready(), true);
  } finally {db.close(); rmSync(directory, {recursive: true, force: true});}
});
