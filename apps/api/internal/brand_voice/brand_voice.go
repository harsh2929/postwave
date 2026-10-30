// SPDX-License-Identifier: AGPL-3.0-only
//
// Package brand_voice implements G10 of the campaigns 2026 pack —
// operator-authored brand voice profile per tenant.
//
// Surface (v1 backbone):
//
//	GET  /api/v1/voice/brand-profile        (scope: read_campaigns)
//	PUT  /api/v1/voice/brand-profile        (scope: admin)
//
// The Extract endpoint (POST .../extract) and Rewrite endpoint
// (POST /api/v1/ai/compose/rewrite) require a voice-service round
// trip — they live in G10 follow-up commits next to the existing
// aicompose flow. The active row this package stores becomes the
// profile_id those endpoints condition on.
package brand_voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Profile mirrors the brand_voice_profiles row.
type Profile struct {
	ID             string    `json:"id"`
	Descriptors    []string  `json:"descriptors"`
	WritingRules   []string  `json:"writing_rules"`
	SampleSnippets []string  `json:"sample_snippets"`
	IsActive       bool      `json:"is_active"`
	ExtractedAt    *string   `json:"extracted_at,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// Deps bundles the pool.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// error context (tenant_id, request_id, err) without echoing it to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Validation caps. Spec-driven; rejecting beyond these protects the
// upstream voice service from accidentally-massive prompts.
const (
	maxDescriptors    = 20
	maxWritingRules   = 30
	maxSampleSnippets = 10
	maxSnippetChars   = 4096
	maxRuleChars      = 512
	maxDescriptorLen  = 64
)

// MountRoutes wires the read/write CRUD. Read is read_campaigns
// (operators viewing how their AI is configured); Write is admin
// because the profile shapes outbound copy across the entire tenant.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/voice/brand-profile", d.get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/voice/brand-profile", d.put)
}

// LoadActive is the package-level helper the AI compose / drift
// endpoints will read from (G10 follow-up). Returns (nil, nil) when
// the tenant has no active profile — callers MUST treat that as
// "fall back to the auto-extracted corpus" rather than erroring.
func LoadActive(ctx context.Context, pool *db.Pool, tenantID string) (*Profile, error) {
	if pool == nil {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	p, err := loadActive(ctx, tx)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func loadActive(ctx context.Context, tx pgx.Tx) (*Profile, error) {
	var (
		p           Profile
		extractedAt *time.Time
	)
	err := tx.QueryRow(ctx, `
SELECT id::text, descriptors, writing_rules, sample_snippets, is_active,
       extracted_at, created_at, updated_at
  FROM brand_voice_profiles
 WHERE is_active
 LIMIT 1`,
	).Scan(&p.ID, &p.Descriptors, &p.WritingRules, &p.SampleSnippets,
		&p.IsActive, &extractedAt, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if extractedAt != nil {
		s := extractedAt.Format(time.RFC3339)
		p.ExtractedAt = &s
	}
	return &p, nil
}

/* ---------- handlers --------------------------------------------- */

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	p, err := loadActive(r.Context(), tx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if p == nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no active brand voice profile")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type putInput struct {
	Descriptors    []string `json:"descriptors"`
	WritingRules   []string `json:"writing_rules"`
	SampleSnippets []string `json:"sample_snippets"`
}

func (d *Deps) put(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in putInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	// Normalize: trim each entry, drop empties so the row doesn't
	// accumulate "" in the array on careless input.
	in.Descriptors = clean(in.Descriptors, maxDescriptorLen)
	in.WritingRules = clean(in.WritingRules, maxRuleChars)
	in.SampleSnippets = clean(in.SampleSnippets, maxSnippetChars)
	if msg := validate(in); msg != "" {
		httperror.WriteValidation(w, "validation_failed", msg)
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Upsert pattern: if an active row exists, UPDATE it; otherwise
	// INSERT. Single-active-row invariant enforced by the partial
	// unique index — we don't risk a race here because the whole
	// thing runs in one tenant tx with the index as backstop.
	existing, err := loadActive(r.Context(), tx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var (
		out         Profile
		extractedAt *time.Time
	)
	if existing != nil {
		err = tx.QueryRow(r.Context(), `
UPDATE brand_voice_profiles
   SET descriptors    = $2,
       writing_rules  = $3,
       sample_snippets = $4,
       updated_at     = now()
 WHERE id = $1::uuid
RETURNING id::text, descriptors, writing_rules, sample_snippets, is_active,
          extracted_at, created_at, updated_at`,
			existing.ID, in.Descriptors, in.WritingRules, in.SampleSnippets,
		).Scan(&out.ID, &out.Descriptors, &out.WritingRules, &out.SampleSnippets,
			&out.IsActive, &extractedAt, &out.CreatedAt, &out.UpdatedAt)
	} else {
		err = tx.QueryRow(r.Context(), `
INSERT INTO brand_voice_profiles (tenant_id, descriptors, writing_rules, sample_snippets, is_active)
VALUES ($1::uuid, $2, $3, $4, true)
RETURNING id::text, descriptors, writing_rules, sample_snippets, is_active,
          extracted_at, created_at, updated_at`,
			t.ID, in.Descriptors, in.WritingRules, in.SampleSnippets,
		).Scan(&out.ID, &out.Descriptors, &out.WritingRules, &out.SampleSnippets,
			&out.IsActive, &extractedAt, &out.CreatedAt, &out.UpdatedAt)
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if extractedAt != nil {
		s := extractedAt.Format(time.RFC3339)
		out.ExtractedAt = &s
	}
	writeJSON(w, http.StatusOK, out)
}

/* ---------- helpers --------------------------------------------- */

func clean(arr []string, maxLen int) []string {
	out := arr[:0]
	for _, s := range arr {
		t := strings.TrimSpace(s)
		if t == "" {
			continue
		}
		if len(t) > maxLen {
			t = t[:maxLen]
		}
		out = append(out, t)
	}
	return out
}

func validate(in putInput) string {
	if len(in.Descriptors) < 1 || len(in.Descriptors) > maxDescriptors {
		return fmt.Sprintf("descriptors must be 1..%d (got %d)", maxDescriptors, len(in.Descriptors))
	}
	if len(in.WritingRules) > maxWritingRules {
		return fmt.Sprintf("writing_rules must be 0..%d (got %d)", maxWritingRules, len(in.WritingRules))
	}
	if len(in.SampleSnippets) > maxSampleSnippets {
		return fmt.Sprintf("sample_snippets must be 0..%d (got %d)", maxSampleSnippets, len(in.SampleSnippets))
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
