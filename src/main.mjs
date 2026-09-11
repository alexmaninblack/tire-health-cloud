// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import { createServer, request } from "node:http";
import { chmodSync, rmSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readContext, readBinding } from "./context.mjs";
import { foundationProof, openStore, TireStore } from "./store.mjs";
import {strictJson} from "./protocol.mjs";
import {gunzipSync} from "node:zlib";

export const LOOPBACK_HOST = "127.0.0.1";
export const CONTAINER_HOST = "0.0.0.0";
export const ADMIN_SOCKET = "/tmp/demo-backend/admin.sock";

export function optionsFromArguments(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!["--runtime-mode", "--port", "--database-path", "--admin-socket-path", "--context-path"].includes(name) || values.has(name) || !value || value.startsWith("--")) throw new TypeError("invalid backend arguments");
    values.set(name, value);
  }
  const runtimeMode = values.get("--runtime-mode") ?? "native";
  const portText = values.get("--port") ?? "4301";
  if (!["native", "container"].includes(runtimeMode) || !/^[0-9]+$/.test(portText) || Number(portText) > 65535) throw new TypeError("invalid backend mode or port");
  if (!values.has("--database-path") || !values.has("--admin-socket-path") || (runtimeMode === "container" && !values.has("--context-path"))) throw new TypeError("owned database, admin and container context paths are required");
  return {runtimeMode, port: Number(portText), databasePath: resolve(values.get("--database-path")), adminSocketPath: resolve(values.get("--admin-socket-path")), contextPath: values.has("--context-path") ? resolve(values.get("--context-path")) : undefined};
}

function json(response, status, body) {
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  response.end(JSON.stringify(body));
}
function error(response, status, code) {
  json(response, status, {schemaVersion: 1, contractVersion: "1.0.0", errorCode: code, retryable: status === 503});
}
function failure(response, reason) {
  const known = {INVALID_MESSAGE: 422, MESSAGE_TOO_LARGE: 413, UNIT_NOT_CURRENT: 404, CURRENT_UNIT_CONTEXT_UNAVAILABLE: 503, INVALID_REQUEST: 400, INVALID_SELECTOR: 400, INVALID_PREVIEW: 409, STALE_PREVIEW: 409};
  error(response, known[reason] ?? 503, Object.hasOwn(known, reason) ? reason : "TEMPORARILY_UNAVAILABLE");
}
async function body(req, maximum = 32768) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("INVALID_REQUEST");
  const chunks = []; let size = 0;
  for await (const chunk of req) {size += chunk.length; if (size > maximum) throw new Error("MESSAGE_TOO_LARGE"); chunks.push(chunk);}
  let bytes = Buffer.concat(chunks);
  if (req.headers["content-encoding"] === "gzip") {try {bytes = gunzipSync(bytes, {maxOutputLength: maximum});} catch (e) {throw new Error(e.code === "ERR_BUFFER_TOO_LARGE" ? "MESSAGE_TOO_LARGE" : "INVALID_MESSAGE");}}
  else if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new Error("INVALID_REQUEST");
  try {return new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {throw new Error("INVALID_MESSAGE");}
}
function listen(server, ...args) {
  return new Promise((ready, reject) => { server.once("error", reject); server.listen(...args, () => {server.off("error", reject); ready();}); });
}
function close(server) {
  server.closeAllConnections();
  return new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}

async function prepareAdminSocket(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error("admin socket path is not an owned socket");
  // Only a proven stale socket is reclaimed after process loss. Never unlink
  // another live instance or replace an unexpected regular file.
  await new Promise((stale, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {probe.destroy(); reject(new Error("admin socket already active"));});
    probe.once("error", error => error.code === "ECONNREFUSED" ? stale() : reject(error));
    probe.setTimeout(500, () => {probe.destroy(); reject(new Error("admin socket state is uncertain"));});
  });
  rmSync(path);
}

export async function startBackend(options) {
  const runtimeMode = options.runtimeMode ?? "native";
  if (!["native", "container"].includes(runtimeMode) || (options.host !== undefined && options.host !== LOOPBACK_HOST)) throw new TypeError("invalid backend runtime mode or host");
  if (!options.databasePath || !options.adminSocketPath) throw new TypeError("owned persistent paths are required");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("invalid backend port");
  const host = runtimeMode === "container" ? CONTAINER_HOST : LOOPBACK_HOST;
  await prepareAdminSocket(options.adminSocketPath);
  let database, store, reason = "DATABASE_UNAVAILABLE";
  try { database = openStore(options.databasePath); store = new TireStore(database, () => readBinding(options.contextPath)); reason = "READY"; }
  catch (error) { reason = error.message === "UNKNOWN_NEWER_SCHEMA" ? "UNKNOWN_NEWER_SCHEMA" : "DATABASE_UNAVAILABLE"; }
  let mockDatabase, mockStore;
  try {
    if (database) {
      mockDatabase = openStore(options.databasePath + ".demo-mock");
      mockStore = new TireStore(mockDatabase, () => {
        const binding = readBinding(options.contextPath);
        return binding ? {...binding, systemUids: [binding.testSystemUid]} : null;
      });
    }
  } catch { mockDatabase?.close(); mockDatabase = undefined; }
  const readiness = () => {
    if (database) {
      try { store.ready(); }
      catch { database.close(); database = undefined; reason = "DATABASE_UNAVAILABLE"; }
    }
    return {ready: !!database, reason, schemaVersion: database ? 2 : null, scope: "TIRE_PRODUCT", productIngestion: !!database};
  };
  const contextReadiness = () => {
    const systemUids = readContext(options.contextPath);
    return !readiness().ready ? {ready: false, reason: "TEMPORARILY_UNAVAILABLE", systemUids: []} : systemUids === null ?
      {ready: false, reason: "CURRENT_UNIT_CONTEXT_UNAVAILABLE", systemUids: []} : {ready: true, reason: "READY", systemUids};
  };
  const streams = new Map();
  const server = createServer(async (req, res) => {
   try {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health/live") return json(res, 200, {status: "LIVE"});
    if (req.method === "GET" && path === "/health/ready") { const value = readiness(); return json(res, value.ready ? 200 : 503, value); }
    if (req.method === "GET" && path === "/health/context") { const value = contextReadiness(); return json(res, value.ready ? 200 : 503, value); }
    if (path.startsWith("/api/v1/tire/demo-mock/")) {
      res.setHeader("x-aos-demo-source", "MOCK");
      if (!mockDatabase || !mockStore) return error(res, 503, "MOCK_STORAGE_UNAVAILABLE");
      const binding = readBinding(options.contextPath);
      if (!binding) return error(res, 503, "CURRENT_UNIT_CONTEXT_UNAVAILABLE");
      if (req.method === "POST" && path === "/api/v1/tire/demo-mock/messages") {
        if (req.headers["x-aos-demo-source"] !== "MOCK" || req.headers.origin !== undefined || req.headers["sec-fetch-mode"] !== undefined) return error(res, 403, "EXPLICIT_SERVICE_MOCK_REQUIRED");
        const result = mockStore.ingest(await body(req)); return json(res, result.status, result.body);
      }
      if (req.method === "GET" && path === "/api/v1/tire/demo-mock/summary") {
        const uid = binding.testSystemUid;
        return json(res, 200, {source: "DEMO_MOCK", vehicleTelemetry: false, unitSystemUid: uid,
          counts: mockDatabase.prepare("SELECT kind, count(*) AS count FROM messages WHERE system_uid=? GROUP BY kind ORDER BY kind").all(uid),
          records: mockDatabase.prepare("SELECT canonical, received_at FROM messages WHERE system_uid=? ORDER BY id DESC LIMIT 3").all(uid).map(row => ({message: JSON.parse(row.canonical), backendReceivedAt: row.received_at}))});
      }
      return error(res, 404, "NOT_FOUND");
    }
    if (req.headers["x-aos-demo-source"] !== undefined) return error(res, 403, "MOCK_DATA_CANNOT_ENTER_LIVE_INGESTION");
    if (!path.startsWith("/api/v1/tire/") || path.includes("/admin/")) return error(res, 404, "NOT_FOUND");
    if (!readiness().ready) return error(res, 503, "TEMPORARILY_UNAVAILABLE");
    const scoped = /^\/api\/v1\/tire\/units\/([^/]+)\/(assessments|events|advisories|function-status)$/.exec(path);
    if (scoped) {
      const context = contextReadiness();
      if (!context.ready) return error(res, 503, context.reason);
      let uid;
      try { uid = decodeURIComponent(scoped[1]); } catch { return error(res, 400, "INVALID_REQUEST"); }
      if (!context.systemUids.includes(uid)) return error(res, 404, "UNIT_NOT_CURRENT");
      if (req.method !== "GET") return error(res, 405, "METHOD_NOT_ALLOWED");
      const params = new URL(req.url, "http://localhost").searchParams;
      if ([...params.keys()].some(k => !["cursor", "limit"].includes(k)) || [...params.keys()].some(k => params.getAll(k).length !== 1)) throw new Error("INVALID_REQUEST");
      return json(res, 200, store.query(uid, scoped[2] === "function-status" ? "functionStatus" : scoped[2], {limit: params.has("limit") ? Number(params.get("limit")) : 50, cursor: params.get("cursor")}));
    }
    if (req.method === "POST" && path === "/api/v1/tire/messages") {
      if (req.headers.origin !== undefined || req.headers["sec-fetch-mode"] !== undefined) return error(res, 403, "BROWSER_INGESTION_FORBIDDEN");
      const result = store.ingest(await body(req));
      json(res, result.status, result.body);
      if (result.status === 201) for (const [stream, uid] of streams) {
        if (uid !== result.systemUid) continue;
        if (!contextReadiness().systemUids.includes(uid) || !stream.write("event: changed\ndata: {\"reread\":true}\n\n")) {stream.end(); streams.delete(stream);}
      }
      return;
    }
    if (req.method === "GET" && path === "/api/v1/tire/stream") {
      const params = new URL(req.url, "http://localhost").searchParams, uid = params.get("systemUid"), context = contextReadiness();
      if (!context.ready) return error(res, 503, context.reason);
      if ([...params.keys()].join() !== "systemUid" || !context.systemUids.includes(uid)) return error(res, 404, "UNIT_NOT_CURRENT");
      if (streams.size >= 16) return error(res, 503, "TEMPORARILY_UNAVAILABLE");
      res.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-store"});
      res.write("event: reread\ndata: {\"reread\":true}\n\n"); streams.set(res, uid);
      req.once("close", () => streams.delete(res)); return;
    }
    req.resume();
    return error(res, 501, "NOT_IMPLEMENTED");
   } catch (e) {if (!res.headersSent) failure(res, e.message); else res.end();}
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const admin = createServer(async (req, res) => {
    if (req.method !== "POST") return error(res, 404, "NOT_FOUND");
    try {
      if (!database) return error(res, 503, "TEMPORARILY_UNAVAILABLE");
      if (req.url === "/internal/foundation-proof") {req.resume(); return json(res, 200, foundationProof(database));}
      const mock = req.url?.startsWith("/api/v1/tire/demo-mock/admin/");
      const adminStore = mock ? mockStore : store;
      if (!adminStore) return error(res, 503, "MOCK_STORAGE_UNAVAILABLE");
      const path = mock ? req.url.replace("/demo-mock/", "/") : req.url;
      const value = strictJson(await body(req, 4096), 4096);
      const keys = path === "/api/v1/tire/admin/storage/empty-proof" ? ["schemaVersion", "contractVersion"] : path?.endsWith("cleanup-preview") ? ["schemaVersion", "contractVersion", "systemUids"] : ["schemaVersion", "contractVersion", "systemUids", "confirmationToken"];
      if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.schemaVersion !== 1 || value.contractVersion !== "1.0.0") throw new Error("INVALID_REQUEST");
      if (path === "/api/v1/tire/admin/storage/empty-proof") return json(res, 200, adminStore.emptyProof());
      if (path === "/api/v1/tire/admin/current-run/cleanup-preview") return json(res, 200, adminStore.preview(value.systemUids));
      if (path === "/api/v1/tire/admin/current-run/cleanup") return json(res, 200, adminStore.execute(value.systemUids, value.confirmationToken));
      return error(res, 404, "NOT_FOUND");
    } catch (e) {return failure(res, e.message);}
  });
  try {
    await listen(server, port, host);
    await listen(admin, options.adminSocketPath);
    chmodSync(options.adminSocketPath, 0o600);
  } catch (error) {
    if (server.listening) await close(server);
    if (admin.listening) await close(admin);
    database?.close(); mockDatabase?.close();
    throw error;
  }
  let stopped = false;
  return {host, port: server.address().port, readiness, contextReadiness, shutdown: async () => {
    if (stopped) return;
    stopped = true;
    await close(server); await close(admin); database?.close(); database = undefined; mockDatabase?.close(); mockDatabase = undefined;
    rmSync(options.adminSocketPath, {force: true});
  }};
}

export function inspectFoundation(socketPath = ADMIN_SOCKET) {
  return new Promise((done, reject) => {
    const call = request({socketPath, path: "/internal/foundation-proof", method: "POST"}, response => {
      let bytes = "";
      response.on("data", chunk => {bytes += chunk; if (Buffer.byteLength(bytes) > 4096) call.destroy(new Error("proof response too large"));});
      response.on("error", reject);
      response.on("end", () => {try { done({status: response.statusCode, body: JSON.parse(bytes)}); } catch {reject(new Error("invalid foundation proof"));}});
    });
    call.setTimeout(10000, () => call.destroy(new Error("proof timed out")));
    call.on("error", reject); call.end();
  });
}
export function adminOperation(operation, input, socketPath = ADMIN_SOCKET) {
  const mocked = operation.startsWith("mock-");
  if (mocked) operation = operation.slice(5);
  const routes = {preview: "/api/v1/tire/admin/current-run/cleanup-preview", execute: "/api/v1/tire/admin/current-run/cleanup", "empty-proof": "/api/v1/tire/admin/storage/empty-proof"};
  if (!Object.hasOwn(routes, operation)) throw new Error("invalid admin operation");
  return new Promise((done, reject) => {
    const bytes = JSON.stringify(input);
    const path = mocked ? routes[operation].replace("/tire/admin/", "/tire/demo-mock/admin/") : routes[operation];
    const call = request({socketPath, path, method: "POST", headers: {"content-type": "application/json", "content-length": Buffer.byteLength(bytes)}}, response => {
      let text = "";
      response.on("data", chunk => {text += chunk; if (Buffer.byteLength(text) > 8192) call.destroy(new Error("invalid admin response"));});
      response.on("error", reject); response.on("end", () => {try {done({status: response.statusCode, body: strictJson(text, 8192)});} catch {reject(new Error("invalid admin response"));}});
    });
    call.setTimeout(10000, () => call.destroy(new Error("admin operation timed out"))); call.on("error", reject); call.end(bytes);
  });
}
export async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--admin-operation" && ["preview", "execute", "empty-proof", "mock-preview", "mock-execute", "mock-empty-proof"].includes(args[1])) {
    let text = ""; for await (const chunk of process.stdin) {text += chunk; if (Buffer.byteLength(text) > 4096) throw new Error("invalid admin request");}
    const result = await adminOperation(args[1], strictJson(text, 4096));
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.status === 200 ? 0 : 1; return;
  }
  if (args.length === 2 && args[0] === "--admin-operation" && args[1] === "foundation-proof") {
    const result = await inspectFoundation();
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status === 200 ? 0 : 1;
    return;
  }
  const app = await startBackend(optionsFromArguments(args));
  process.stdout.write("Tire Cloud process started\n");
  const stop = () => void app.shutdown().then(() => process.exit(0));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
