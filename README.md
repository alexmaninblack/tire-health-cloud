<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tire Health Cloud

Independent Tire backend with durable products, receipts, history and service-scoped reset; it does not share Brake storage.
<a id="sdv-lab-entry"></a>

For the **complete vehicle demo**, use the
[SDV Lab README](https://github.com/alexmaninblack/aosedge-sdv-demo); its build prepares this component automatically.
The standalone path below serves only this backend on loopback and does not
provision a Unit, sign/publish packages or simulate incoming vehicle records.

## 1 Prepare macOS and the pinned Node toolchain

Run blocks in order in a native Apple Silicon Terminal; stop on error.
This revised walkthrough has not been executed during the documentation update.
It is a component-only check, not a vehicle deployment.

```sh
uname -m
printf 'Mounted external APFS volume (for example /Volumes/BUILD): '
read -r SDV_VOLUME
diskutil info "$SDV_VOLUME"
df -h "$SDV_VOLUME"
```

Expect `arm64` and an already mounted external APFS volume. Do not create a
missing mount directory. After confirming the volume:

```sh
SDV_WORK="$SDV_VOLUME/sdv-components"
mkdir -p "$SDV_WORK/tools" "$SDV_VOLUME/tmp"
export TMPDIR="$SDV_VOLUME/tmp"
export npm_config_cache="$SDV_WORK/cache/npm"
git --version
```

If Git is missing, use `xcode-select --install` and complete Apple's dialog.
Use Node **26.0.0** and npm **11.12.1**, not a floating latest version.
If both exact tools already exist, skip download/extraction and verify them
below. Otherwise obtain the official macOS ARM64 distribution:

```sh
mkdir -p "$SDV_WORK/tools/node-download"
cd "$SDV_WORK/tools/node-download"
curl --fail --location --remote-name https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz
curl --fail --location --remote-name https://nodejs.org/dist/v26.0.0/SHASUMS256.txt
test "$(shasum -a 256 node-v26.0.0-darwin-arm64.tar.gz | cut -d ' ' -f 1)" = "$(awk '$2 == "node-v26.0.0-darwin-arm64.tar.gz" {print $1}' SHASUMS256.txt)" && printf 'Checksum matches\n'
```

Continue only after `Checksum matches`; extract once, not over an existing
installation:

```sh
test ! -e "$SDV_WORK/tools/node-v26.0.0-darwin-arm64" && tar -xzf node-v26.0.0-darwin-arm64.tar.gz -C "$SDV_WORK/tools"
export PATH="$SDV_WORK/tools/node-v26.0.0-darwin-arm64/bin:$PATH"
```

For both an existing and a newly extracted installation:

```sh
node --version
node -p 'process.arch'
npm --version
```

Expect `v26.0.0`, `arm64`, `11.12.1`. The
[Node archive](https://nodejs.org/en/download/archive/v26.0.0) owns these
downloads. Use a short SSD volume name: macOS Unix sockets have path limits.

## 2 Clone this component

```sh
git clone --branch main https://github.com/alexmaninblack/tire-health-cloud.git "$SDV_WORK/tire-health-cloud"
cd "$SDV_WORK/tire-health-cloud"
git rev-parse HEAD
```

Record that revision with results. `main` is component development; complete
candidate reproduction instead uses the product repository's frozen pins.

## 3 Prepare and check the component

There are **no npm dependencies and no compilation step**. Node's built-in
HTTP/SQLite and TypeScript handling run the source directly:

```sh
node --test test/*.test.mjs
```

Expect the tests to pass. They use temporary databases/local sockets, not
Cloud, a VM or Docker. No Tire web dashboard is served by this repository.

## 4 Start a separate local backend

Do not run this over an integrated demo backend. The example uses port
**18492**, separate from the normal integrated port. If that port is occupied,
stop here; do not kill another owner. Create a fresh, private, short data path:

```sh
umask 077
SDV_RUN="$(mktemp -d "$SDV_VOLUME/tmp/tire.XXXXXX")"
printf 'Local data: %s\n' "$SDV_RUN"
node src/main.mjs --port 18492 \
  --database-path "$SDV_RUN/data.sqlite" \
  --admin-socket-path "$SDV_RUN/admin.sock"
```

Leave that terminal running. In a **second Terminal**:

```sh
curl --fail --silent --show-error http://127.0.0.1:18492/health/live
curl --fail --silent --show-error http://127.0.0.1:18492/health/ready
curl --silent --show-error --include http://127.0.0.1:18492/health/context
```

Expect `LIVE`, storage `ready: true` / schema 4, and **HTTP 503 /
CURRENT_UNIT_CONTEXT_UNAVAILABLE** for context. That last result is expected:
no vehicle has been provisioned/bound in this standalone check. Do not invent a
Unit UID or mark context ready to make the screen green. Real context and
container lifecycle belong to Demo Control.

## 5 Stop and retain the data

Press **Ctrl-C in the first Terminal**, then check from the second:

```sh
lsof -nP -iTCP:18492 -sTCP:LISTEN
```

No output (normally exit status 1) means no listener remains on that port.
The private data directory is retained; stopping is not reset or deletion.
For an installed demo, use its owner to stop only the relevant containers;
leave Docker Engine and unrelated workloads running.

## Component documentation

- [Advisory integration](docs/advisory-demo-control.md)
- [License](LICENSE) and [notices](NOTICE)

## Implementation reference and dated evidence

The details below preserve protocols and historical qualification scope.
They are not additional first-use steps; destructive admin examples belong
to the explicit integration owner, not the standalone startup above.

<details>
<summary>Expand protocols, container integration and dated evidence</summary>

For the implemented Test-only private cleanup wire, see the
[as-built protocol](https://github.com/alexmaninblack/aosedge-sdv-demo/blob/5e30b410cbeadd2f73063b1bd313253aff612595/contracts/tire-cloud-api/studio-current-wire.md).
The older Solution JSON profile/preview schema still describe two UIDs and
fewer counters; that executable-contract drift remains explicit maintenance
work. This README describes the current handler, not proof that those old
schemas accept its responses.

## Current evidence — 7 October 2026

The [current integration baseline](https://github.com/alexmaninblack/aosedge-sdv-demo/blob/5e30b410cbeadd2f73063b1bd313253aff612595/docs/qualification/current-baseline.md)
records Kit028 / Setup042 / Factory .41: Tire60/V1 products/advisory,
independent Reset/history, offline backlog delivery and post-ignition products
passed in the installed scripted sequence. Full native acceptance, fixed CPU
isolation and complete calibration/fault proof remain open. These are dated
observations, not proof of a backend running today.
The [source lock](https://github.com/alexmaninblack/aosedge-sdv-demo/blob/5e30b410cbeadd2f73063b1bd313253aff612595/workspace/checkpoints/installer-kit-028-source-lock.json)
distinguishes backend image build source from later documentation-only commits.
Original “not deployed” notes below describe their earlier source increments.

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

</details>
