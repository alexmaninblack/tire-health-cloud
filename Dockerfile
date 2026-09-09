# SPDX-FileCopyrightText: 2026 maninblack
# SPDX-License-Identifier: Apache-2.0
FROM node:26.0.0-bookworm-slim@sha256:34881fd97f67bed28bbfe3614a219e7d793e2b7554de33eaf71797d9dc8a35cc
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY LICENSE NOTICE ./
RUN mkdir -p /data /tmp/demo-backend && chown node:node /data /tmp/demo-backend
USER node
EXPOSE 18092
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:18092/health/ready', {signal: AbortSignal.timeout(2000)}); const b = await r.json(); process.exit(r.status === 200 && b.ready === true ? 0 : 1)"]
ENTRYPOINT ["node", "/app/src/main.mjs"]
CMD ["--runtime-mode", "container", "--port", "18092", "--database-path", "/data/tire-health.sqlite", "--admin-socket-path", "/tmp/demo-backend/admin.sock", "--context-path", "/run/demo-control/context/current-unit-context.json"]
