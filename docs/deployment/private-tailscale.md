# Private Tailscale deployment runbook

This is a future operator runbook, not authorization to deploy. The public
repository contains no working credentials, private hostnames, tailnet names,
or production environment files. Do not run these steps against a private host
without explicit operator approval.

## Prepare the host

1. Install a supported Docker Engine and Compose plugin on the private host.
2. Create `/srv/personal-intelligence-hub` with `releases`, `config`, `secrets`,
   `backups`, and database-data directories. Restrict private directories to
   mode `0700` and secret files to `0600`.
3. Extract a reviewed immutable revision into `releases/<git-sha>` and write the
   full SHA to `REVISION`. Do not copy Git credentials, Hermes profiles,
   personal vaults, or backups into the release.
4. Place API/web environment files and the PostgreSQL password in a root-owned
   location outside the repository with mode `0600`.
5. Copy `infrastructure/docker/.env.example` outside Git and replace every
   placeholder with an image reference, localhost port, or absolute secret-file
   path. Keep `DATABASE_URL`, OIDC values, and signing keys in the private API
   environment file.

Configure both web and API with `AUTH_MODE=tailscale` and the same externally
generated `PIH_INTERNAL_AUTH_KEY`. Configure only web with an external
`TAILSCALE_ALLOWED_USERS` mapping of `login=actor-uuid` entries. The web tier
discards browser authorization and emits a short-lived internal token for API
and audit attribution.

### Identity comes only from the trusted proxy socket

Any process on the host can open the loopback web port and send arbitrary
`X-Forwarded-For` or `Tailscale-User-Login` headers, so loopback is **not** a
trust boundary. Every Tailscale identity mode (`AUTH_MODE=tailscale` and
`CONNECTORS_HUMAN_AUTH_MODE=tailscale-localapi`) therefore accepts identity
only from a private Unix socket that only Tailscale Serve can reach:

- Web listens on `PIH_WEB_TRUSTED_PROXY_SOCKET` (container path
  `/run/pih-web-proxy/web.sock`) in addition to its TCP port. The socket is
  created mode `0600` inside an existing directory that must be owned by the
  web process user with no group/other access. A stale socket owned by that
  user is replaced; a regular file, symlink or still-active socket at the path
  stops startup and is never removed.
- Requests on that socket are the only ones whose identity headers are read.
  In `tailscale-localapi` mode web reads one `X-Forwarded-For` address written
  by Serve and confirms it with LocalAPI WhoIs; the legacy Second Brain mode
  reads `Tailscale-User-Login`, which Serve strips and re-adds.
- Requests on the TCP port never carry identity in a Tailscale mode: they get
  `401` whatever headers they send. The TCP port stays only for container and
  deploy health checks (`/health`).
- Startup fails if a Tailscale mode lacks `PIH_WEB_TRUSTED_PROXY_SOCKET`, if
  the socket is set without a Tailscale mode, or if the removed
  `CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR` is still present.

Host layout (`infrastructure/systemd/pih-web.sysusers` and
`pih-web.tmpfiles`): the web container runs as a dedicated non-login host user
`pih-web` (`PIH_WEB_UID`/`PIH_WEB_GID` in the Compose environment). Never reuse
the UID of a human or agent account: a process with the same UID can inspect
the container process and reach its socket. `/run/pih-web` is `root:root 0700`
so no unprivileged host user can traverse to the socket, and
`/run/pih-web/proxy` is `pih-web:pih-web 0700` and is bind-mounted read-write
at `/run/pih-web-proxy`. `tailscaled` runs as root and can connect.

Run `infrastructure/operations/deploy-release.sh <git-sha>` to build and scan
the SHA-tagged API, web and PostgreSQL images, write the release manifest and
one SBOM per image, start the stack,
wait for health, and atomically switch `current`. Review and install the
checked-in systemd units only after adapting their ownership and alert files.

Validate without starting services:

```bash
docker compose \
  --env-file /path/outside/git/pih-compose.env \
  -f infrastructure/docker/compose.production.yaml \
  config --quiet
```

Compose runs the API image as a one-shot `migrate` service before API startup.
It serializes migration attempts, records the applied migration checksum, and
refuses to continue if an already-applied migration file has changed. Review
the migration image and database backup before starting a new revision.

The production example publishes only web on `127.0.0.1`, for health checks.
API and PostgreSQL have no host ports and remain reachable only on private
Compose networks. Expose web to the tailnet only through an authorized
Tailscale Serve route to the trusted proxy socket.
Verify from a tailnet client and separately confirm the service is unreachable
from public network interfaces. Never enable Funnel for this deployment.

First record `tailscale serve status --json`. Add only a dedicated HTTPS port
whose target is the PIH trusted proxy Unix socket (Tailscale 1.102 or later):

```bash
tailscale serve --bg --https=<dedicated-port> unix:/run/pih-web/proxy/web.sock
tailscale serve status --json
```

Never point Serve at `http://127.0.0.1:<web-port>` in a Tailscale identity
mode: those requests arrive over TCP and are rejected with `401`.

Do not run `tailscale serve reset`: it can remove unrelated private routes.
Confirm the pre-existing routes are unchanged, Funnel remains disabled, and
tailnet policy admits only the intended users or devices.

### Migrating from a TCP Serve target or a trusted proxy CIDR

Releases before the trusted proxy socket pointed Serve at the loopback TCP
port and, for connectors, trusted `CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR`.
Both are replaced. With operator approval, on the private host:

```bash
# 1. Dedicated web user and private socket directories.
sudo install -m 0644 <release>/infrastructure/systemd/pih-web.sysusers /etc/sysusers.d/pih-web.conf
sudo install -m 0644 <release>/infrastructure/systemd/pih-web.tmpfiles /etc/tmpfiles.d/pih-web.conf
sudo systemd-sysusers /etc/sysusers.d/pih-web.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/pih-web.conf
stat -c '%U:%G %a %n' /run/pih-web /run/pih-web/proxy   # root:root 700, pih-web:pih-web 700

# 2. Compose environment (outside Git): add the numeric IDs.
printf 'PIH_WEB_UID=%s\nPIH_WEB_GID=%s\n' "$(id -u pih-web)" "$(getent group pih-web | cut -d: -f3)" \
  | sudo tee -a <private-compose-env-file>

# 3. Web environment (outside Git): add the socket, remove the CIDR.
#    PIH_WEB_TRUSTED_PROXY_SOCKET=/run/pih-web-proxy/web.sock
#    delete any CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR line
sudoedit <private-web-env-file>

# 4. Deploy the reviewed release, then confirm the socket exists.
sudo ls -l /run/pih-web/proxy/web.sock                  # srw------- pih-web pih-web

# 5. Repoint only the PIH Serve port at the socket.
tailscale serve status --json > <private-backup-dir>/serve-before.json
tailscale serve --https=<dedicated-port> off
tailscale serve --bg --https=<dedicated-port> unix:/run/pih-web/proxy/web.sock
tailscale serve status --json
```

Verify: from a tailnet client the application loads as the expected user;
on the host, `curl -H 'X-Forwarded-For: <owner-tailnet-ip>' -H
'Tailscale-User-Login: <owner-login>' http://127.0.0.1:<web-port>/api/ui/v1/agents`
returns `401`; `curl http://127.0.0.1:<web-port>/health` still succeeds. To roll
back, redeploy the previous release and restore the recorded Serve route.

## Web environment reference

All values below are server-only and live in the private web environment
file. None may use a `NEXT_PUBLIC_` prefix.

| Variable | Purpose |
| --- | --- |
| `AUTH_MODE` | Second Brain identity: `oidc` (default, browser bearer forwarded) or `tailscale`. |
| `PIH_INTERNAL_AUTH_KEY` | Shared web/API HS256 key (at least 32 bytes) for Tailscale-derived internal tokens. |
| `TAILSCALE_ALLOWED_USERS` | `login=actor-uuid` list for `AUTH_MODE=tailscale`. |
| `PIH_WEB_TRUSTED_PROXY_SOCKET` | Absolute `*.sock` path of the trusted proxy listener. Required by every Tailscale mode, rejected otherwise. Production: `/run/pih-web-proxy/web.sock`. |
| `CONNECTORS_ENABLED` | `true` or `false`. Unset or `false` disables connectors; any other `CONNECTORS_*` value then fails startup. |
| `CONNECTORS_SOCKET_PATH` | Absolute `*.sock` path of the private connectors BFF socket. Default `/run/pih-connectors/connectors.sock`. |
| `CONNECTORS_SERVICE_TOKEN` | Web's private connectors service credential (at least 32 characters). |
| `CONNECTORS_DELEGATED_JWT_KEY` | 32-byte base64url key for delegated connector tokens; must differ from `PIH_INTERNAL_AUTH_KEY`. |
| `CONNECTORS_HUMAN_AUTH_MODE` | Exactly one of `oidc` or `tailscale-localapi`; settings of the other mode fail startup. |
| `CONNECTORS_OIDC_ISSUER` | OIDC mode: HTTPS issuer. |
| `CONNECTORS_OIDC_AUDIENCE` | OIDC mode: expected audience. |
| `CONNECTORS_OIDC_JWKS_URI` | OIDC mode: HTTPS JWKS URL. Limits are keyed on the verified subject. |
| `CONNECTORS_TAILSCALE_LOCALAPI_SOCKET` | `tailscale-localapi` mode: absolute path at which web reaches the tailscaled LocalAPI socket (WhoIs lookups). |
| `CONNECTORS_TAILSCALE_ALLOWED_USERS` | `tailscale-localapi` mode: `login=actor-uuid` list. Also requires `PIH_INTERNAL_AUTH_KEY` and `PIH_WEB_TRUSTED_PROXY_SOCKET`. |
| `CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR` | Removed. Startup fails while it is set. |
| `PIH_CENTRAL_AGENT_ID` | Optional. Hermes profile id of the coordinator shown as the Central conversation on Hoy, Sistema and Second Brain. |
| `PIH_DEVICE_CONNECTION_ID` | Optional. Device connection id shown in Sistema > Dispositivo; must equal the connectors service's `DEVICE_CONNECTION_ID`. |

Legacy `HERMES_INTERNAL_URL`/`HERMES_SERVICE_TOKEN` cannot be combined with
`CONNECTORS_ENABLED=true`. BFF JSON request bodies are capped at 64 KiB
(`413 payload_too_large`); uploads use `MAX_UPLOAD_BODY_BYTES`.

`PIH_CENTRAL_AGENT_ID` and `PIH_DEVICE_CONNECTION_ID` are installation
choices that the connectors API does not publish. Both are validated when web
starts: a value must start with a lowercase letter and contain only lowercase
letters, digits and hyphens (at most 63 characters). An invalid value stops
startup with `<VARIABLE> is invalid.`; an unset or empty value is allowed and
the pages say "not configured" instead of guessing. Web never creates a
profile or a connection from these values:

- Use an id from the connectors Hermes profile list for
  `PIH_CENTRAL_AGENT_ID`. If the roster does not list it, the Central entry
  shows the raw id as its name, which is a sign of a typo.
- `PIH_DEVICE_CONNECTION_ID` names the connection whose status and reconnect
  routes Sistema uses. A value that the connectors service does not know is
  reported as unavailable, never as connected. See
  [Device connections](device-connections.md).

## BFF settings and user flows

The web server is the only browser-facing boundary. It reaches connectors over
the read-only mounted socket (`CONNECTORS_SOCKET_PATH`) with its own service
credential and a short-lived delegated token for the verified person. The
browser receives only normalized `/api/ui/v1` responses, never provider URLs,
tokens, agent reasoning or tool traces.

### Configure connectors

1. Deploy and configure the connectors service first
   ([Private connectors operations](private-connectors.md)), including the
   Hermes profiles, Calendar provider and optional device connection.
2. In the private web environment file set `CONNECTORS_ENABLED=true`, the
   socket path, `CONNECTORS_SERVICE_TOKEN`, `CONNECTORS_DELEGATED_JWT_KEY`
   and exactly one human authentication mode. For Tailscale use
   `CONNECTORS_HUMAN_AUTH_MODE=tailscale-localapi`, the LocalAPI socket,
   `CONNECTORS_TAILSCALE_ALLOWED_USERS`, `PIH_INTERNAL_AUTH_KEY` and
   `PIH_WEB_TRUSTED_PROXY_SOCKET`, as described above.
3. Optionally set `PIH_CENTRAL_AGENT_ID` and `PIH_DEVICE_CONNECTION_ID`.
4. Deploy, then open **Sistema** from a tailnet client. Each source card shows
   its own state, when it was last checked and its last success. A failing
   source says so; it is never shown as empty or healthy. Use **Actualizar
   estado** to check again after fixing a source.

### Select your time zone

**Sistema > Tu zona horaria** stores one IANA zone (for example
`Europe/Madrid`) for your account on the server. Web and desktop use it for
the day shown in **Hoy**, the greeting, the agenda window and the times on
every tab; the server or browser zone is never used instead. Saving sends
the version you saw: if another device changed the zone first, nothing is
overwritten, the stored value is loaded and you can save again. Without a
readable preference, times are labelled explicitly in UTC.

### Restore chats

Conversations live on the server, not in the browser. Each agent remembers
one selected thread on the server, so a reload, another tab, another device or
a restarted desktop app opens the same thread with its history; replies that
arrive later are delivered live from where the history ended.

- Nothing is created when a page opens. Your first message to an agent creates
  its main conversation; **Nueva conversación** creates another one.
- **Archivar** hides a thread (the main conversation cannot be archived);
  archived threads stay listed and **Restaurar** brings them back.
- A link such as `/?conversation=<id>` (for example from a delegation's
  **Abrir conversación de origen**) shows that thread without changing your
  selection until you choose **Usar como conversación activa**.
- Delegations between agents appear only in the **Delegaciones** ledger of
  **Agentes**. They never appear inside direct conversations.
- If a send fails, the message stays on screen with **Reintentar**. Retrying
  reuses the same idempotency key, so the server never stores it twice.

### Set up Calendar through the system browser

Follow [Google Calendar connector](google-calendar.md) to create the OAuth
client and configure the connectors service. Then, in **Sistema**:

1. Choose **Conectar Google Calendar** (or **Volver a autorizar**). Web asks
   connectors for a one-time authorization link.
2. Choose **Continuar en navegador**. The link opens in your system browser,
   never inside the web page or the desktop window; the desktop app asks you
   to confirm the destination first.
3. After you approve access, Google returns to
   `/api/ui/v1/calendar/oauth/callback` on your private origin, and the BFF
   redirects that browser to **Sistema** with a connected or attention state.
   The browser must reach the tailnet origin as the same person.
4. Back in the app, the status refreshes on its own. Select the calendars to
   read and the ones that may receive changes.

Calendar change proposals are opened through `/system?proposal=<id>`. Opening
or reloading that link never changes anything: the review shows the full guest
list, description, time zone, recurrence scope and notification behaviour,
and only **Confirmar cambio** applies it. A stale or already decided proposal
asks for a new one instead of being applied.

### Device connection status and reconnect

When `PIH_DEVICE_CONNECTION_ID` is set, **Sistema > Dispositivo** shows the
status reported by the device bridge. **Reconectar** changes to
**Reconectando…** while the bridge works. **Conectada** appears only when the
bridge confirms the connection. Otherwise the panel explains what to do: wake
the device, wait the indicated seconds, check pairing, or try later when the
bridge itself is unreachable.

### Verify

From a tailnet client, check each flow above with your own account. On the
host, confirm that a request with forged identity headers to the web TCP port
returns `401` (see the migration check above). The repository's fictional
end-to-end suite (`cd apps/web && pnpm exec playwright test`) covers these
journeys against a simulated connector and Tailscale Serve; it does not
replace checking the real deployment.

## Container baseline updates

The Dockerfiles pin the exact multi-platform digest for their Node build and
runtime base. Production Compose does the same for PostgreSQL. To update a
base, obtain the current index digest from the official image registry, change
the human-readable patch tag and digest together, rebuild both images, and run
the Docker policy, image vulnerability, Compose lifecycle, and functional
checks before committing. Do not update only the movable tag.

Application runtimes contain the standalone web output or the API production
dependency bundle rather than a workspace copy. Compose drops all application
capabilities, prevents privilege escalation, makes their filesystems
read-only, caps processes/CPU/memory, and rotates local container logs. Do not
mount the Docker socket or other host paths into application containers; web
receives only the read-only connectors socket directory and its private trusted
proxy socket directory.

## Future directory migration

For a separately approved migration from an existing installation root, stop
the old service, take and verify a backup, deploy the reviewed revision into
`/srv/personal-intelligence-hub`, restore PostgreSQL using the companion
runbook, then update service and backup paths atomically. Keep the old directory
read-only until application, audit, snapshot, SSE reconnect, and restore checks
all pass. Removal of the old directory is a separate destructive operation.
