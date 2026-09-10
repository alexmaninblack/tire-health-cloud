// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {parseContext} from "../src/context.mjs";
import {startBackend, optionsFromArguments, inspectFoundation} from "../src/main.mjs";

const context = uid => ({schemaVersion: 1, contractVersion: "1.0.0", source: "CURRENT_RUN_PROVISIONING_JOURNAL", testUnit: {systemUid: uid, unitRole: "VALIDATION", userFacingRole: "Test Vehicle"}});
const get = async (app, path, init) => {const r = await fetch(`http://127.0.0.1:${app.port}${path}`, init); return {status: r.status, body: await r.json()};};

test("strict Test context rejects duplicates, missing Test, unknown keys and invalid UIDs", () => {
  assert.deepEqual(parseContext(JSON.stringify(context("test-unit"))), ["test-unit"]);
  const dual = {...context("test-unit"), productionUnit: {systemUid: "production-unit", unitRole: "PRODUCTION", userFacingRole: "Production Vehicle"}};
  assert.deepEqual(parseContext(JSON.stringify(dual)), ["production-unit", "test-unit"]);
  for (const value of [null, [], {}, {...context("test-unit"), extra: 1}, {...context("bad/uid")}, {...context("test-unit"), productionUnit: null}, {...dual, testUnit: undefined}]) {
    assert.throws(() => parseContext(JSON.stringify(value)));
  }
  const text = JSON.stringify(context("test-unit"));
  assert.throws(() => parseContext(text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')));
  assert.throws(() => parseContext(text.replace('"systemUid":"test-unit"', '"systemUid":"test-unit","system\\u0055id":"another"')));
  assert.throws(() => parseContext(" ".repeat(4097)));
});

test("persistent first-create/restart and current-Test context rebinding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tire-backend-test-"));
  const options = {databasePath: join(directory, "data.sqlite"), adminSocketPath: join(directory, "admin.sock"), contextPath: join(directory, "context.json")};
  let app;
  try {
    app = await startBackend(options);
    await assert.rejects(startBackend(options), /already active/);
    assert.equal((await get(app, "/health/live")).status, 200);
    assert.equal(app.host, "127.0.0.1");
    assert.equal((await get(app, "/health/live")).status, 200);
    assert.equal((await get(app, "/health/ready")).body.productIngestion, true);
    assert.equal((await get(app, "/health/context")).status, 503);
    writeFileSync(options.contextPath, JSON.stringify(context("test-unit")));
    assert.deepEqual((await get(app, "/health/context")).body.systemUids, ["test-unit"]);
    assert.equal((await get(app, "/api/v1/tire/units/test-unit/assessments")).status, 200);
    assert.equal((await get(app, "/api/v1/tire/messages", {method: "POST", body: "{}"})).status, 403);
    assert.equal((await get(app, "/api/v1/brake/messages", {method: "POST", body: "{}"})).status, 404);
    assert.equal((await get(app, "/api/v1/tire/admin/current-run/cleanup", {method: "POST"})).status, 404);
    const proof = await inspectFoundation(options.adminSocketPath);
    assert.equal(proof.status, 503);
    assert.equal(proof.body.errorCode, "TEMPORARILY_UNAVAILABLE");
    writeFileSync(options.contextPath + ".next", JSON.stringify(context("new-test")));
    renameSync(options.contextPath + ".next", options.contextPath);
    assert.equal((await get(app, "/api/v1/tire/units/test-unit/assessments")).status, 404);
    assert.equal((await get(app, "/api/v1/tire/units/new-test/assessments")).status, 200);
    const database = new DatabaseSync(options.databasePath);
    const row = {...database.prepare("SELECT * FROM schema_version").get()}; database.close();
    await app.shutdown(); await app.shutdown();
    assert.equal(existsSync(options.databasePath), true);
    assert.equal(existsSync(options.adminSocketPath), false);
    app = await startBackend(options);
    const reopened = new DatabaseSync(options.databasePath);
    assert.deepEqual({...reopened.prepare("SELECT * FROM schema_version").get()}, row); reopened.close();
    assert.equal((await get(app, "/health/context")).body.ready, true);
    rmSync(options.contextPath);
    assert.equal((await get(app, "/health/context")).status, 503);
  } finally {if (app) await app.shutdown(); rmSync(directory, {recursive: true, force: true});}
});

test("unknown schema and unknown table deny readiness and foundation-only removal proof", async () => {
  for (const mutation of ["PRAGMA user_version=3", "CREATE TABLE product_data(value TEXT)"]) {
    const directory = mkdtempSync(join(tmpdir(), "tire-schema-test-"));
    const options = {databasePath: join(directory, "data.sqlite"), adminSocketPath: join(directory, "admin.sock")};
    let app;
    try {
      app = await startBackend(options); await app.shutdown();
      const database = new DatabaseSync(options.databasePath); database.exec(mutation); database.close();
      app = await startBackend(options);
      assert.equal((await get(app, "/health/live")).status, 200);
      assert.equal((await get(app, "/health/ready")).status, 503);
      assert.equal((await inspectFoundation(options.adminSocketPath)).status, 503);
      const observed = new DatabaseSync(options.databasePath);
      if (mutation.includes("CREATE")) assert.ok(observed.prepare("SELECT name FROM sqlite_schema WHERE name='product_data'").get());
      else assert.equal(observed.prepare("PRAGMA user_version").get().user_version, 3);
      observed.close();
    } finally {if (app) await app.shutdown(); rmSync(directory, {recursive: true, force: true});}
  }
});

test("explicit container mode and recipe keep host-publication ownership in Demo Control", async () => {
  assert.throws(() => optionsFromArguments(["--host", "0.0.0.0"]));
  assert.throws(() => optionsFromArguments(["--runtime-mode", "container"]));
  await assert.rejects(startBackend({host: "0.0.0.0"}));
  const args = ["--runtime-mode", "container", "--port", "18092", "--database-path", "/data/tire-health.sqlite", "--admin-socket-path", "/tmp/demo-backend/admin.sock", "--context-path", "/run/demo-control/context/current-unit-context.json"];
  assert.equal(optionsFromArguments(args).runtimeMode, "container");
  const recipe = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(recipe, /FROM node:26\.0\.0-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(recipe, /USER node/);
  assert.match(recipe, /\/health\/ready/);
  assert.doesNotMatch(recipe, /\/health\/context/);
  const manifest = JSON.parse(readFileSync(new URL("../container-build.json", import.meta.url)));
  assert.equal(manifest.hostPublication, "127.0.0.1:18092:18092");
  assert.equal(manifest.productIngestion, true);
});
