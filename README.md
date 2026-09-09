<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tire Health Cloud — lifecycle foundation

Independent Function Team 2 backend foundation for Studio P1. It owns its own
process, SQLite database, network and volume. It is not a renamed Brake model,
does not import Brake source, and has no fabricated Tire data, advisory, durable
receipt or service-readiness state.

The accepted Solution contracts are D4-020
`contracts/local-demo-hosting/local-demo-hosting-profile.v1.json` and D4-019
`contracts/tire-cloud-api/tire-cloud-api-profile.v1.json`. P1 explicitly permits
the backend lifecycle before P7 product implementation. This source is not a
complete implementation of the Tire product API.

## Implemented scope

| Read | Meaning |
| --- | --- |
| `/health/live` | This process answers HTTP |
| `/health/ready` | Known foundation schema and persistent SQLite storage; explicitly `scope: FOUNDATION_ONLY`, `productIngestion: false` |
| `/health/context` | Current Test context is valid and storage is available; no last-known fallback |
| Current Unit product routes | `501 NOT_IMPLEMENTED`; never fake empty records |
| Foreign Unit product routes | `404 UNIT_NOT_CURRENT` |
| Product queries without context | `503 CURRENT_UNIT_CONTEXT_UNAVAILABLE` |
| Brake namespace / public admin paths | `404 NOT_FOUND` |

Ingestion, all product projections, SSE, qualification CPU commands, dashboard
and D4-019 product cleanup are not implemented. No submitted message can receive
a durable ACK. Foundation readiness is not product-query, service or vehicle
readiness. Before P7 opens ingestion, real packaged Tire migrations, validation,
durable receipt/query/cleanup transactions and their tests must replace this
foundation-only gate.

The persistent database uses WAL, FULL synchronous mode, foreign keys and a
5-second busy timeout. It contains exactly one `schema_version` bookkeeping
table, not empty fabricated product tables. Initialization and repeat startup
are deterministic; unknown versions, extra schema objects or mismatched ledger
fail closed without deleting anything. A process restart retains the owned
database and current-run context. The foundation is not a historical archive.

## Context

Demo Control owns one dedicated read-only mounted directory. The backend
rereads `current-unit-context.json` on demand, including after an atomic rename:

```json
{
  "schemaVersion": 1,
  "contractVersion": "1.0.0",
  "source": "CURRENT_RUN_PROVISIONING_JOURNAL",
  "testUnit": {
    "systemUid": "current-test-system-uid",
    "unitRole": "VALIDATION",
    "userFacingRole": "Test Vehicle"
  }
}
```

This example is documentation, not runtime data. Actual values come only from
the provisioning journal. A distinct optional `productionUnit` follows the
existing engineering context with role `PRODUCTION`/label `Production Vehicle`;
Test is always required. Missing, unreadable, duplicate-key, malformed,
Production-only or over-4096-byte inputs have no usable scope. Clearing context
does not delete data. Reported UIDs are correlation, not authentication.

## Exact container inputs

Node 26.0.0 is the only runtime dependency (built-in HTTP/SQLite); no npm
package install is required. `Dockerfile` pins the official Linux ARM64 image
by digest; `container-build.json` records the source recipe. No built image ID
or qualification is claimed. Engineering preparation may run:

```text
docker build --platform linux/arm64 --iidfile <owned-image-id-file> /path/to/tire-health-cloud
```

Demo Control records the resulting local immutable `sha256:...` image ID and
generates Compose input. No `latest`, pull or build fallback is permitted.

| Input | Value |
| --- | --- |
| Container / network | `aosedge-demo-tire-cloud` / `aosedge-demo-tire-cloud-v1` |
| Named volume | `aosedge_demo_tire_cloud_v1:/data` |
| Host publication | `127.0.0.1:18092:18092` |
| Context directory | Dedicated owned directory, read-only at `/run/demo-control/context` |
| Database | `/data/tire-health.sqlite` |
| Private admin | `/tmp/demo-backend/admin.sock` |
| Restart | `unless-stopped` |
| Startup | `docker compose up --detach --no-build --pull never --wait` |

The nonroot `node` user owns `/data` and `/tmp/demo-backend`. Entrypoint:
`node /app/src/main.mjs`; default args:

```text
--runtime-mode container --port 18092
--database-path /data/tire-health.sqlite
--admin-socket-path /tmp/demo-backend/admin.sock
--context-path /run/demo-control/context/current-unit-context.json
```

Only explicit container mode binds internally to `0.0.0.0`; native mode stays
on `127.0.0.1` and has no arbitrary host flag. Native tests use explicit temporary
paths and port 0. Demo Control must enforce loopback-only Docker publication,
separate volumes/networks and no host networking/socket/credential mounts.
The healthcheck uses process/storage readiness, not current-Test context, so
Create may prepare the backend before Provision. No UI on 18082 is served yet.

## Foundation-only Retire proof

The fixed private entrypoint supports:

```text
docker exec aosedge-demo-tire-cloud node /app/src/main.mjs --admin-operation foundation-proof
```

This uses a private Unix request to the running foundation and returns a
read-only proof: `scope: FOUNDATION_ONLY`, `productIngestion: false`, known
schema, no product tables/records and no unknown schema objects. It does not
delete data, manufacture a D4-019 cleanup receipt or implement the product
cleanup API. Demo Control may use a successful proof, exact owned-volume
identity and stopped owner for its separately authorized foundation reset.
Any unknown table/version makes the proof fail. P7 must replace this path with
real scoped product cleanup before accepting any product record.

Normal stop never removes the named volume. Docker image build/start, restart,
LAN-negative and guest-route qualification remain unperformed in this source
increment. Targeted host tests run with `node --test test/*.test.mjs` and do not
contact Cloud, VMs or Docker.
