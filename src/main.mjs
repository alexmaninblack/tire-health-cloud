// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import { createServer, request } from "node:http";
import { chmodSync, rmSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readContext } from "./context.mjs";
import { foundationProof, openStore } from "./store.mjs";

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
  let database, reason = "DATABASE_UNAVAILABLE";
  try { database = openStore(options.databasePath); reason = "READY"; }
  catch (error) { reason = error.message === "UNKNOWN_NEWER_SCHEMA" ? "UNKNOWN_NEWER_SCHEMA" : "DATABASE_UNAVAILABLE"; }
  const readiness = () => {
    if (database) {
      try { foundationProof(database); }
      catch { database.close(); database = undefined; reason = "DATABASE_UNAVAILABLE"; }
    }
    return {ready: !!database, reason, schemaVersion: database ? 1 : null, scope: "FOUNDATION_ONLY", productIngestion: false};
  };
  const contextReadiness = () => {
    const systemUids = readContext(options.contextPath);
    return !readiness().ready ? {ready: false, reason: "TEMPORARILY_UNAVAILABLE", systemUids: []} : systemUids === null ?
      {ready: false, reason: "CURRENT_UNIT_CONTEXT_UNAVAILABLE", systemUids: []} : {ready: true, reason: "READY", systemUids};
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health/live") return json(res, 200, {status: "LIVE"});
    if (req.method === "GET" && path === "/health/ready") { const value = readiness(); return json(res, value.ready ? 200 : 503, value); }
    if (req.method === "GET" && path === "/health/context") { const value = contextReadiness(); return json(res, value.ready ? 200 : 503, value); }
    if (!path.startsWith("/api/v1/tire/") || path.includes("/admin/")) return error(res, 404, "NOT_FOUND");
    if (!readiness().ready) return error(res, 503, "TEMPORARILY_UNAVAILABLE");
    const scoped = /^\/api\/v1\/tire\/units\/([^/]+)\//.exec(path);
    if (scoped) {
      const context = contextReadiness();
      if (!context.ready) return error(res, 503, context.reason);
      let uid;
      try { uid = decodeURIComponent(scoped[1]); } catch { return error(res, 400, "INVALID_REQUEST"); }
      if (!context.systemUids.includes(uid)) return error(res, 404, "UNIT_NOT_CURRENT");
    }
    // No product messages or empty dashboards are fabricated by the lifecycle
    // foundation. This endpoint cannot acknowledge any submitted record.
    req.resume();
    return error(res, 501, "NOT_IMPLEMENTED");
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const admin = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/internal/foundation-proof") return error(res, 404, "NOT_FOUND");
    req.resume();
    try {
      if (!database) return error(res, 503, "TEMPORARILY_UNAVAILABLE");
      return json(res, 200, foundationProof(database));
    } catch { return error(res, 503, "FOUNDATION_PROOF_FAILED"); }
  });
  try {
    await listen(server, port, host);
    await listen(admin, options.adminSocketPath);
    chmodSync(options.adminSocketPath, 0o600);
  } catch (error) {
    if (server.listening) await close(server);
    if (admin.listening) await close(admin);
    database?.close();
    throw error;
  }
  let stopped = false;
  return {host, port: server.address().port, readiness, contextReadiness, shutdown: async () => {
    if (stopped) return;
    stopped = true;
    await close(server); await close(admin); database?.close(); database = undefined;
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
export async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--admin-operation" && args[1] === "foundation-proof") {
    const result = await inspectFoundation();
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status === 200 ? 0 : 1;
    return;
  }
  const app = await startBackend(optionsFromArguments(args));
  process.stdout.write("Tire Cloud lifecycle foundation started; product ingestion is not implemented\n");
  const stop = () => void app.shutdown().then(() => process.exit(0));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
