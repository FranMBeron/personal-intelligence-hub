# Hermes Telegram routing

Personal Intelligence Hub talks to Hermes profiles through the connectors
service. Telegram is handled by Hermes itself: one bot, owned by the default
(gateway) profile. This page describes that setup and an **optional** native
Hermes feature that routes exact Telegram group chats to specialist profiles.

Every identifier on this page is a placeholder or fictional. Real profile
slugs, chat IDs, user IDs, tokens, service names, ports, and paths belong only
in private host configuration and must never be committed.

## Supported setups

| Setup | What it does | Status |
|---|---|---|
| Single route (default) | The default profile owns the bot and answers every allowed chat. | Supported. Nothing in this repository requires changing it. |
| Group multiplex (optional) | Direct messages stay on the default profile; listed group chats route to listed specialist profiles. | Available as generic code and an example. Not enabled by any rollout step. |

The single-route setup is the baseline. Shipping the connectors Hermes module,
its BFF routes, or the Central-to-specialist delegation tool does **not**
require group routing, and none of those steps changes the running gateway.
Enabling group multiplex is a separate, deliberate operator decision with its
own review; it is not part of the connectors rollout.

## Invariants (both setups)

- The Telegram bot token exists only in the default profile's private
  environment. Specialist profiles never receive it.
- The sender allowlist exists only in the default profile. Senders are
  validated before any route is considered; an unauthorized sender produces no
  agent turn in any profile.
- Hermes API servers bind to loopback only. Connectors reach each profile at
  `/p/<profile>/` with that profile's own API key.
- Internal delegations never use a Telegram chat or a direct PIH thread. They
  run in the target specialist's hidden `Bot Chat` session (see
  [hermes-connectors.md](hermes-connectors.md)).
- The delegation tool and its peer tokens exist only in the orchestrator
  profile's tool set and environment.

## Optional: group multiplex configuration

The block is generated or checked with `buildTelegramProfileRoutes` from
`@personal-intelligence-hub/hermes-integration`, and a fictional example lives
in `integrations/hermes/config/gateway.multiplex.example.yaml`.

```ts
import { buildTelegramProfileRoutes } from "@personal-intelligence-hub/hermes-integration";

const gateway = buildTelegramProfileRoutes({
  defaultProfileId: "orchestrator",
  specialistRoutes: [
    { profileId: "specialist-a", chatId: "-1000000000001" },
    { profileId: "specialist-b", chatId: "-1000000000002" },
  ],
});
```

The builder rejects, with a closed message that never echoes input:

- duplicate chat IDs or duplicate specialist profiles;
- the default profile as a specialist target;
- non-numeric, zero, or positive chat IDs (positive IDs are users or private
  chats, never group routes);
- an empty route list (keep the single-route setup instead);
- invalid profile slugs, unknown fields, and more than 32 routes.

Its output is a frozen object with `multiplex_profiles: true`, a closed
`multiplex_profile_allowlist` (default profile first), and one exact
`profile_routes` entry per specialist named `telegram-<profile>`.

## Optional: operator procedure for group multiplex

Only for an operator who has separately decided to enable group routing. It
is written against placeholders; substitute private values on the host and
never paste them into Git, issues, logs, or chat transcripts.

1. Create the private groups and add the existing bot. Do not create a second
   bot.
2. Capture each group's exact numeric chat ID privately.
3. Decide the bot's group privacy mode. With privacy mode on, the bot only sees
   commands and mentions in groups; disable it only if ordinary unmentioned
   messages must reach the specialist, and record the choice.
4. Back up the default profile configuration with mode `0600`.
5. In the default profile only, keep the API server on loopback and add the
   multiplex block with the closed allowlist and exact routes.
6. Confirm the bot token and sender allowlist remain only in the default
   profile.
7. Restart only the default profile's gateway service, then check it:

   ```bash
   systemctl --user restart <gateway-service>
   systemctl --user status <gateway-service> --no-pager
   HERMES_HOME="<default-profile-home>" hermes gateway status
   ss -ltn | grep '127.0.0.1:<api-port>'
   ```

8. Verify a direct message is answered by the default profile and each routed
   group by its specialist.
9. Verify an unrouted group and an unauthorized sender produce no agent turn.
10. Verify each specialist's API capabilities with that profile's private key
    without printing the key.
11. Query `/p/<profile>/v1/toolsets` for every served profile and compare it
    with the intended tool set. The delegation tool and the peer tokens must
    appear only in the orchestrator's tool set and environment. If any profile
    observes another profile's tool registry, stop and roll back. Never fix
    this by giving a specialist the orchestrator's tool set; if registries are
    shared within one gateway process, run the affected specialists in a
    separate gateway process whose tool set and environment exclude
    delegation.

Rollback: restore the backed-up default profile configuration and restart only
that gateway service. The single-route setup resumes unchanged.

## Out of scope here

- Creating or configuring real groups, contacting anyone, or changing Telegram
  client notification settings.
- Editing a running gateway or a live profile configuration as part of a code
  change.
