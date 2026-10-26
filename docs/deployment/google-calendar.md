# Google Calendar connector

This guide sets up the private Google Calendar connector for one installation.
Every value below is a placeholder. Real client IDs, client secrets, redirect
hosts, keys, tokens, account names, and calendar content stay in the private
installation environment and never enter Git, issues, logs, or screenshots.

## 1. Google Cloud project and OAuth client

Each installation uses its own Google Cloud project and OAuth client. Do not
share a client between installations.

1. Create a Google Cloud project for this installation.
2. Enable the **Google Calendar API**.
3. Configure the OAuth consent screen. Add only the account owners who will
   connect while the project is in Testing.
4. Create an OAuth client of type **Web application**.
5. Add exactly one authorized redirect URI: the private HTTPS callback route
   that the PIH web BFF serves, for example
   `https://pih.example.test/api/ui/v1/calendar/oauth/callback`. It must match
   `GOOGLE_CALENDAR_OAUTH_REDIRECT_URI` character for character, including
   path and trailing slash. HTTP is accepted only for `localhost` in tests.

The BFF owns the browser callback and the final redirect back to **Sistema**.
The connector owns `state`, the PKCE S256 verifier, the code exchange, and
token storage. The BFF never receives a refresh token.

### Scopes

The connector requests exactly:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

It does not request the broad `calendar` scope, Calendar ACL, calendar
creation, Drive, or OpenID identity scopes. A grant missing either required
scope is rejected and the source reports `requires_reauthorization`. A grant
that carries any scope beyond these two is also rejected, and the connector
revokes the token it just obtained (best effort, bounded to a few seconds)
instead of storing it. Broader scopes are not needed: event writes go only to calendars the owner selected
in PIH, and the calendar list is read-only.

### Testing mode and verification

While the consent screen is in **Testing**, Google issues refresh tokens for
these scopes that expire after seven days. The connector then reports
`requires_reauthorization`, and the owner must reconnect from **Sistema**.
Treat Testing as temporary. For a lasting personal installation, publish the
app (In production) and follow Google's current guidance for personal-use or
unverified apps with sensitive scopes. Record that decision privately.

## 2. Private configuration

Set these variables only in the private connector environment file (mode
`0600`, owned by the service user). The repository ships blank placeholders
in `apps/connectors/src/calendar/calendar.env.example`.

```sh
GOOGLE_CALENDAR_CLIENT_ID=example-client-id.apps.googleusercontent.com
GOOGLE_CALENDAR_CLIENT_SECRET=<client secret from the Google Cloud console>
GOOGLE_CALENDAR_OAUTH_REDIRECT_URI=https://pih.example.test/api/ui/v1/calendar/oauth/callback
GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS=600
GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS=900
GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS=3600
GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID=key-2026-01
GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON=[{"id":"key-2026-01","key":"<32 random bytes, base64url>"}]
GOOGLE_CALENDAR_BLIND_INDEX_KEY=<32 random bytes, base64url>
```

- The OAuth state lifetime is 60 to 600 seconds.
- Proposals always expire after 15 minutes; `900` is the only accepted value.
- Maintenance runs every 60 to 86,400 seconds.
- When none of these variables is set, Calendar reports `not_configured` and
  every Calendar route answers safely without contacting Google.

### Keys

Generate keys on a trusted machine, outside the repository:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Use one value per encryption key and a separate value for the blind-index key.
Encryption keys protect refresh tokens, the PKCE verifier, the primary calendar
binding, provider calendar and event identifiers, calendar names, proposal
content, and provider ETags (AES-256-GCM). The blind-index key derives opaque
calendar and event references.

To rotate an encryption key, add a new entry to the key list, make it active,
and keep the previous entries until no stored value uses them. Do not rotate
the blind-index key in place: it changes every opaque reference. Keep both
keys under separate custody from the backup password and from the environment
file.

## 3. Calendar selection

- After the first authorization, the connector finds the account's primary
  calendar. It must be writable (writer or owner). The connector then binds
  the primary calendar to the PIH owner and enables it for both reading and
  writing in one transaction.
- Every other calendar starts disabled. Reading needs explicit selection in
  **Sistema**. Writing needs a second, separate approval after reading is
  saved, and Google must report a writer or owner role for that calendar.
- Google access is not PIH authorization. Central reads and proposes changes
  only for selected calendars, and refers to them only by opaque references.

## 4. Proposals and confirmation

Central (`hermes-central`) may read and create proposals. Only an authenticated
human through the PIH web BFF may confirm, reject, or retry them, and only that
human may connect, disconnect, or change the selection. Proposals are bound to
their owner, are idempotent per `Idempotency-Key`, and expire after 15 minutes.
Updates, cancellations, and invitation responses compare the provider ETag. If
the event changed in the meantime, the proposal ends in conflict and a new
proposal is needed. Cancelling applies only to events the owner organizes. An
invitation from someone else needs a separate response operation.

The confirmation screen shows everything the change sends to Google: every
guest email (for an update, also which guests are added or removed compared
with the current event) and the full description as plain text (for an update,
whether it changes and the new text). Invisible and bidirectional control
characters are shown as visible code points. Review the recipients before
confirming: a proposal comes from an agent and may add guests you did not ask
for.

If the connector stops after starting a change but before saving the result,
the next start inspects provider state for those proposals before serving
any route, within a bounded budget: at most the first 100 executing proposals
and at most 30 seconds, and it ends early on shutdown. It settles each
proposal without repeating a change blindly. Proposals it does not reach stay
executing for the next start or a human retry from **Sistema**. If Google is
unreachable, the proposal stays executing and the source reports `degraded`
when Calendar had succeeded earlier, or `unavailable` when it never had; a
human can retry from **Sistema** later.

While any proposal is executing, disconnecting or reconnecting Calendar is
refused with `409 conflict` before anything is revoked or deleted, so a change
that may already have reached Google keeps its proposal and audit record. Wait
until it settles (or retry it from **Sistema**), then disconnect or reconnect.
If a proposal starts executing while a reconnect is exchanging its code, the
reconnect fails and the newly issued Google token is revoked.

Readiness (`/health/ready`) reflects the connector process only: the database,
migrations, and every module probe answering. Provider and account state, such
as an unreachable Google or a missing calendar selection, never fails
readiness; it appears in system status (`/v1/system/status`) and **Sistema**.

## 5. Disconnect and reauthorization

Disconnecting from **Sistema** attempts to revoke the grant at Google, and
then erases local credentials, the calendar selection, event references, and
proposals. Only sanitized audit rows (operation, outcome, time, request ID)
remain.

Reauthorization replaces the stored authorization. It also resets the calendar
selection and local event references, because they belong to the previous
grant. In the same flow the connector rediscovers the primary calendar and
re-enables it before reads resume. If that discovery fails, the source reports
`requires_attention` with `calendar_selection_required`. **Sistema** then
finishes the setup through the idempotent bootstrap retry
(`POST /v1/calendar/bootstrap`), without a second code exchange. When Google
returns no new refresh token during reauthorization, the reconnect fails with
`calendar_oauth_refresh_token_missing` (`409`) and nothing changes: the old
refresh token is never paired with the new consent, which may belong to a
different Google account. Start the connection again; PIH always requests
`prompt=consent`, so Google issues a new refresh token.

## 6. Retention

Maintenance runs once at startup and then on the configured interval. Runs
never overlap, and a failed run logs only a closed reason code.

| Data | Retention |
| --- | --- |
| Pending proposals past their expiry | Marked expired, with an audit row |
| OAuth transactions | Deleted 24 hours after expiry |
| Idempotency records | Deleted after 24 hours |
| Encrypted proposal content and provider ETags | Erased 30 days after the terminal state; metadata and audit stay |
| Event references | Deleted after 90 days without being observed, unless a live proposal needs them |
| Sanitized audit rows | Kept |

## 7. Backup and restore

The Calendar tables live in the private connector SQLite database. Back it up
with SQLite's online backup API (the connector backup helpers do this) or
after a controlled WAL checkpoint while the service is stopped. Never copy
only the main database file while WAL is active. Encrypt snapshots in the
existing Restic policy. Keep the Restic password and the connector keys under
separate custody: without the matching encryption keys, a restored database
cannot decrypt tokens or proposals. Rehearse a restore against a real snapshot
and confirm that the restored service reports Calendar status correctly.

## 8. Operational limits

- **Single replica.** Per-proposal locks and maintenance scheduling are
  in-process. Run exactly one connector process against the database, and
  serialize deployments.
- **No webhooks or public ingress.** Reads happen on demand, with a short
  in-memory page cache that a restart clears. Google never calls the
  installation.
- The connector listens only on its private Unix socket. The browser reaches
  Calendar only through the authenticated BFF.
