# Device connections

Personal Intelligence Hub can show the connection state of one personal device (for example a
wearable or a smart scale) and let authorized principals ask for a reconnect. PIH does not talk to
the device itself. An operator runs a separate, private **device bridge** process on the same host;
the connectors service talks to that bridge over a local Unix socket.

All names, paths and labels below are fictional examples.

## Trust boundaries

- The browser talks only to the web BFF (`/api/ui/v1/device-connections/...`). It never receives the
  bridge socket path, actor labels, or any command.
- The web BFF forwards the verified human with a short-lived delegated token and the `devices:read`
  or `devices:write` scope to the connectors service.
- The connectors service authorizes the principal, maps it to a bridge actor, and sends one fixed
  request to the bridge.
- No client can supply a command, unit, path or actor. The only inputs are a connection id from
  the configured set and the operation (`status` or `reconnect`).

## Bridge protocol

The bridge listens on a Unix socket. Each connection carries exactly one newline-terminated JSON
request and receives exactly one JSON line in response.

Requests sent by PIH:

```json
{"op":"status"}
{"op":"reconnect","actor":"owner"}
```

Response:

```json
{
  "status": "connecting" | "connected" | "unavailable" | "failed",
  "reason": "<string>" | null,
  "action": "<string>",
  "authenticated_at": "2026-01-01T12:00:00Z",
  "retry_after_seconds": 30
}
```

`action`, `authenticated_at` and `retry_after_seconds` are optional. Unknown fields make the
response invalid.

The bridge must:

- enforce single-flight reconnects, a cooldown, and a bounded reconnect duration (about 50 seconds);
- refuse unknown actors itself, in addition to PIH's own authorization;
- report `connected` only when the device link is actually established.

How PIH treats the response:

- `connected` is relayed only when the bridge says `connected`. PIH never infers it.
- `reason` text is never shown to clients. Only these codes pass through unchanged: `cooldown`,
  `in_progress`, `timeout`, `device_unreachable`, `authentication_failed` and `actor_not_allowed`.
  Any other reason becomes `unspecified`.
- `action` passes through only when it is `wake_device`. The UI then asks the person to wake the
  device and try again.
- `retry_after_seconds` is capped at 3600. The UI shows it as the wait before the next attempt.
- Responses are limited to 4 KiB. Status requests time out after 5 seconds and reconnects after
  60 seconds. Unreachable, slow or invalid bridges become a generic `503 dependency_unavailable`.
- While a reconnect is in flight, PIH answers further reconnects with `connecting` / `in_progress`
  and does not contact the bridge again.

## Authorization

| Principal | Allowed |
| --- | --- |
| Verified human through the PIH web BFF | Yes, as the configured human actor |
| Agent principal from the agent credential, whose delegated subject (profile id) is allowlisted | Yes, as the mapped bridge actor |
| Agent profile that is not allowlisted, or any service principal | No: `403`, and the bridge is not contacted |

The agent credential remains bound to its owner (`boundActorId`). A principal with a different
`actorId` is rejected before any route runs.

Each credential also needs the device scopes in its private `maxScopes`: `devices:read` for status
and `devices:write` for reconnect. Only the web and agent credentials may hold them.

## Configuration (connectors service)

```dotenv
DEVICE_CONNECTIONS_ENABLED=true
DEVICE_CONNECTION_ID=example-band
DEVICE_CONNECTION_LABEL=Example band
DEVICE_CONNECTION_BRIDGE_SOCKET_PATH=/run/example-device-bridge/bridge.sock
DEVICE_CONNECTION_HUMAN_ACTOR=owner
DEVICE_CONNECTION_AGENT_ACTORS_JSON={"coordinator":"agent-coordinator","health":"agent-health"}
```

- When none of these variables is set (or only `DEVICE_CONNECTIONS_ENABLED=false`), the feature is
  not configured. Routes answer `404`, and system status reports `not_configured`.
- Partial configuration fails startup, and so does configuration while the feature is not enabled.
- The socket path must be absolute and normalized, end in `.sock`, and be at most 100 characters.
  It must not live in the BFF-facing connectors socket directory or reuse another connectors
  socket.
- The connection id and the profile ids use lowercase letters, digits and hyphens. Actor labels may
  also use underscores.
- An agent profile missing from `DEVICE_CONNECTION_AGENT_ACTORS_JSON` is refused. In the example
  above a `finance` profile would be refused. Use `{}` to allow no agents.
- Give the connectors service user access to the bridge socket, for example through a dedicated
  group. Never mount the bridge socket into the web container.

## Health

The `device-connections` source in system status reports:

- `not_configured`: the feature is not configured.
- `available`: the bridge reports `connected`.
- `degraded` with `device_connecting`, `device_unavailable` or `device_failed`: the bridge is
  reachable but the device is not connected (for example, it is asleep).
- `degraded` with `bridge_unreachable` or `bridge_response_invalid`: the bridge is not running or
  is misbehaving.

None of these states fails the connectors readiness check. A sleeping device or a stopped companion
bridge is reported honestly, but it does not take the whole service out of rotation.

## Audit

Every reconnect writes one structured log entry, `device_connection_reconnect`, with the connection
id, the service id, the actor type, a closed outcome code and the request id. It contains no actor
labels, profile ids, paths or bridge text.
