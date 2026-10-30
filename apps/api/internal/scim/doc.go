// SPDX-License-Identifier: AGPL-3.0-only
//
// Package scim implements SCIM 2.0 (RFC 7643/7644) Users + Groups
// endpoints plus a SAML JIT-provisioning bridge into Moosewave's
// existing users table.
//
// # Bearer auth
//
// SCIM clients (Okta, Azure AD, JumpCloud) authenticate with
// `Authorization: Bearer <token>`. The bearerAuth middleware
// re-hashes the bearer (sha256) and looks up scim_tokens.token_sha256
// to resolve the tenant. The scim_tokens table uses a worker-
// permissive RLS policy so the lookup runs BEFORE app.tenant_id is
// bound — that's how the middleware knows which tenant to bind in
// the first place.
//
// # Token mint
//
// MintToken inserts sha256(raw) + an 8-char prefix. The raw token is
// returned ONCE to the operator (admin-tooling copy-paste); the
// prefix is the only operator-visible affordance after that, used
// to identify the token in audit logs without exposing the secret.
//
// # Endpoints (mounted on the OUTER router — bearer auth, no tenant
// middleware)
//
//	GET    /scim/v2/ServiceProviderConfig
//	GET    /scim/v2/ResourceTypes
//	GET    /scim/v2/Schemas
//	GET    /scim/v2/Users[?filter=userName eq "alice"]
//	POST   /scim/v2/Users
//	GET    /scim/v2/Users/{id}
//	PUT    /scim/v2/Users/{id}     (full replace)
//	PATCH  /scim/v2/Users/{id}     (RFC 7644 PATCH ops)
//	DELETE /scim/v2/Users/{id}     (soft delete: status='deleted')
//	... same for Groups ...
//
// # Admin endpoints (tenant-resolved, ScopeAdmin)
//
//	GET    /api/v1/scim/tokens
//	POST   /api/v1/scim/tokens
//	DELETE /api/v1/scim/tokens/{id}
//	GET    /api/v1/scim/role-mappings
//	POST   /api/v1/scim/role-mappings
//	DELETE /api/v1/scim/role-mappings/{id}
//
// # JIT bridge
//
// When SAML asserts a user (via the SAML handler outside this
// package), it calls ResolveRoleFromGroupNames + SAMLJITProvision
// to resolve the user's Moosewave role (owner/admin/editor/viewer)
// from their SCIM group membership and upsert a row in users with
// ON CONFLICT (tenant_id, email).
//
// # Filter parser limitation
//
// parseEqFilter accepts ONLY `<attr> eq "<value>"` — the AND/OR/sw/
// co/pr operators are NOT supported. A composed filter like
// `userName eq "alice" and active eq true` is GREEDILY accepted
// with the value taking everything after the first " eq " — the
// lookup then misses, which is the safe behavior. See
// TestParseEqFilter_ANDCompositionMishandledNotRejected for the
// codified observation.

package scim
