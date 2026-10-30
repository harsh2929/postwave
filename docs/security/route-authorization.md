# Route authorization contract

Status: enforced, fail closed  
Last reviewed: 2026-07-15

Moosewave has one generated route-to-capability manifest at
`apps/api/internal/routeauth/manifest.json`. The API embeds that file at build
time. Every reachable `/api/...` method/template has an explicit exposure,
authentication method, minimum session role, and API-key scope decision.

## Enforcement model

The manifest is generated from the canonical OpenAPI YAML, the reviewed
gateway-only route contracts, and the fail-closed reachability policy:

1. An operation's `security`, `x-required-auth-method`,
   `x-required-role`, and `x-required-scopes` values take precedence.
2. A reviewed exact route-contract takes precedence over an older broad
   route-contract pattern.
3. Reviewed route families preserve the established audience, campaign,
   reporting, and administrative capability boundaries.
4. A legacy read with no more specific decision requires `read:reports`.
5. A legacy mutation with no more specific decision requires `admin`.

The last two rules are deliberately restrictive. A newly added route never
inherits access merely because a handler omitted `RequireScope`.

`routeauth.Middleware` is installed after API-key and tenant/session
resolution on both authenticated router groups. It denies:

- requests whose concrete method/path cannot be resolved in the manifest;
- anonymous access to an authenticated route;
- an API key on a session-only route, or a session on an API-key-only route;
- a session below the route's minimum effective role; and
- an API key without one of the route's named scopes.

`routeauth.ValidateRouter` walks the completed chi router before the HTTP
server is constructed. Startup fails when an API route lacks an exact manifest
entry or an authenticated route is mounted outside the default-deny
middleware. `ANY` reverse-proxy entries are accepted only for the exact proxy
template; they do not hide a new concrete route.

Public, internal-service, and provider-credential routes remain at their
specialized handler boundaries because their proof is not a tenant session or
Moosewave API key. The manifest still makes those methods explicit:

- public or URL-token routes: `anonymous_or_route_credential`;
- internal routes: `internal_token_or_provider_signature`;
- audit portal: `portal_cookie`;
- Pipedrive uninstall: `provider_basic`;
- Slack callbacks: `provider_signature`; and
- CLI exchanges: `pkce_code_verifier` or `device_code`.

## Role and scope matrix

The durable backend role vocabulary remains `viewer`, `editor`, `admin`, and
`owner`. The older mobile fallback value `member` is accepted only as a
viewer-equivalent compatibility alias: it can satisfy read policies but never
editor or admin mutations. Unknown roles are denied.

| Capability                      | Viewer / legacy member        | Editor | Admin | Owner | API-key scope       |
| ------------------------------- | ----------------------------- | ------ | ----- | ----- | ------------------- |
| Audience reads                  | Allow                         | Allow  | Allow | Allow | `read:subscribers`  |
| Audience writes                 | Deny                          | Allow  | Allow | Allow | `write:subscribers` |
| Campaign reads                  | Allow                         | Allow  | Allow | Allow | `read:campaigns`    |
| Campaign writes                 | Deny                          | Allow  | Allow | Allow | `write:campaigns`   |
| Report reads                    | Allow                         | Allow  | Allow | Allow | `read:reports`      |
| Administrative routes           | Deny                          | Deny   | Allow | Allow | `admin`             |
| Session-only self/device routes | Allow when route role permits | Allow  | Allow | Allow | Not applicable      |

An API key's `admin` scope remains the wildcard implemented by the canonical
API-key middleware. A content write scope does not imply its corresponding
read scope.

## High-risk route decisions

The first enforced release makes these formerly inconsistent mutation
families explicit:

- list, tag, and ordinary suppression changes require
  `write:subscribers` / editor;
- list-scoped and global webhook configuration, delivery inspection, replay,
  test fire, and secret-affecting operations require `admin`;
- destructive suppression bulk actions, provider mirror pulls, and expiry
  changes require `admin`;
- inbound webhook and inbound-email administration require `admin`;
- SMS campaign authoring requires `write:campaigns` / editor;
- the SMS conversation inbox, quick replies, broadcasts, and their mutations
  require `admin`; and
- SMS read-shaped credit previews keep `read:reports`, while test-send keeps
  `write:campaigns` and its existing rate/budget gates.

## CI and change procedure

Generate after changing routes or authorization metadata:

```sh
node scripts/generate-route-capabilities.mjs
```

Run the complete route gate:

```sh
pnpm audit:routes
go -C apps/api test ./internal/routeauth
```

The root route audit, the main CI OpenAPI job, the dedicated OpenAPI workflow,
and the local prelaunch gate all run the generator with `--check`. A stale
manifest fails the build. Edit `packages/openapi/openapi.yaml`, never an
OpenAPI JSON mirror directly; use the existing YAML-to-JSON synchronization
command when OpenAPI metadata changes.

For a public OpenAPI route, add or correct the operation's explicit metadata.
For a gateway-only route, add a reviewed route-contract classification and
authorization. Then regenerate the manifest and add/adjust a table-driven
role and scope test.

## Product-policy decisions still open

These are not authorization bypasses: the shipped behavior is the restrictive
choice. They are decisions needed only if product wants broader access.

1. **Legacy `member` vocabulary.** The database does not permit a durable
   `member` role, while the mobile store still uses it as a missing-role
   fallback. Current enforcement treats it as viewer. Product should either
   remove the mobile fallback or formally add a durable role; adding a new
   privilege tier must not happen implicitly.
2. **SMS collaboration.** Conversation content, broadcasts, quick replies,
   assignment, tags, and notes are admin-only. If editors should operate the
   shared SMS inbox, define a dedicated scope/role policy rather than reusing
   broad campaign write access.
3. **Legacy capability relaxation.** In the 2026-07-15 generated manifest,
   543 operations still use the safe legacy default (read operations require
   `read:reports`; mutations require `admin`). This is secure and production
   safe but may be narrower than the eventual product plan. The exact,
   machine-readable set is every manifest row whose `review_status` is
   `fail_closed_default`; print it with:

   ```sh
   node scripts/generate-route-capabilities.mjs --check --decisions
   ```

Any relaxation requires a named OpenAPI scope or reviewed route-family policy
plus viewer/member/editor/admin/owner and API-key tests. Do not replace the
safe default with method-only inference.
