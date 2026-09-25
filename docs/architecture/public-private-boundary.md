# Public/private boundary

This repository is reusable public code. It may contain schemas, generic
runbooks, fictional fixtures, placeholder configuration, and deterministic
migrations. It must not contain personal content, deployment credentials,
private hostnames, tailnet names, Hermes profiles, vaults, backups, or working
production configuration.

## Configuration flow

- `apps/api/src/config/private.ts` is the API's sole `process.env` reader. It
  validates database, OIDC/JWKS, signing, origin, logging, retention, host, and
  port settings for server composition only.
- `GET /v1/config/public` serializes an explicit `PublicConfig` allow-list.
  Arbitrary environment spreading is forbidden.
- `apps/web/src/config/server.ts` owns `PIH_API_INTERNAL_URL` and the explicit
  `PUBLIC_ORIGIN` used for same-origin mutation checks. Forwarded host and
  protocol headers never authorize a request. Client code may import only the
  explicit `NEXT_PUBLIC_*` allow-list.
- `AUTH_MODE=oidc` is the generic default. `AUTH_MODE=tailscale` is an optional
  localhost-only ingress adapter: web validates the Tailscale login against an
  external `login=actor-uuid` allow-list, discards browser credentials, and
  signs a 30-second internal JWT. API accepts that JWT only in the matching
  mode with fixed HS256 issuer and audience checks. The shared key and
  allow-list remain outside Git.
- `integrations/hermes` receives its base URL and bearer credential at runtime.
  It never logs either the credential or original user content.
- Example environment files contain placeholders or clearly fictional local
  values. Production secret files live outside Git with restrictive ownership.

## Automated boundary

CI runs `pnpm verify:secrets`, validates the committed OpenAPI document against
the frozen base, checks the container confinement policy, inspects Compose
through its smoke test, and performs all tests/builds from a frozen lockfile.
Only the pnpm store is cached. Dependabot tracks workspace, GitHub Actions, and
Docker dependencies.

Before publishing any revision, inspect tracked filenames, staged diffs,
generated OpenAPI, container host ports, and Git history. A passing scanner is
a guardrail, not permission to add real data. Suspected exposure should follow
[`../../SECURITY.md`](../../SECURITY.md); rotate/revoke the external secret and
rewrite history only through a separately approved incident procedure.
