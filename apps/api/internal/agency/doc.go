// SPDX-License-Identifier: AGPL-3.0-only

// Package agency exposes a contained administration surface over legacy
// parent_tenant_id and whitelabel columns.
//
// The operational surface in this release is deliberately narrow:
//
//   - GET /api/v1/agency/children returns a bounded, cursor-paged roster through
//     a fixed SECURITY DEFINER projection. A parent receives no general SELECT
//     policy over child tenant rows.
//   - GET /api/v1/agency/branding returns a normalized, bounded projection of
//     stored configuration for the current tenant with a dedicated monotonic
//     ETag. Invalid legacy values project as empty rather than being rewritten.
//
// Child creation/unlink, billing-mode changes, branding updates, and invoice
// preview return stable release-held responses and commit no state. There is no
// atomic child ownership/onboarding bootstrap, consolidated billing processor,
// rated invoice ledger, or public custom-domain resolver. In particular,
// billing_mode='parent', reseller markup, custom domains, and legal-entity
// values are legacy stored configuration, not proof of an operational product
// capability.
//
// All routes require admin scope. Roster and held child/billing/invoice routes
// also require is_agency_account=true. Responses are tenant-private/no-store,
// including refusals emitted before handler dispatch.
package agency
