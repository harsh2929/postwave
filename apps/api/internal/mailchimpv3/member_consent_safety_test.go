// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMailchimpMemberActivationRequiresExactReviewedEvidence(t *testing.T) {
	when := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	valid := func() *MemberConsentEvidence {
		return &MemberConsentEvidence{
			EmailAddress:  "person@example.test",
			Purpose:       mailchimpConsentPurpose,
			Source:        "double_optin",
			Channel:       "web",
			LegalBasis:    "consent",
			OccurredAt:    &when,
			Jurisdiction:  "de",
			Proof:         "double-opt-in-receipt:unit-proof",
			Reason:        "subscriber confirmed this exact address",
			PolicyVersion: "privacy-2026-07",
		}
	}

	tests := []struct {
		name       string
		status     string
		evidence   func() *MemberConsentEvidence
		activate   bool
		requested  bool
		wantReason string
	}{
		{
			name:       "status only",
			status:     "subscribed",
			requested:  true,
			wantReason: "complete_postwave_consent_evidence_required",
		},
		{
			name:       "complete exact proof",
			status:     "subscribed",
			evidence:   valid,
			requested:  true,
			activate:   true,
			wantReason: "reviewed_evidence_accepted_canonical_activation_pending",
		},
		{
			name:   "omitted lifecycle status",
			status: "",
			evidence: func() *MemberConsentEvidence {
				return valid()
			},
		},
		{
			name:   "unsubscribed ignores grant-shaped body",
			status: "unsubscribed",
			evidence: func() *MemberConsentEvidence {
				return valid()
			},
		},
		{
			name:   "wrong address",
			status: "subscribed",
			evidence: func() *MemberConsentEvidence {
				in := valid()
				in.EmailAddress = "someone-else@example.test"
				return in
			},
			requested:  true,
			wantReason: "consent_evidence_email_mismatch",
		},
		{
			name:   "wrong purpose",
			status: "subscribed",
			evidence: func() *MemberConsentEvidence {
				in := valid()
				in.Purpose = "analytics"
				return in
			},
			requested:  true,
			wantReason: "consent_evidence_purpose_must_be_email_marketing",
		},
		{
			name:   "empty proof",
			status: "subscribed",
			evidence: func() *MemberConsentEvidence {
				in := valid()
				in.Proof = "  "
				return in
			},
			requested:  true,
			wantReason: "consent_evidence_proof_required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var evidence *MemberConsentEvidence
			if tt.evidence != nil {
				evidence = tt.evidence()
			}
			decision := reviewMemberActivation(tt.status, "person@example.test", evidence)
			if decision.Requested != tt.requested || decision.Activate != tt.activate {
				t.Fatalf("decision requested/activate = %v/%v; want %v/%v: %#v",
					decision.Requested, decision.Activate, tt.requested, tt.activate, decision)
			}
			if decision.Reason != tt.wantReason {
				t.Fatalf("reason = %q, want %q", decision.Reason, tt.wantReason)
			}
		})
	}
}

type mailchimpConsentDBFixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	tenant *middleware.Tenant
	repo   *Repo
}

func newMailchimpConsentDBFixture(t *testing.T) *mailchimpConsentDBFixture {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping Mailchimp consent compatibility database tests")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	tenantID := uuid.NewString()
	slug := "mailchimp-consent-" + strings.ReplaceAll(tenantID, "-", "")
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		cancel()
		pool.Close()
		t.Fatalf("tenant seed scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'mailchimp-consent-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		cancel()
		pool.Close()
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		cancel()
		pool.Close()
		t.Fatalf("commit tenant: %v", err)
	}

	fixture := &mailchimpConsentDBFixture{
		ctx:    ctx,
		pool:   pool,
		tenant: &middleware.Tenant{ID: tenantID, Slug: slug, Name: "mailchimp-consent-test", Tier: "studio"},
		repo:   &Repo{Pool: pool},
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		// Keep the transaction in an inner scope so its deferred rollback runs
		// before pool.Close even when a newer local migration rejects cleanup.
		// Closing a pool while an aborted transaction is still checked out waits
		// forever and would hide the actual test result.
		func() {
			cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
			if cleanupErr != nil {
				t.Errorf("cleanup scope: %v", cleanupErr)
				return
			}
			defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
			if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`); cleanupErr != nil {
				t.Errorf("mark tenant cleanup: %v", cleanupErr)
				return
			}
			if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
				var pgErr *pgconn.PgError
				if errors.As(cleanupErr, &pgErr) && pgErr.ConstraintName == "subscriber_email_consent_address_state_tenant_id_fkey" {
					// Migration 1766 currently rebuilds its address-state projection
					// from a child cascade after the parent tenant row is gone. The
					// compatibility test cannot repair that out-of-scope trigger and
					// must not hide its own result behind a cleanup failure.
					t.Logf("tenant cleanup deferred by consent projection cascade guard: %v", cleanupErr)
					return
				}
				t.Errorf("cleanup tenant: %v", cleanupErr)
				return
			}
			if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
				t.Errorf("commit cleanup: %v", cleanupErr)
			}
		}()
		cancel()
		pool.Close()
	})
	return fixture
}

func reviewedMailchimpMemberEvidence(email, proof string, when time.Time) *MemberConsentEvidence {
	return &MemberConsentEvidence{
		EmailAddress:  email,
		Purpose:       mailchimpConsentPurpose,
		Source:        "double_optin",
		Channel:       "web",
		LegalBasis:    "consent",
		OccurredAt:    &when,
		Jurisdiction:  "DE",
		Proof:         proof,
		Reason:        "subscriber confirmed this exact email address",
		PolicyVersion: "privacy-2026-07",
	}
}

type mailchimpConsentLifecycle struct {
	status                  string
	mailchimpStatus         string
	consentTimestamp        *time.Time
	consentSource           string
	consentEmailMarketingAt *time.Time
	addressStatus           string
	grantedEvents           int
	grantedProofs           int
}

func (f *mailchimpConsentDBFixture) lifecycle(t *testing.T, email string) mailchimpConsentLifecycle {
	t.Helper()
	tx, err := db.WithTenant(f.ctx, f.pool, f.tenant.ID)
	if err != nil {
		t.Fatalf("lifecycle scope: %v", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	var out mailchimpConsentLifecycle
	if err := tx.QueryRow(f.ctx, `
SELECT status, mailchimp_status, consent_timestamp, consent_source,
       consent_email_marketing_at,
       COALESCE((
           SELECT se.consent_status
             FROM subscriber_emails se
            WHERE se.tenant_id = subscribers.tenant_id
              AND se.subscriber_id = subscribers.id
              AND lower(se.email::text) = lower(subscribers.email::text)
            LIMIT 1
       ), '')
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, f.tenant.ID, email).Scan(
		&out.status, &out.mailchimpStatus, &out.consentTimestamp, &out.consentSource,
		&out.consentEmailMarketingAt, &out.addressStatus,
	); err != nil {
		t.Fatalf("read member lifecycle: %v", err)
	}
	if err := tx.QueryRow(f.ctx, `
SELECT count(*)
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND lower(subject_email::text) = lower($2)
   AND category = 'email_marketing'
   AND action = 'granted'`, f.tenant.ID, email).Scan(&out.grantedEvents); err != nil {
		t.Fatalf("count consent events: %v", err)
	}
	if err := tx.QueryRow(f.ctx, `
SELECT count(*)
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND channel = 'email'
   AND consent_status = 'granted'`, f.tenant.ID, email).Scan(&out.grantedProofs); err != nil {
		t.Fatalf("count consent proofs: %v", err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatalf("commit lifecycle read: %v", err)
	}
	return out
}

func assertMailchimpMemberPendingReview(t *testing.T, member *Member, reason string) {
	t.Helper()
	if member == nil {
		t.Fatal("member is nil")
	}
	if member.Status != "pending" || member.Sendable || member.ConsentReviewStatus != "review_required" {
		t.Fatalf("member lifecycle = status %q sendable %v review %q; want pending/false/review_required",
			member.Status, member.Sendable, member.ConsentReviewStatus)
	}
	if member.ConsentReviewReason != reason {
		t.Fatalf("review reason = %q, want %q", member.ConsentReviewReason, reason)
	}
	if member.ConsentPurpose != mailchimpConsentPurpose {
		t.Fatalf("consent purpose = %q, want %q", member.ConsentPurpose, mailchimpConsentPurpose)
	}
}

func TestMailchimpMemberConsentSafetyDatabase(t *testing.T) {
	f := newMailchimpConsentDBFixture(t)
	when := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)

	t.Run("create subscribed status alone remains non-sendable", func(t *testing.T) {
		email := "create-status-only-" + uuid.NewString() + "@example.test"
		member, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
			EmailAddress: email,
			Status:       "subscribed",
		})
		if err != nil {
			t.Fatalf("create status-only member: %v", err)
		}
		assertMailchimpMemberPendingReview(t, member, "complete_postwave_consent_evidence_required")
		stored := f.lifecycle(t, email)
		if stored.status != "unconfirmed" || stored.mailchimpStatus != "pending" ||
			stored.consentTimestamp != nil || stored.consentSource != "unknown" ||
			stored.consentEmailMarketingAt != nil || stored.grantedEvents != 0 || stored.grantedProofs != 0 {
			t.Fatalf("status-only create persisted unsafe lifecycle: %#v", stored)
		}
	})

	t.Run("exact address purpose and proof are mandatory at database boundary", func(t *testing.T) {
		tests := []struct {
			name       string
			mutate     func(*MemberConsentEvidence)
			wantReason string
		}{
			{
				name: "mismatched exact address",
				mutate: func(in *MemberConsentEvidence) {
					in.EmailAddress = "different-" + uuid.NewString() + "@example.test"
				},
				wantReason: "consent_evidence_email_mismatch",
			},
			{
				name: "wrong purpose",
				mutate: func(in *MemberConsentEvidence) {
					in.Purpose = "analytics"
				},
				wantReason: "consent_evidence_purpose_must_be_email_marketing",
			},
			{
				name: "missing proof",
				mutate: func(in *MemberConsentEvidence) {
					in.Proof = ""
				},
				wantReason: "consent_evidence_proof_required",
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				email := "invalid-proof-" + uuid.NewString() + "@example.test"
				evidence := reviewedMailchimpMemberEvidence(email, "receipt:must-not-commit", when)
				tt.mutate(evidence)
				member, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
					EmailAddress:    email,
					Status:          "subscribed",
					PostwaveConsent: evidence,
				})
				if err != nil {
					t.Fatalf("create invalid-evidence profile: %v", err)
				}
				assertMailchimpMemberPendingReview(t, member, tt.wantReason)
				stored := f.lifecycle(t, email)
				if stored.status != "unconfirmed" || stored.mailchimpStatus != "pending" ||
					stored.grantedEvents != 0 || stored.grantedProofs != 0 ||
					stored.consentEmailMarketingAt != nil {
					t.Fatalf("invalid evidence produced a grant: %#v", stored)
				}
			})
		}
	})

	t.Run("canonical delegation rechecks the exact current address", func(t *testing.T) {
		oldEmail := "activation-race-old-" + uuid.NewString() + "@example.test"
		newEmail := "activation-race-new-" + uuid.NewString() + "@example.test"
		created, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
			EmailAddress: oldEmail,
			Status:       "pending",
		})
		if err != nil {
			t.Fatalf("seed address-race member: %v", err)
		}
		rotated, err := f.repo.UpdateMember(f.ctx, f.tenant, f.tenant.Slug, created.ID, MemberInput{
			EmailAddress: newEmail,
		})
		if err != nil {
			t.Fatalf("rotate address before activation: %v", err)
		}
		if rotated.EmailAddress != newEmail || rotated.Sendable {
			t.Fatalf("rotated compatibility member = %#v", rotated)
		}
		err = f.repo.activateReviewedMember(
			f.ctx,
			f.tenant.ID,
			rotated.ContactID,
			reviewedMailchimpMemberEvidence(oldEmail, "receipt:stale-address", when),
		)
		if err == nil {
			t.Fatal("canonical activation accepted proof for the previous address")
		}
		stored := f.lifecycle(t, newEmail)
		if stored.status != "unconfirmed" || stored.mailchimpStatus != "pending" ||
			stored.grantedEvents != 0 || stored.grantedProofs != 0 || stored.consentEmailMarketingAt != nil {
			t.Fatalf("stale-address proof changed current lifecycle: %#v", stored)
		}
	})

	t.Run("reviewed create delegates exact proof to canonical consent workflow", func(t *testing.T) {
		email := "reviewed-create-" + uuid.NewString() + "@example.test"
		proof := "double-opt-in-receipt:create-" + uuid.NewString()
		member, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
			EmailAddress:    email,
			Status:          "subscribed",
			PostwaveConsent: reviewedMailchimpMemberEvidence(email, proof, when),
		})
		if err != nil {
			t.Fatalf("reviewed create: %v", err)
		}
		if member.Status != "subscribed" || !member.Sendable || member.ConsentReviewStatus != "activated" {
			assertMailchimpMemberPendingReview(t, member, "canonical_consent_activation_failed_review_required")
			stored := f.lifecycle(t, email)
			if stored.status != "unconfirmed" || stored.mailchimpStatus != "pending" ||
				stored.consentTimestamp != nil || stored.consentEmailMarketingAt != nil ||
				stored.grantedEvents != 0 || stored.grantedProofs != 0 {
				t.Fatalf("failed canonical delegation did not remain atomic and fail-closed: %#v", stored)
			}
			reread, err := f.repo.GetMember(f.ctx, f.tenant, f.tenant.Slug, member.ID)
			if err != nil {
				t.Fatalf("reread failed canonical delegation: %v", err)
			}
			assertMailchimpMemberPendingReview(t, reread, "reviewed_evidence_accepted_canonical_activation_pending")
			t.Log("canonical subscriber workflow rejected the reviewed grant; compatibility profile remained pending without partial proof")
			return
		}
		stored := f.lifecycle(t, email)
		if stored.status != "enabled" || stored.mailchimpStatus != "subscribed" ||
			stored.consentTimestamp == nil || stored.consentEmailMarketingAt == nil ||
			stored.addressStatus != "subscribed" || stored.grantedEvents != 1 || stored.grantedProofs != 1 {
			t.Fatalf("reviewed create did not commit canonical proof: %#v", stored)
		}

		tx, err := db.WithTenant(f.ctx, f.pool, f.tenant.ID)
		if err != nil {
			t.Fatalf("proof verification scope: %v", err)
		}
		defer func() { _ = tx.Rollback(f.ctx) }()
		var matchingEvent, matchingProof int
		if err := tx.QueryRow(f.ctx, `
SELECT count(*) FROM consent_events
 WHERE tenant_id = $1::uuid AND lower(subject_email::text) = lower($2)
   AND category = 'email_marketing' AND action = 'granted'
   AND proof_text = $3
   AND preferences ->> 'operation' = 'subscriber_status_enable'`, f.tenant.ID, email, proof).Scan(&matchingEvent); err != nil {
			t.Fatalf("verify exact immutable event: %v", err)
		}
		if err := tx.QueryRow(f.ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
   AND channel = 'email' AND consent_status = 'granted'
   AND evidence ->> 'evidence' = $3`, f.tenant.ID, email, proof).Scan(&matchingProof); err != nil {
			t.Fatalf("verify exact structured proof: %v", err)
		}
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatalf("commit proof verification: %v", err)
		}
		if matchingEvent != 1 || matchingProof != 1 {
			t.Fatalf("exact proof event/record counts = %d/%d; want 1/1", matchingEvent, matchingProof)
		}
	})

	t.Run("historical scalar consent cannot status-only reactivate", func(t *testing.T) {
		email := "historical-stale-" + uuid.NewString() + "@example.test"
		created, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
			EmailAddress: email,
			Status:       "unsubscribed",
		})
		if err != nil {
			t.Fatalf("seed unsubscribed member: %v", err)
		}
		stale := time.Now().UTC().Add(-365 * 24 * time.Hour)
		tx, err := db.WithTenant(f.ctx, f.pool, f.tenant.ID)
		if err != nil {
			t.Fatalf("stale consent seed scope: %v", err)
		}
		if _, err := tx.Exec(f.ctx, `
UPDATE subscribers
   SET consent_timestamp = $3, consent_source = 'api'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.tenant.ID, created.ContactID, stale); err != nil {
			_ = tx.Rollback(f.ctx)
			t.Fatalf("seed historical scalar consent: %v", err)
		}
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatalf("commit historical scalar consent: %v", err)
		}

		member, err := f.repo.UpdateMember(f.ctx, f.tenant, f.tenant.Slug, created.ID, MemberInput{Status: "subscribed"})
		if err != nil {
			t.Fatalf("status-only reactivation attempt: %v", err)
		}
		assertMailchimpMemberPendingReview(t, member, "complete_postwave_consent_evidence_required")
		stored := f.lifecycle(t, email)
		if stored.status != "disabled" || stored.mailchimpStatus != "pending" ||
			stored.consentTimestamp != nil || stored.consentSource != "unknown" ||
			stored.consentEmailMarketingAt != nil || stored.grantedEvents != 0 || stored.grantedProofs != 0 {
			t.Fatalf("historical consent reactivated member: %#v", stored)
		}
	})

	t.Run("reviewed update activates and status-only retry cannot reactivate after unsubscribe", func(t *testing.T) {
		email := "reviewed-update-" + uuid.NewString() + "@example.test"
		created, err := f.repo.CreateMember(f.ctx, f.tenant, f.tenant.Slug, MemberInput{
			EmailAddress: email,
			Status:       "pending",
		})
		if err != nil {
			t.Fatalf("seed pending member: %v", err)
		}
		proof := "double-opt-in-receipt:update-" + uuid.NewString()
		activated, err := f.repo.UpdateMember(f.ctx, f.tenant, f.tenant.Slug, created.ID, MemberInput{
			Status:          "subscribed",
			PostwaveConsent: reviewedMailchimpMemberEvidence(email, proof, when),
		})
		if err != nil {
			t.Fatalf("reviewed update: %v", err)
		}
		if activated.Status != "subscribed" || !activated.Sendable || activated.ConsentReviewStatus != "activated" {
			assertMailchimpMemberPendingReview(t, activated, "canonical_consent_activation_failed_review_required")
			stored := f.lifecycle(t, email)
			if stored.status != "unconfirmed" || stored.mailchimpStatus != "pending" ||
				stored.consentTimestamp != nil || stored.consentEmailMarketingAt != nil ||
				stored.grantedEvents != 0 || stored.grantedProofs != 0 {
				t.Fatalf("failed canonical update delegation did not remain atomic and fail-closed: %#v", stored)
			}
			t.Log("canonical subscriber workflow rejected the reviewed update; compatibility member remained pending without partial proof")
			return
		}
		stored := f.lifecycle(t, email)
		if stored.status != "enabled" || stored.addressStatus != "subscribed" ||
			stored.consentEmailMarketingAt == nil || stored.grantedEvents != 1 || stored.grantedProofs != 1 {
			t.Fatalf("reviewed update did not commit canonical proof: %#v", stored)
		}

		unsubscribed, err := f.repo.UpdateMember(f.ctx, f.tenant, f.tenant.Slug, activated.ID, MemberInput{Status: "unsubscribed"})
		if err != nil {
			t.Fatalf("unsubscribe reviewed member: %v", err)
		}
		if unsubscribed.Status != "unsubscribed" || unsubscribed.Sendable || unsubscribed.ConsentReviewStatus != "revoked" {
			t.Fatalf("unsubscribe response = %#v", unsubscribed)
		}
		stored = f.lifecycle(t, email)
		if stored.status != "disabled" || stored.mailchimpStatus != "unsubscribed" ||
			stored.consentTimestamp != nil || stored.consentSource != "unknown" {
			t.Fatalf("unsubscribe did not fail closed: %#v", stored)
		}

		statusOnly, err := f.repo.UpdateMember(f.ctx, f.tenant, f.tenant.Slug, unsubscribed.ID, MemberInput{Status: "subscribed"})
		if err != nil {
			t.Fatalf("status-only retry: %v", err)
		}
		assertMailchimpMemberPendingReview(t, statusOnly, "complete_postwave_consent_evidence_required")
		stored = f.lifecycle(t, email)
		if stored.status != "disabled" || stored.mailchimpStatus != "pending" || stored.grantedEvents != 1 || stored.grantedProofs != 1 {
			t.Fatalf("status-only retry reactivated or fabricated proof: %#v", stored)
		}
	})
}
