// SPDX-License-Identifier: AGPL-3.0-only
//
// golden_adapter.go — the approvals.GoldenCapturer adapter (#1 D2: auto-
// capture on approval). When a human approves an AI-generated resource
// through the approvals workflow, approvals.Service.Decide fires
// CaptureGolden(ctx, *Approval) best-effort in a goroutine. This adapter:
//
//  1. maps the approval's resource_type to a regression surface_kind,
//  2. resolves the approved resource's (brief -> approved-output) content,
//  3. inserts a golden example via the Store.
//
// The ResourceResolver seam keeps the surface_kind mapping + the "skip
// unsupported resource" decision unit-testable without a Postgres pool — the
// production resolver reads the campaigns table; tests pass a fake.
package ai_regression

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// ResolvedResource is the (brief -> output) content extracted from an
// approved resource, plus the model identity that produced it (best-effort).
type ResolvedResource struct {
	Brief          string
	ApprovedOutput string
	ModelID        string
}

// ResourceResolver fetches the content of an approved resource so it can be
// snapshotted as a golden example. Returns ok=false when the resource has no
// capturable AI content (e.g. an empty draft) — the adapter then skips
// capture silently rather than persisting an empty example.
type ResourceResolver interface {
	Resolve(ctx context.Context, tenantID, resourceType, resourceID string) (ResolvedResource, bool, error)
}

// GoldenAdapter implements approvals.GoldenCapturer.
type GoldenAdapter struct {
	Store    Store
	Resolver ResourceResolver
}

// Compile-time assertion that the adapter satisfies the approvals hook.
var _ approvals.GoldenCapturer = (*GoldenAdapter)(nil)

// CaptureGolden implements approvals.GoldenCapturer. Best-effort: it returns
// nil (skip) for resource types the harness doesn't capture, so the caller's
// goroutine logs nothing for the common non-AI approval.
func (a *GoldenAdapter) CaptureGolden(ctx context.Context, ap *approvals.Approval) error {
	if a == nil || a.Store == nil || ap == nil {
		return nil
	}
	surface := SurfaceKindForResource(ap.ResourceType)
	if surface == "" {
		// Not a capturable surface (e.g. automation_send) — skip quietly.
		return nil
	}
	if a.Resolver == nil {
		return nil
	}
	res, ok, err := a.Resolver.Resolve(ctx, ap.TenantID, ap.ResourceType, ap.ResourceID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	brief := strings.TrimSpace(res.Brief)
	output := normalizeGoldenOutput(res.ApprovedOutput)
	if brief == "" || output == "" {
		// Nothing to score against — never persist an empty example.
		return nil
	}
	brief = clampLen(brief, maxBriefLen)
	output = clampLen(output, maxOutputLen)
	in := CaptureGoldenInput{
		SurfaceKind:    surface,
		Brief:          brief,
		ApprovedOutput: output,
		ModelID:        res.ModelID,
		ApprovalID:     ap.ID,
		RequestID:      ap.ID,
	}
	_, err = a.Store.InsertGolden(ctx, ap.TenantID, in)
	return err
}

// SurfaceKindForResource maps an approvals resource_type to a regression
// surface_kind. Returns "" for resource types the harness does not capture.
//
// Pure function so the mapping is unit-testable. v1 captures campaign drafts
// (the richest golden examples; aicompose broadcast + agent-routine output)
// and sequence drafts; automation_send and unknown types are not captured.
func SurfaceKindForResource(resourceType string) string {
	switch resourceType {
	case string(approvals.ResourceCampaign):
		return SurfaceCampaignDraft
	case string(approvals.ResourceSequence):
		return SurfaceSequenceDraft
	default:
		return ""
	}
}

// clampLen truncates s to at most max runes (golden-example column bounds).
func clampLen(s string, max int) string {
	if len(s) <= max {
		return s
	}
	// Truncate on a rune boundary so we never split a multibyte glyph.
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// CampaignResolver is the production ResourceResolver. It reads a campaign's
// subject + body as the (brief -> output) pair. The brief is the campaign
// subject + name (the human-facing intent); the approved output is the body.
// Tenant-scoped via db.WithTenant so it respects RLS.
type CampaignResolver struct {
	Pool *db.Pool
	// ModelID is only for callers that resolved a trusted immutable generation
	// receipt. A mutable campaign row alone cannot prove which model (if any)
	// authored the approved content, so production leaves this empty.
	ModelID string
}

// Resolve implements ResourceResolver for campaign resources. Sequence
// resources are not resolved here (no body column to snapshot) and yield
// ok=false; a v2 resolver can add sequence draft content.
func (c *CampaignResolver) Resolve(ctx context.Context, tenantID, resourceType, resourceID string) (ResolvedResource, bool, error) {
	if c == nil || c.Pool == nil {
		return ResolvedResource{}, false, nil
	}
	if resourceType != string(approvals.ResourceCampaign) {
		return ResolvedResource{}, false, nil
	}
	tx, err := db.WithTenant(ctx, c.Pool, tenantID)
	if err != nil {
		return ResolvedResource{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var name, subject, body string
	err = tx.QueryRow(ctx, `
SELECT COALESCE(name, ''), COALESCE(subject, ''), COALESCE(body_html, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, resourceID).Scan(&name, &subject, &body)
	if err != nil {
		// Missing campaign (race / non-campaign id) — skip, don't error.
		return ResolvedResource{}, false, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return ResolvedResource{}, false, err
	}
	model := c.ModelID
	if model == "" {
		model = "unverified_approval_snapshot"
	}
	brief := strings.TrimSpace(subject)
	if brief == "" {
		brief = strings.TrimSpace(name)
	}
	return ResolvedResource{Brief: brief, ApprovedOutput: body, ModelID: model}, true, nil
}
