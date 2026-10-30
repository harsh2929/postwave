// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMailchimpPatchMergeFieldPresenceRoundTrip(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Mailchimp member merge-field database test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	slug := "mailchimp-write-" + strings.ReplaceAll(tenantID, "-", "")
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'mailchimp-write-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO merge_field_schema
       (tenant_id, key, label, type, default_value, required, position)
VALUES ($1::uuid, 'FNAME', 'First name', 'text', '', false, 1),
       ($1::uuid, 'CITY', 'City', 'text', '', false, 2)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed merge schema: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr == nil {
			_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = cleanupTx.Commit(cleanupCtx)
		}
	})

	repo := &Repo{Pool: pool}
	tenant := &middleware.Tenant{ID: tenantID, Slug: slug, Name: "mailchimp-write-test", Tier: "studio"}
	email := "member-" + uuid.NewString() + "@example.test"

	created, err := repo.CreateMember(ctx, tenant, slug, MemberInput{
		EmailAddress: email,
		Status:       "pending",
		MergeFields:  map[string]any{"FNAME": "Ada", "CITY": "London"},
		Interests:    map[string]bool{"interest-a": true},
	})
	if err != nil {
		t.Fatalf("initial member upsert: %v", err)
	}
	if created.MergeFields["FNAME"] != "Ada" || created.MergeFields["CITY"] != "London" {
		t.Fatalf("initial merge fields = %#v", created.MergeFields)
	}
	if created.Status != "pending" || !created.Interests["interest-a"] {
		t.Fatalf("initial status/interests = %q/%#v", created.Status, created.Interests)
	}

	// PATCH body omitted merge_fields: keep the canonical audience profile.
	omitted, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		Status:       "pending",
	})
	if err != nil {
		t.Fatalf("omitted merge_fields patch: %v", err)
	}
	if omitted.MergeFields["FNAME"] != "Ada" || omitted.MergeFields["CITY"] != "London" {
		t.Fatalf("omitted patch wiped merge fields: %#v", omitted.MergeFields)
	}
	if omitted.Status != "pending" || !omitted.Interests["interest-a"] {
		t.Fatalf("omitted patch changed status/interests: %q/%#v", omitted.Status, omitted.Interests)
	}

	updated, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		Status:       "pending",
		MergeFields:  map[string]any{"FNAME": "Grace"},
	})
	if err != nil {
		t.Fatalf("explicit member update: %v", err)
	}
	if len(updated.MergeFields) != 1 || updated.MergeFields["FNAME"] != "Grace" {
		t.Fatalf("explicit member update = %#v", updated.MergeFields)
	}
	if updated.Status != "pending" || !updated.Interests["interest-a"] {
		t.Fatalf("merge-only patch changed status/interests: %q/%#v", updated.Status, updated.Interests)
	}

	clearedInterests, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		Interests:    map[string]bool{},
	})
	if err != nil {
		t.Fatalf("explicit interests clear: %v", err)
	}
	if len(clearedInterests.Interests) != 0 || clearedInterests.Status != "pending" {
		t.Fatalf("explicit interests clear = status %q interests %#v", clearedInterests.Status, clearedInterests.Interests)
	}

	unsubscribed, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		Status:       "unsubscribed",
	})
	if err != nil {
		t.Fatalf("explicit status update: %v", err)
	}
	if unsubscribed.Status != "unsubscribed" {
		t.Fatalf("explicit status update = %q", unsubscribed.Status)
	}
	statusIfNewOnly, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		StatusIfNew:  "subscribed",
	})
	if err != nil {
		t.Fatalf("status_if_new-only existing patch: %v", err)
	}
	if statusIfNewOnly.Status != "unsubscribed" {
		t.Fatalf("status_if_new resubscribed existing member: %q", statusIfNewOnly.Status)
	}

	cleared, err := repo.UpdateMember(ctx, tenant, slug, email, MemberInput{
		EmailAddress: email,
		Status:       "pending",
		MergeFields:  map[string]any{},
	})
	if err != nil {
		t.Fatalf("explicit member clear: %v", err)
	}
	if len(cleared.MergeFields) != 0 {
		t.Fatalf("explicit member clear = %#v; want empty", cleared.MergeFields)
	}

	erasedEmail := "erased-" + uuid.NewString() + "@example.test"
	erasureTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("erasure seed scope: %v", err)
	}
	if _, err = erasureTx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'test', '{"gdpr_erasure":true}'::jsonb)`, tenantID, erasedEmail); err != nil {
		_ = erasureTx.Rollback(ctx)
		t.Fatalf("seed erasure suppression: %v", err)
	}
	if err = erasureTx.Commit(ctx); err != nil {
		t.Fatalf("commit erasure suppression: %v", err)
	}
	if _, err = repo.CreateMember(ctx, tenant, slug, MemberInput{
		EmailAddress: erasedEmail,
		Status:       "pending",
	}); err != ErrErasureBlocked {
		t.Fatalf("erased member error = %v; want ErrErasureBlocked", err)
	}
	// A privacy request removes the plaintext and leaves only SHA-256-keyed
	// tombstones (privacy/erasure.go); the compatibility API must honour them
	// exactly as it honours a contact delete.
	privacyErasedEmail := "privacy-erased-" + uuid.NewString() + "@example.test"
	privacyDigest := sha256.Sum256([]byte(privacyErasedEmail))
	privacyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("privacy erasure seed scope: %v", err)
	}
	if _, err := privacyTx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
VALUES ($1::uuid, $2::citext, $3, 'dsar_deletion', 'manual')`,
		tenantID, "erased+"+uuid.NewString()[:8]+"@erased.invalid", hex.EncodeToString(privacyDigest[:])); err != nil {
		_ = privacyTx.Rollback(ctx)
		t.Fatalf("seed privacy tombstone: %v", err)
	}
	if err := privacyTx.Commit(ctx); err != nil {
		t.Fatalf("commit privacy tombstone: %v", err)
	}
	if _, err := repo.CreateMember(ctx, tenant, slug, MemberInput{
		EmailAddress: privacyErasedEmail,
		Status:       "pending",
	}); err != ErrErasureBlocked {
		t.Fatalf("privacy-erased member error = %v; want ErrErasureBlocked", err)
	}
	safeRotationEmail := "safe-rotation-" + uuid.NewString() + "@example.test"
	if _, err := repo.CreateMember(ctx, tenant, slug, MemberInput{
		EmailAddress: safeRotationEmail,
		Status:       "pending",
	}); err != nil {
		t.Fatalf("seed safe rotation target: %v", err)
	}

	deps := &Deps{Store: repo}
	router := chi.NewRouter()
	router.Patch("/lists/{list_id}/members/{subscriber_hash}", deps.UpsertMember)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPatch,
		fmt.Sprintf("/lists/%s/members/%s", slug, safeRotationEmail),
		strings.NewReader(fmt.Sprintf(`{"email_address":%q,"status":"pending"}`, erasedEmail)))
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(request.Context(), tenant))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict ||
		!strings.Contains(recorder.Body.String(), "permanently erased by a contact deletion or privacy request") ||
		strings.Contains(strings.ToLower(recorder.Body.String()), "unblock") {
		t.Fatalf("erased PATCH status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestMailchimpMemberSafeCreateAndAuthoritativeTargetRotation(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Mailchimp member identity database test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	slug := "mailchimp-identity-" + strings.ReplaceAll(tenantID, "-", "")
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'mailchimp-identity-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr == nil {
			_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = cleanupTx.Commit(cleanupCtx)
		}
	})

	repo := &Repo{Pool: pool}
	tenant := &middleware.Tenant{ID: tenantID, Slug: slug, Name: "mailchimp-identity-test", Tier: "studio"}
	omittedEmail := "omitted-" + uuid.NewString() + "@example.test"
	omitted, err := repo.CreateMember(ctx, tenant, slug, MemberInput{EmailAddress: omittedEmail})
	if err != nil {
		t.Fatalf("create without status: %v", err)
	}
	if omitted.Status != "non_subscribed" || omitted.TimestampOpt != nil || omitted.TimestampSignup != nil {
		t.Fatalf("omitted create projection status/timestamps=%q/%v/%v",
			omitted.Status, omitted.TimestampOpt, omitted.TimestampSignup)
	}
	checkTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("consent check scope: %v", err)
	}
	var storedStatus, storedMailchimpStatus, consentSource string
	var consentAt *time.Time
	if err := checkTx.QueryRow(ctx, `
SELECT status, mailchimp_status, consent_timestamp, consent_source
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, tenantID, omittedEmail).
		Scan(&storedStatus, &storedMailchimpStatus, &consentAt, &consentSource); err != nil {
		_ = checkTx.Rollback(ctx)
		t.Fatalf("query omitted create: %v", err)
	}
	if err := checkTx.Commit(ctx); err != nil {
		t.Fatalf("commit omitted check: %v", err)
	}
	if storedStatus != "unconfirmed" || storedMailchimpStatus != "non_subscribed" || consentAt != nil || consentSource != "unknown" {
		t.Fatalf("omitted create stored lifecycle=%q/%q/%v/%q",
			storedStatus, storedMailchimpStatus, consentAt, consentSource)
	}

	targetEmail := "target-" + uuid.NewString() + "@example.test"
	otherEmail := "other-" + uuid.NewString() + "@example.test"
	target, err := repo.CreateMember(ctx, tenant, slug, MemberInput{EmailAddress: targetEmail, Status: "pending"})
	if err != nil {
		t.Fatalf("create target: %v", err)
	}
	other, err := repo.CreateMember(ctx, tenant, slug, MemberInput{EmailAddress: otherEmail, Status: "pending"})
	if err != nil {
		t.Fatalf("create other: %v", err)
	}
	if _, err := repo.UpdateMember(ctx, tenant, slug, target.ID, MemberInput{EmailAddress: otherEmail}); !errors.Is(err, ErrConflict) {
		t.Fatalf("body email redirected target update: err=%v; want ErrConflict", err)
	}
	unchangedTarget, err := repo.GetMember(ctx, tenant, slug, target.ID)
	if err != nil || unchangedTarget.ContactID != target.ContactID || unchangedTarget.EmailAddress != targetEmail {
		t.Fatalf("target changed after conflict: member=%#v err=%v", unchangedTarget, err)
	}
	unchangedOther, err := repo.GetMember(ctx, tenant, slug, other.ID)
	if err != nil || unchangedOther.ContactID != other.ContactID || unchangedOther.EmailAddress != otherEmail {
		t.Fatalf("other member changed after conflict: member=%#v err=%v", unchangedOther, err)
	}

	eventTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("rotation event seed scope: %v", err)
	}
	if _, err := eventTx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type)
VALUES ($1::uuid, $2, 'opened')`, tenantID, targetEmail); err != nil {
		_ = eventTx.Rollback(ctx)
		t.Fatalf("seed target event: %v", err)
	}
	if err := eventTx.Commit(ctx); err != nil {
		t.Fatalf("commit target event: %v", err)
	}

	rotatedEmail := "rotated-" + uuid.NewString() + "@example.test"
	rotated, err := repo.UpdateMember(ctx, tenant, slug, target.ID, MemberInput{EmailAddress: rotatedEmail})
	if err != nil {
		t.Fatalf("rotate target: %v", err)
	}
	if rotated.ContactID != target.ContactID || rotated.EmailAddress != rotatedEmail {
		t.Fatalf("rotation changed identity: before=%#v after=%#v", target, rotated)
	}
	if _, err := repo.GetMember(ctx, tenant, slug, target.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old target hash lookup err=%v; want ErrNotFound", err)
	}
	byNewHash, err := repo.GetMember(ctx, tenant, slug, rotated.ID)
	if err != nil || byNewHash.ContactID != target.ContactID {
		t.Fatalf("new target lookup member=%#v err=%v", byNewHash, err)
	}
	identityTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("identity check scope: %v", err)
	}
	var rowCount, rotatedEventCount int
	var primaryEmail, addressEmail string
	var isPrimary bool
	if err := identityTx.QueryRow(ctx, `
SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&rowCount); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("count subscribers: %v", err)
	}
	if err := identityTx.QueryRow(ctx, `
SELECT primary_email::text FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, target.ContactID).Scan(&primaryEmail); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("query primary email: %v", err)
	}
	if err := identityTx.QueryRow(ctx, `
SELECT email::text, is_primary FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND is_primary`, tenantID, target.ContactID).
		Scan(&addressEmail, &isPrimary); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("query primary address: %v", err)
	}
	if err := identityTx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)`, tenantID, rotatedEmail).
		Scan(&rotatedEventCount); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("query rotated events: %v", err)
	}
	if err := identityTx.Commit(ctx); err != nil {
		t.Fatalf("commit identity check: %v", err)
	}
	if rowCount != 3 || primaryEmail != rotatedEmail || addressEmail != rotatedEmail || !isPrimary || rotatedEventCount != 1 {
		t.Fatalf("rotation persisted count/primary/address/is_primary/events=%d/%q/%q/%v/%d",
			rowCount, primaryEmail, addressEmail, isPrimary, rotatedEventCount)
	}
}
