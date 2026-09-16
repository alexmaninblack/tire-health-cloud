// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {mkdtempSync, writeFileSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startBackend} from "../src/main.mjs";
import {DemoResetStore, resetSchema} from "../src/demo-reset.ts";
// Reset persistence tests intentionally share the production protocol shape.
test("reset completion requires matching CLEAR; ACK and creation survive restart without repeating", () => {
  const directory = mkdtempSync(join(tmpdir(),"reset-recovery-"));
  const path = join(directory,"state.sqlite");
  let now = Date.parse("2026-09-16T12:00:00.000Z");
  let db = new DatabaseSync(path);
  for(const sql of resetSchema) db.exec(sql);
  let store = new DemoResetStore(db, () => "current-test", () => now);
  const create = {schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()};
  try {
    store.poll(binding); store.create(create);
    const request = {schemaVersion:1,requestId:randomUUID(),producerEpoch:binding.producerEpoch,sequence:9,
      operation:"CLEAR",reasonCode:"CONDITION_CLEARED",decisionId:create.commandId,
      serviceVersion:binding.serviceVersion,modelVersion:"demo-model-v1",
      issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString()};
    const status = {schemaVersion:1,requestId:request.requestId,producerEpoch:request.producerEpoch,
      sequence:request.sequence,state:"CLEARED",reason:"NONE",gatewayObservedAt:new Date(now+100).toISOString(),
      activeRecommendation:"NONE",activeReasonCode:"NONE",activeUntil:null};
    const ack = {...binding,commandId:create.commandId,result:"CLEARED",clearRequest:request,gatewayStatus:status};
    now += 500;
    for(const mutate of [
      x => {x.gatewayStatus.requestId=randomUUID();},
      x => {x.gatewayStatus.state="RECEIVED";},
      x => {x.gatewayStatus.reason="INTERNAL_ERROR";},
      x => {x.gatewayStatus.activeRecommendation="TIRE_INSPECTION_RECOMMENDED";},
      x => {x.clearRequest.recommendation="TIRE_INSPECTION_RECOMMENDED";},
      x => {x.clearRequest.issuedAt="2026-09-16T11:59:59.000Z";},
      x => {x.gatewayStatus.gatewayObservedAt="2026-09-16T12:01:00.000Z";},
      x => {x.gatewayStatus.extra=true;},
      x => {x.clearRequest.schemaVersion=2;}
    ]) {const wrong=structuredClone(ack);mutate(wrong);assert.throws(()=>store.acknowledge(wrong),/CLEAR_NOT_CONFIRMED/);}
    assert.equal(store.status("current-test").command.state,"PENDING");
    db.close(); db = new DatabaseSync(path);
    store = new DemoResetStore(db, () => "current-test", () => now);
    assert.equal(store.create(create).command.commandId,create.commandId);
    assert.equal(store.poll(binding).command.commandId,create.commandId);
    now += 61000;
    const before = db.prepare("SELECT state FROM demo_reset_commands").get().state;
    assert.equal(store.status("current-test").command.state,"EXPIRED");
    assert.equal(db.prepare("SELECT state FROM demo_reset_commands").get().state,before,"GET must not mutate");
    assert.equal(store.poll(binding).command,null,"expired command is never delivered for new execution");
    assert.equal(store.acknowledge(ack).state,"CLEARED","late proof reconciles a CLEAR issued before expiry");
    assert.deepEqual(store.acknowledge(ack),{schemaVersion:1,commandId:create.commandId,state:"CLEARED"});
    assert.throws(()=>store.acknowledge({...ack,result:"FAILED",clearRequest:null,gatewayStatus:null}),/ACK_CONFLICT/);
    assert.equal(store.poll(binding).command,null,"completed command is never delivered again");
    assert.equal(store.create(create).command.state,"CLEARED");
    db.close();db = new DatabaseSync(path);
    assert.equal(new DemoResetStore(db, () => "current-test", () => now).status("current-test").command.state,"CLEARED");
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test("command history is bounded, fresh binding is required and foreign Unit cannot inspect it", () => {
  const db = new DatabaseSync(":memory:");
  for(const sql of resetSchema) db.exec(sql);
  let now = Date.parse("2026-09-16T12:00:00Z");
  const store = new DemoResetStore(db, () => "current-test", () => now);
  try {
    for(let i=0;i<40;i++){
      store.poll(binding);
      const commandId=randomUUID();
      store.create({schemaVersion:1,unitSystemUid:"current-test",commandId});
      store.acknowledge({...binding,commandId,result:"FAILED",clearRequest:null,gatewayStatus:null});
      now++;
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM demo_reset_commands").get().n,32);
    assert.throws(()=>store.status("production"),/UNIT_NOT_CURRENT/);
    now+=16000;
    assert.throws(()=>store.create({schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()}),/NOT_CONNECTED/);
    assert.throws(()=>store.poll({...binding,serviceInstance:{...binding.serviceInstance,extra:true}}),/INVALID_REQUEST/);
  } finally {db.close();}
});

const binding = {schemaVersion:1, unitSystemUid:"current-test", serviceVersion:"30.0.0",
  serviceInstance:{serviceId:"3b9c49a1-25b3-4adf-bb07-bc12bc40d241",subjectId:"tire-subject",instanceIndex:0,instanceId:"native-instance"},
  producerEpoch:"250cd5eb-7c24-4347-8006-a22c79cf9ff7"};
test("reset storage: current Test only, fresh producer, idempotent creation, exact binding and expiry", () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of resetSchema) db.exec(sql);
  let now = Date.parse("2026-09-16T12:00:00Z");
  const store = new DemoResetStore(db, () => "current-test", () => now);
  const create = {schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()};
  try {
    assert.throws(() => store.create(create), /NOT_CONNECTED/);
    assert.throws(() => store.poll({...binding,unitSystemUid:"production"}), /UNIT_NOT_CURRENT/);
    assert.equal(store.poll(binding).command,null);
    const result = store.create(create);
    assert.equal(result.command.state,"PENDING");
    assert.deepEqual(store.create(create),result);
    assert.throws(() => store.create({...create,commandId:randomUUID()}), /ALREADY_PENDING/);
    assert.equal(store.poll({...binding,producerEpoch:randomUUID()}).command,null);
    const command = store.poll(binding).command;
    assert.equal(command.commandId,create.commandId);
    assert.throws(() => store.acknowledge({...binding,commandId:create.commandId,result:"CLEARED",clearRequest:{},gatewayStatus:{}}), /CLEAR_NOT_CONFIRMED/);
    now += 61000;
    assert.equal(store.poll(binding).command,null);
    assert.equal(store.status("current-test").command.state,"EXPIRED");
  } finally {db.close();}
});

test("existing network boundary: reset creation is not on public TCP; admin is an owner-only Unix socket", async () => {
  const directory = mkdtempSync(join(tmpdir(),"tire-reset-boundary-"));
  const contextPath = join(directory,"context.json");
  writeFileSync(contextPath,JSON.stringify({schemaVersion:1,contractVersion:"1.0.0",source:"CURRENT_RUN_PROVISIONING_JOURNAL",
    testUnit:{systemUid:"current-test",unitRole:"VALIDATION",userFacingRole:"Test Vehicle"}}));
  let app;
  try {
    const socket = join(directory,"admin.sock");
    app = await startBackend({databasePath:join(directory,"data.sqlite"),adminSocketPath:socket,contextPath});
    assert.equal(app.readiness().ready,true);
    assert.equal(statSync(socket).isSocket(),true);
    assert.equal(statSync(socket).mode & 0o777,0o600);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/v1/tire/admin/demo-reset`, {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()})});
    assert.equal(response.status,404);
  } finally {await app?.shutdown();rmSync(directory,{recursive:true,force:true});}
});
