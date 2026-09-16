<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current-Test demo scenario reset

The existing owner-only Unix admin socket exposes POST `/api/v1/tire/admin/demo-reset`; the public TCP server does not. Demo Control invokes the fixed private admin client, not a browser-selected URL or command. Request: `{schemaVersion:1,unitSystemUid,commandId}`.

A fresh (15-second) native service poll binds the command to Unit, release, serviceId, subjectId, instanceIndex, instanceId and producerEpoch. One pending command is allowed; execution expires after 60 seconds and history is bounded to 32. Poll and acknowledgement use fixed `/api/v1/tire/demo-control/poll` and `/ack` routes; browser-origin calls are refused. This reuses private local demo trust, not production remote-management authentication.

Backend schema 3 persists command/producer records. Only a matching CLEAR and Gateway CLEARED status confirms success. Late valid acknowledgement can reconcile expiry without starting another reset. GET `/api/v1/tire/units/<uid>/demo-reset` is read-only. Owned cleanup includes commands/producers and preserves other Unit records.

Tests establish local storage, identity, idempotency, expiry and the TCP/private-socket boundary. Live service and vehicle qualification are separate.

