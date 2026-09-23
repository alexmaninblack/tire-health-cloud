<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tire Health Cloud

## Current evidence — 23 September 2026

The integration [working baseline](../aosedge-sdv-demo/docs/qualification/current-baseline.md)
records scoped staging proof of actual Tire product receipts, advisory facts,
independent Reset and offline/backlog delivery. Source revision `47cfa63`
participated in the 20 September UI checkpoint. Those are dated observations,
not proof of a running backend today, complete P8 or a calibrated Tire model.
The source-increment descriptions below are historical implementation context;
their original "not deployed" wording is superseded by those scoped receipts.

Independent Function Team 2 backend for D4-019. Product ingestion, durable
receipts, queries and private cleanup replace the foundation-only gate.
Source code alone does not qualify a deployment or calibrate the Tire model.
Brake identity, database and failure boundary are not shared.

The N3 consumer increment accepts legacy product revision 1 / 1.0.0 and native
revision 2 / 2.0.0 through separate closed schemas. Native messages identify
the package release and `serviceInstance` (`serviceId`, `subjectId`,
`instanceIndex`, `instanceId`); even the band-change event carries its own
identity. OCI digest fields are rejected, not fabricated. Reported identity
is correlation only, never authentication or Aos lifecycle authority.
Legacy messages, original receipts and outbox retries remain unchanged;
the existing canonical-message SQLite layout needs no migration.
Producer/input migration and real Test integration subsequently received the
scoped evidence above; the original local tests themselves deployed nothing.

## Public contract

The P3 consumer adds `TIRE_FUNCTION_OBSERVATION` revision 3 / 3.0.0 without
widening the four legacy product kinds. Its closed fields separate connection,
input, activity, delivery, advisory and a historical last-result reference.
Source generation/sequence determines order; receipt time cannot renew
freshness. These reports do not establish Cloud installation or authentication.
Backend source tests passed; live evidence is recorded separately above.

| Route | Meaning |
| --- | --- |
| `GET /health/live` | HTTP process answers |
| `GET /health/ready` | Known SQLite product schema/storage; `scope: TIRE_PRODUCT`, schema 4 |
| `GET /health/context` | Valid current binding, separate from process/storage health |
| `POST /api/v1/tire/messages` | One validated message, transaction committed before ACK |
| `GET /api/v1/tire/units/{systemUid}/assessments` | Assessment records |
| `GET /api/v1/tire/units/{systemUid}/events` | Band-change records |
| `GET /api/v1/tire/units/{systemUid}/advisories` | Advisory facts, not inferred driver receipt |
| `GET /api/v1/tire/units/{systemUid}/function-status` | Function-team reports, stale after 90 seconds |
| `GET /api/v1/tire/units/{systemUid}/function-observations` | V3 source-ordered heads per native binding, source age and visible conflicts |
| `GET /api/v1/tire/stream?systemUid=...` | SSE notification only; REST reread is authoritative |

Absent context returns `503 CURRENT_UNIT_CONTEXT_UNAVAILABLE`; foreign UID
returns `404 UNIT_NOT_CURRENT`. Valid scope with no records returns an empty
list. Browser-origin ingestion is forbidden; public admin and Brake paths
return 404. Unimplemented product endpoints, including CPU qualification
control, return `501 NOT_IMPLEMENTED`, never simulated success.

The four legacy kinds are `TIRE_HEALTH_ASSESSMENT`, `TIRE_CONDITION_BAND_CHANGED`,
`TIRE_ADVISORY_FACT` and `TIRE_FUNCTION_STATUS`. Packaged closed schemas are
snapshots of the Solution contracts, including bounded canonical `X.Y.Z`
release versions. Duplicate JSON keys, malformed UTF-8, unknown fields,
schema/digest errors and oversized messages fail without a receipt. Wire
maximum is 32 KiB; canonical maximum is 16 KiB, or 8 KiB for status. Optional
gzip does not change logical digest. Request timeout is 10 seconds, not an
intentional delay on successful requests.

New records return 201; identical retry returns 200 with original receipt/time:

```text
{schemaVersion:1, contractVersion:"1.0.0", receiptId,
 messageKeySha256, contentSha256,
 state:"DURABLE_ACCEPTED"|"DUPLICATE_ACCEPTED", receivedAt}
```

Key digest is SHA-256 of the RFC8785 D4-019 idempotency-key array. A same-key
changed envelope returns 409 and is quarantined. ACK proves durable storage
only, not Gateway application, driver acknowledgement or OEM approval.

Legacy product queries accept `limit` (1–100, default 50) and opaque `cursor`; unsupported or
duplicate parameters fail. Fixed highest-record boundary and descending order
make pagination stable and bound to UID/category. Result:

```text
{schemaVersion:2, contractVersion:"2.0.0", unitSystemUid,
 items:[{message, backendReceivedAt, deliveryState:"DURABLE_ACCEPTED"}],
 nextCursor:string|null}
```

Function-status items additionally contain
`authority:"FUNCTION_TEAM_REPORTED_STATUS"` and `stale:boolean`, never inferred
AosCore lifecycle state. SSE sends only `{"reread":true}` with at most 16 connections
and backpressure disconnect; it never replaces authoritative reads.

The new function-observations query accepts only `limit` (1–100, default 10),
not a cursor. It returns revision 3 / 3.0.0, resourceType FUNCTION_OBSERVATION,
unitSystemUid, items and truncated. Items include authority
FUNCTION_TEAM_REPORTED_OBSERVATION, stale, clockSkew and deliveryState.
The 8192-byte canonical bound and exact retry/conflict handling apply to the
new discriminator. Retain the newest 1024 full payloads per binding and compact
receipt/conflict identities until scoped cleanup. Consumers and cleanup
adapters must be activated before new observation producers.

## Storage and current context

Node 26.0.0 uses built-in HTTP/SQLite and no npm dependencies. SQLite uses WAL,
FULL synchronous, foreign keys and a 5000 ms busy timeout. Exact known foundation
schema 1 migrates to product schema 2, followed by reset schema 3 and additive
observation schema 4. Each migration validates its exact predecessor and is
transactional. Old canonical data and receipts are preserved. The ten record
categories are `messages`, `assessments`, `events`, `advisories`,
`functionStatus`, `quarantine`, `resetProducers`, `resetCommands`,
`functionObservations`, `functionObservationConflicts`. Ledger/schema/integrity are checked. Unknown
versions/objects fail closed without destructive reset or downgrade.

Demo Control atomically replaces its owned read-only context file:

```text
{schemaVersion:1, contractVersion:"1.0.0",
 source:"CURRENT_RUN_PROVISIONING_JOURNAL",
 testUnit:{systemUid, unitRole:"VALIDATION", userFacingRole:"Test Vehicle"},
 productionUnit?:{systemUid, unitRole:"PRODUCTION", userFacingRole:"Production Vehicle"}}
```

Actual UIDs come only from the current journal. Test is required; distinct
optional Production preserves engineering mode. Missing/malformed/duplicate-key
or oversized context has no usable scope. There is no last-known fallback.
Clearing context does not erase data. UID is correlation, not authenticated
identity: production authentication is outside the isolated first-demo contract.

## Private cleanup and whole-store proof

The source package declares
`aosedgeDemo.privateCleanupProtocol: "tire-product-v1"`. Demo Control must bind
this capability to the immutable built backend image; old foundation artifacts
cannot claim product cleanup. No live image was rebuilt in this checkpoint.

Only owned Unix socket `/tmp/demo-backend/admin.sock` exposes cleanup. Existing
entrypoint accepts `--admin-operation preview`, `execute`, `empty-proof`:
one JSON request on stdin, `{status,body}` on stdout. Tokens do not belong in
CLI arguments, logs or a public endpoint.

Every input has `{schemaVersion:1,contractVersion:"1.0.0"}`. Preview adds
`systemUids`; execute adds those UIDs and `confirmationToken`. Accept exact
current Test alone or all current-context UIDs. Reject empty, duplicate,
foreign or Production-only selectors. This implements the accepted Studio
Test-retirement amendment without deleting optional peer data. The retiring
Test binding must remain until cleanup is complete.

Preview body keys: `schemaVersion`, `systemUids`, `recordCounts`,
`recordSetSha256`, `nonmatchingRecordCounts`, `nonmatchingRecordSetSha256`,
`confirmationToken`, `expiresAt`. Token TTL is 60 seconds, with at most 16 in memory.
Any selected or nonmatching record-set change rejects stale execution.
Execute deletes in one transaction and returns:

```text
{schemaVersion:1, contractVersion:"1.0.0", state:"CLEANED", systemUids,
 deletedRecordCounts, remainingRecordCounts, nonmatchingRecordCounts,
 nonmatchingRecordSetSha256, completedAt}
```

Read-only whole-store proof needs no UID context:

```text
{schemaVersion:1, contractVersion:"1.0.0", databaseSchemaVersion:4,
 state:"EMPTY"|"NONEMPTY", recordCounts, observedAt}
```

All count objects have exactly the ten category keys above. Empty means ten
zero counts plus supported schema/integrity, not an opaque digest assumption.
After product migration, old `foundation-proof` fails closed. Product cleanup
and empty proof must precede any separately authorized owned-volume reset.
Cleanup never deletes volumes, VM overlays, Cloud Units/audit or Brake data.
Normal stop retains data.

## Container integration and source tests

Existing pinned Docker recipe is recorded by `container-build.json`, with
`imageId:null` until Demo Control builds it. Container inputs remain:

| Input | Value |
| --- | --- |
| Entrypoint | `node /app/src/main.mjs` |
| Container/network | `aosedge-demo-tire-cloud` / `aosedge-demo-tire-cloud-v1` |
| Volume | `aosedge_demo_tire_cloud_v1:/data` |
| Host publication | `127.0.0.1:18092:18092` |
| Database | `/data/tire-health.sqlite` |
| Context mount | Dedicated read-only directory at `/run/demo-control/context` |

Runtime arguments:

```text
--runtime-mode container --port 18092
--database-path /data/tire-health.sqlite
--admin-socket-path /tmp/demo-backend/admin.sock
--context-path /run/demo-control/context/current-unit-context.json
```

Nonroot `node` owns database/socket directories. Only container mode binds
internally to 0.0.0.0; native mode is loopback. Demo Control preserves separate
volumes/networks and loopback host publication, with no host-network,
Docker-socket or credential mount. Healthcheck is process/storage health:
Create can start before Provision. No dashboard on 18082 is served yet.

`node --test test/*.test.mjs` uses temporary databases and ephemeral loopback
ports, never Cloud/VM/Docker. Real container/guest-route, restart/cleanup,
LAN-negative isolation, dashboard and CPU-control qualification remain separate
acceptance through Demo Control.
