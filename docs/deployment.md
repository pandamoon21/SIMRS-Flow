# Deployment

SIMRS-Flow is designed to run inside the hospital network alongside the
EvoMedis/SIMRS instance. The first dashboard pilot uses one dedicated Windows
PC as the host for both the static UI and the orchestrator API. No patient data
should leave the approved network.

> **Pilot boundary:** 1–5 users, one patient/episode per run, persistent
> redacted JSONL audit, and per-user EvoMedis login. PostgreSQL is not required.
> SQLite is not implemented; evaluate it only if a measured run-history/search
> need appears.

## Topology

```text
[ operator browser on LAN ] -- HTTPS/HTTP pilot --> [ Windows host ]
       static dashboard + REST/SSE                         |
                                                           ├─ orchestrator
                                                           ├─ FileLedger JSONL
                                                           └─ EvoMedis/SIMRS
```

The browser talks to the orchestrator only. The orchestrator is the only
component that calls SIMRS and the only component that holds the per-user
session cookie. In production, use HTTPS with an internally trusted
certificate. Plain HTTP is acceptable only as an explicitly approved,
short-lived trusted-LAN pilot exception.

## Current implementation boundary

The repository currently provides:

- a Vite-built static UI in `apps/ui/dist`;
- a Fastify orchestrator that can serve that UI on the same port;
- per-user EvoMedis login and in-memory credentials/session state;
- REST commands and unnamed SSE event frames;
- preview/write control-plane safety, gates, locks, and cancellation;
- domain executors that emit executable mutation plans for addressable writes;
  approved domain writes still require controlled live-pilot evidence before
  production;
- a redacted append-only `FileLedger` JSONL backend when
  `AUDIT_LEDGER_DIR` is set.

Active runs, sessions, locks, gates, and SSE subscribers held by `RunService`
are process-local. A restart clears them. Completed terminal runs are lazily
reconstructed from the redacted JSONL ledger; interrupted runs are not resumed.

The UI and dashboard read endpoints require the per-user app session. Login sets
an `HttpOnly`, `SameSite=Lax` cookie for browser reads/SSE and keeps the bearer
token for compatibility and write authorization. The protected workflow/run
GET routes, history export, and SSE accept bearer or cookie authentication;
write-run creation, gate decisions, and write cancellation remain bearer-only.
Use `APP_COOKIE_SECURE=1` with HTTPS. Never place a bearer token in a URL.
For cross-origin development, configure exact CORS origins with credentials; the
SSE stream uses unnamed `data:` frames and does not send wildcard CORS.

## Windows host prerequisites

- Windows PC dedicated to the pilot and kept powered on during use;
- Node.js >= 22 and npm >= 9;
- repository checkout and permission to run `run.bat`;
- a persistent access-controlled directory for audit files;
- a stable LAN IP or a DHCP reservation;
- permission to add a narrowly scoped Windows Defender Firewall rule;
- an approved EvoMedis base URL;
- an operational owner and a contact for network/IT approval.

The host should use a normal Windows account with the least filesystem access
needed for the application. Do not store the repository or `.env` in a shared
folder. Do not commit `.env`, credentials, session cookies, or audit files.

## Windows LAN deployment

Run these steps from the repository root on the host.

### 1. Install and verify prerequisites

Install Node.js 22 or newer, then open a new Command Prompt and verify:

```bat
node --version
npm --version
```

### 2. Create environment configuration

Copy `.env.example` to `.env` and edit it. A trusted-LAN pilot example:

```dotenv
ORCHESTRATOR_HOST=0.0.0.0
ORCHESTRATOR_PORT=4500
ORCHESTRATOR_CORS_ORIGINS=http://192.168.1.50:4500
EVOMEDIS_BASE_URL=http://<simrs-host>/evoMedis_pkugombong/index.php
EVOMEDIS_SESSION_COOKIE_NAME=ci_session
EVOMEDIS_SESSION_COOKIE=
EXECUTION_MODE=preview
AUDIT_LEDGER_DIR=C:/SIMRS-Flow/data/audit
APP_COOKIE_SECURE=0
VITE_ORCHESTRATOR_URL=http://192.168.1.50:4500
VITE_QA_AUTH=0
QA_AUTH_TOKEN=
QA_AUTH_OPERATOR=qa-operator
AUTO_APPROVE_WRITES=1
CRITICAL_APPROVALS=1
```

Replace `192.168.1.50` with the host's stable LAN address. The UI value is
**build-time configuration**; it must not remain `localhost` when another PC
will use the bundle.

`ORCHESTRATOR_CORS_ORIGINS` is only needed when the UI is served from a
separate origin. When the built UI is served by the orchestrator on the same
origin, keep it restricted anyway rather than using `*` in a pilot.

Leave `EVOMEDIS_SESSION_COOKIE` empty for normal operation. Each operator logs
in with their own EvoMedis account; the shared-cookie fallback weakens
attribution and requires explicit approval.

`EXECUTION_MODE` documents the deployment posture but does not automatically
enable write mode. Mode is selected per run and defaults to preview in code.

Set `APP_COOKIE_SECURE=1` when the dashboard origin uses HTTPS. Keep it `0` only
for local development or the explicitly approved temporary HTTP LAN exception;
a browser will not send a Secure cookie over HTTP.

### 3. Install, verify, and build

```bat
run.bat install
run.bat typecheck
run.bat lint
run.bat test
run.bat build
```

Confirm that `apps\ui\dist` exists. `run.bat build` cleans emitted TypeScript
output after building so stale compiled files do not shadow source files.

### 4. Open the Windows Firewall only to the LAN

Create an inbound TCP rule for port 4500 restricted to the approved LAN
subnet. Example (run as an administrator, replacing the subnet):

```bat
netsh advfirewall firewall add rule name="SIMRS-Flow LAN" dir=in action=allow protocol=TCP localport=4500 remoteip=192.168.1.0/24
```

Do not allow `Any` remote address and do not expose the port through a router,
public DNS name, or internet-facing firewall rule. If network policy requires
an IT-managed firewall, provide the host IP, port, source subnet, and purpose
to the network owner instead of changing the rule yourself.

### 5. Start the host

```bat
run.bat start
```

When `apps/ui/dist` exists, the orchestrator serves the dashboard and API on
port 4500. The default UI directory is derived by `apps/orchestrator/src/main.ts`;
set `UI_DIR` only when the bundle is stored elsewhere.

For an initial pilot, a trained host owner may start the process after reboot.
Do not claim unattended operation until Task Scheduler or another Windows
supervisor has been configured, tested, and assigned an owner.

### 6. Verify from the host and a second PC

On the host, test:

```text
http://127.0.0.1:4500/
http://127.0.0.1:4500/api/health
```

From an approved second LAN PC, test:

```text
http://192.168.1.50:4500/
http://192.168.1.50:4500/api/health
```

Then verify, in order:

1. the static dashboard loads;
2. a real operator can log in with their own EvoMedis account;
3. a fixture preview run completes and SSE status updates appear;
4. an approved live preview reads the intended single patient/episode;
5. a redacted `<runId>.jsonl` file appears under `AUDIT_LEDGER_DIR`;
6. write actions remain unavailable until the run explicitly selects write and passes its gates;
7. cancel works as the kill switch;
8. the host is not reachable from an unapproved network.

## Authentication and TLS

A successful `POST /api/auth/login` is the app login. The orchestrator logs
into EvoMedis on the user's behalf, stores the current cookie and password in
memory only, and issues an opaque session token. The UI stores that token in
`sessionStorage` and sends it as a bearer token.

Credentials cross the network during login. Before production use:

- terminate TLS with an internally trusted certificate on the host or an
  approved reverse proxy;
- restrict certificate access and renewal to the host/network owner;
- use HTTPS for the dashboard and API origin;
- set the built `VITE_ORCHESTRATOR_URL` to the HTTPS origin;
- disable QA auth and remove any test credentials;
- do not use a shared service-account cookie as the normal path.

The existing application-level bearer/session checks remain necessary, but
TLS and network restriction are separate controls, not substitutes for auth.

## Persistence and backup

Set `AUDIT_LEDGER_DIR` to a persistent directory before any pilot run. The
ledger writes one redacted JSONL file per run and never rewrites existing
lines.

For a simple Windows pilot:

1. stop new runs or use the documented maintenance window;
2. copy the whole audit directory to an access-controlled backup location;
3. retain the backup according to the process owner's policy;
4. periodically restore a copy to a separate test directory;
5. verify that JSONL parses and that a run can be replayed/exported;
6. record the restore test date and result.

Do not promise recovery of active in-memory runs, locks, gates, or sessions
from a file backup. After a restart, operators log in again and reconcile any
in-flight work against SIMRS and the audit files.

SQLite is a possible future local index for run summaries, not the current
audit authority. PostgreSQL should be considered only for multi-host
coordination, high availability, heavy reporting, or a materially larger
installation.

## Deployment acceptance checklist

- [ ] Dedicated Windows host and stable LAN address assigned.
- [ ] Operational, data, host, and network owners named.
- [ ] `.env` exists only on the host and is not committed.
- [ ] `AUDIT_LEDGER_DIR` is persistent and access-controlled.
- [ ] `ORCHESTRATOR_HOST` is LAN-scoped and the firewall rule is subnet-scoped.
- [ ] `VITE_ORCHESTRATOR_URL` was set before the production UI build.
- [ ] `apps/ui/dist` is served from the orchestrator.
- [ ] CORS is restricted to approved origins.
- [ ] QA auth is disabled.
- [ ] Each operator has an individual EvoMedis account.
- [ ] Fixture preview succeeds from a second PC.
- [ ] Live preview is approved and succeeds for one patient/episode.
- [ ] Redacted JSONL audit file is created and backed up.
- [ ] Cancel and post-write verification procedures were tested.
- [ ] HTTPS is enabled before production use.
- [ ] Restart and restore procedures have named owners.

## Secondary Linux reference

The project can also run under a Linux supervisor such as systemd, pm2, or a
container. That is not the first pilot path. If used, preserve the same
requirements: persistent `AUDIT_LEDGER_DIR`, per-user login, restricted bind
and CORS origins, TLS, no committed secrets, and a tested restart/backup
procedure.

A minimal systemd shape is:

```ini
[Unit]
Description=SIMRS-Flow orchestrator
After=network.target

[Service]
Environment=ORCHESTRATOR_HOST=127.0.0.1
Environment=ORCHESTRATOR_PORT=4500
Environment=AUDIT_LEDGER_DIR=/var/lib/simrs-flow/audit
EnvironmentFile=/etc/simrs-flow/secrets.env
ExecStart=/usr/bin/node --import tsx /opt/simrs-flow/apps/orchestrator/src/main.ts
Restart=on-failure
User=simrs-flow

[Install]
WantedBy=multi-user.target
```

## Publishing the repository

Do not publish `.env`, credentials, session cookies, patient data, audit files,
or local database files. The repository is internal/proprietary. Use the
project's normal branch and review workflow for source changes.
