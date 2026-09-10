// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";

export function parseContext(text) {
  if (Buffer.byteLength(text) > 4096) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
  const value = JSON.parse(text);
  // JSON.parse owns syntax. Scan validated JSON tokens only to reject duplicate
  // keys (including escaped aliases) without a second product/JSON model.
  const objects = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") objects.push(new Set());
    else if (text[i] === "}") objects.pop();
    else if (text[i] === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? "x")) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, i + 1));
        if (objects.at(-1).has(key)) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
        objects.at(-1).add(key);
      }
    }
    if (objects.length > 8) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
  }
  const closed = (object, keys) => object !== null && typeof object === "object" && !Array.isArray(object) &&
    Object.keys(object).sort().join(",") === [...keys].sort().join(",");
  const keys = ["schemaVersion", "contractVersion", "source", "testUnit"];
  if (Object.hasOwn(value ?? {}, "productionUnit")) keys.push("productionUnit");
  if (!closed(value, keys) || value.schemaVersion !== 1 || value.contractVersion !== "1.0.0" || value.source !== "CURRENT_RUN_PROVISIONING_JOURNAL") {
    throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
  }
  const unit = (entry, role, label) => closed(entry, ["systemUid", "unitRole", "userFacingRole"]) &&
    typeof entry.systemUid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(entry.systemUid) && entry.unitRole === role && entry.userFacingRole === label;
  if (!unit(value.testUnit, "VALIDATION", "Test Vehicle") ||
      (keys.includes("productionUnit") && (!unit(value.productionUnit, "PRODUCTION", "Production Vehicle") || value.productionUnit.systemUid === value.testUnit.systemUid))) {
    throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
  }
  return [value.testUnit.systemUid, ...(value.productionUnit ? [value.productionUnit.systemUid] : [])].sort();
}

export function readContext(path) {
  if (!path) return null;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return null;
    return parseContext(readFileSync(descriptor, "utf8"));
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function readBinding(path) {
  if (!path) return null;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return null;
    const text = readFileSync(descriptor, "utf8");
    const systemUids = parseContext(text), value = JSON.parse(text);
    return {systemUids, testSystemUid: value.testUnit.systemUid, productionSystemUid: value.productionUnit?.systemUid};
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
