// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function strictJson(text, maximum = 32768) {
  if (Buffer.byteLength(text) > maximum) throw new Error("MESSAGE_TOO_LARGE");
  const value = JSON.parse(text), objects = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") objects.push(new Set());
    else if (text[i] === "}") objects.pop();
    else if (text[i] === '"') {
      const start = i++;
      for (; i < text.length; i++) {if (text[i] === "\\") i++; else if (text[i] === '"') break;}
      const token = JSON.parse(text.slice(start, i + 1));
      if (!token.isWellFormed()) throw new Error("INVALID_MESSAGE");
      let next = i + 1; while (/\s/.test(text[next] ?? "x")) next++;
      if (text[next] === ":") {
        if (objects.at(-1).has(token)) throw new Error("INVALID_MESSAGE");
        objects.at(-1).add(token);
      }
    }
    if (objects.length > 16) throw new Error("INVALID_MESSAGE");
  }
  return value;
}
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  throw new Error("INVALID_MESSAGE");
}
const schemas = Object.fromEntries([
  ["TIRE_HEALTH_ASSESSMENT", "tire-health-assessment"], ["TIRE_CONDITION_BAND_CHANGED", "tire-health-event"],
  ["TIRE_ADVISORY_FACT", "tire-advisory-fact"], ["TIRE_FUNCTION_STATUS", "tire-function-status"]
].map(([kind, name]) => [kind, JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url)))]));
function dateTime(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days[Number(month) - 1] &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
}
// Deliberately limited to the keywords in the packaged closed Tire schemas.
// No remote schemas, executable extensions or coercion are accepted.
function valid(schema, value, root = schema) {
  if (schema.$ref) return valid(schema.$ref.split("/").slice(1).reduce((o, k) => o[k], root), value, root);
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => valid(s, value, root)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(s => valid(s, value, root))) return false;
  if (schema.if && valid(schema.if, value, root) && schema.then && !valid(schema.then, value, root)) return false;
  if (schema.not && valid(schema.not, value, root)) return false;
  const type = schema.type;
  if (type === "null" && value !== null) return false;
  if (type === "integer" && !Number.isSafeInteger(value)) return false;
  if (type === "string" && typeof value !== "string") return false;
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return false;
  if (type === "array" && !Array.isArray(value)) return false;
  if (schema.required && (!value || !schema.required.every(k => Object.hasOwn(value, k)))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties ?? {}, k))) return false;
    if (schema.properties && !Object.entries(schema.properties).every(([k, s]) => !Object.hasOwn(value, k) || valid(s, value[k], root))) return false;
  }
  if (typeof value === "string") {
    if (!value.isWellFormed() || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uuid" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) return false;
    if (schema.format === "date-time" && !dateTime(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) ||
      (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) || (schema.items && !value.every(v => valid(schema.items, v, root))))) return false;
  return true;
}
export function validateMessage(bytes) {
  let message;
  try {message = strictJson(bytes);} catch (e) {throw new Error(e.message === "MESSAGE_TOO_LARGE" ? "MESSAGE_TOO_LARGE" : "INVALID_MESSAGE");}
  const schema = Object.hasOwn(schemas, message?.messageType) ? schemas[message.messageType] : undefined;
  if (!schema || !valid(schema, message) || digest(canonical(message.content)) !== message.contentSha256) throw new Error("INVALID_MESSAGE");
  const encoded = canonical(message);
  if (Buffer.byteLength(encoded) > (message.messageType === "TIRE_FUNCTION_STATUS" ? 8192 : 16384)) throw new Error("MESSAGE_TOO_LARGE");
  const id = message.assessmentId && message.messageType === "TIRE_HEALTH_ASSESSMENT" ? message.assessmentId : message.eventId ?? message.requestId ?? message.statusId;
  const key = [message.unitSystemUid, message.messageType, id];
  if (message.messageType === "TIRE_ADVISORY_FACT") key.push(message.gatewayState);
  return {message, canonical: encoded, key: digest(canonical(key)), messageDigest: digest(encoded)};
}
