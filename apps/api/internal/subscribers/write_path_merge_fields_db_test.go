// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
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

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newWritePathTestRepo(t *testing.T) (*Repo, *pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping subscriber write-path database tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier, custom_fields_mode)
VALUES ($1::uuid, 'write-path-test', $2, 'studio', 'strict')`,
		tenantID, "write-path-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO merge_field_schema
       (tenant_id, key, label, type, default_value, required, position)
VALUES ($1::uuid, 'FNAME', 'First name', 'text', '', false, 1),
       ($1::uuid, 'LNAME', 'Last name', 'text', '', false, 2),
       ($1::uuid, 'CITY',  'City',       'text', '', false, 3),
       ($1::uuid, 'AGE',   'Age',        'number', '', false, 4),
       ($1::uuid, 'REQ',   'Required',   'text', '', true, 5)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed merge schema: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_custom_fields (tenant_id, key, label, type)
VALUES ($1::uuid, 'favorite_color', 'Favorite color', 'string'),
       ($1::uuid, 'plan',           'Plan',           'string'),
       ($1::uuid, 'incoming_trait', 'Incoming trait', 'string'),
       ($1::uuid, 'age',            'Age',            'number'),
       ($1::uuid, 'phone',          'Phone',          'string')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed custom-field schema: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
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
	validator := &customfields.Validator{
		Repo: &customfields.Repo{Pool: pool},
		Mode: customfields.ModeStrict,
	}
	return &Repo{Pool: pool, CustomFields: validator}, pool, tenantID
}

func writePathCreate(email string, merge map[string]any) CreateInput {
	return CreateInput{
		Email:         email,
		Status:        StatusUnconfirmed,
		ConsentSource: ConsentUnknown,
		CustomFields:  map[string]any{},
		MergeFields:   merge,
	}
}

func tenantRequest(method, path, body, contentType, tenantID string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
}

func assertMergeFields(t *testing.T, repo *Repo, tenantID, email string, want map[string]any) *Subscriber {
	t.Helper()
	sub, err := repo.Get(context.Background(), tenantID, email)
	if err != nil {
		t.Fatalf("get %s: %v", email, err)
	}
	if fmt.Sprint(sub.MergeFields) != fmt.Sprint(want) {
		gotJSON, _ := json.Marshal(sub.MergeFields)
		wantJSON, _ := json.Marshal(want)
		if string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s merge_fields = %s; want %s", email, gotJSON, wantJSON)
		}
	}
	return sub
}

func TestRepoUpsertMergeFieldPresenceSchemaAuthorityAndDerivedNames(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "generic-" + uuid.NewString() + "@example.test"

	initial, err := repo.Upsert(ctx, tenantID, writePathCreate(email, map[string]any{
		"FNAME": "Ada", "LNAME": "Lovelace", "CITY": "London", "AGE": 36.0,
	}))
	if err != nil {
		t.Fatalf("initial strict-mode merge-field upsert: %v", err)
	}
	if initial.FirstName != "Ada" || initial.LastName != "Lovelace" || initial.FullName != "Ada Lovelace" {
		t.Fatalf("initial derived names = %q/%q/%q", initial.FirstName, initial.LastName, initial.FullName)
	}

	// Simulate a historical row whose materialized names were blank while its
	// canonical merge fields remained populated. An omitted write must derive
	// from the effective stored map rather than the empty request document.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("blank-name tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET first_name = '', last_name = '', full_name = '', display_name = ''
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, initial.ID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("blank historical names: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit historical names: %v", err)
	}

	omitted, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("omitted merge_fields upsert: %v", err)
	}
	if omitted.MergeFields["FNAME"] != "Ada" || omitted.MergeFields["CITY"] != "London" {
		t.Fatalf("omitted upsert wiped merge fields: %#v", omitted.MergeFields)
	}
	if omitted.FirstName != "Ada" || omitted.LastName != "Lovelace" || omitted.FullName != "Ada Lovelace" || omitted.DisplayName != "Ada Lovelace" {
		t.Fatalf("omitted upsert names = %q/%q/%q/%q; want names derived from stored merge fields",
			omitted.FirstName, omitted.LastName, omitted.FullName, omitted.DisplayName)
	}

	updated, err := repo.Upsert(ctx, tenantID, writePathCreate(email, map[string]any{"FNAME": "Grace"}))
	if err != nil {
		t.Fatalf("explicit merge-field update: %v", err)
	}
	if len(updated.MergeFields) != 1 || updated.MergeFields["FNAME"] != "Grace" || updated.FirstName != "Grace" {
		t.Fatalf("explicit update not applied: merge=%#v first=%q", updated.MergeFields, updated.FirstName)
	}

	cleared, err := repo.Upsert(ctx, tenantID, writePathCreate(email, map[string]any{}))
	if err != nil {
		t.Fatalf("explicit clear: %v", err)
	}
	if len(cleared.MergeFields) != 0 || cleared.FirstName != "" || cleared.FullName != "" {
		t.Fatalf("explicit clear did not clear merge/name materialization: merge=%#v first=%q full=%q",
			cleared.MergeFields, cleared.FirstName, cleared.FullName)
	}

	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(email, map[string]any{"AGE": "not-a-number"})); err == nil {
		t.Fatal("declared merge_field_schema number accepted invalid value")
	}
}

func TestBatchCSVAndBulkPastePreserveOmittedMergeFields(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	deps := &Deps{Repo: repo}
	ctx := context.Background()

	batchEmail := "batch-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(batchEmail, map[string]any{"FNAME": "Batch"})); err != nil {
		t.Fatalf("seed batch subscriber: %v", err)
	}
	batchBody := fmt.Sprintf(`{"subscribers":[{"email":%q}]}`, batchEmail)
	batchRec := httptest.NewRecorder()
	deps.BatchUpsert(batchRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/batch", batchBody, "application/json", tenantID))
	if batchRec.Code != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", batchRec.Code, batchRec.Body.String())
	}
	assertMergeFields(t, repo, tenantID, batchEmail, map[string]any{"FNAME": "Batch"})

	clearBody := fmt.Sprintf(`{"subscribers":[{"email":%q,"merge_fields":{}}]}`, batchEmail)
	clearRec := httptest.NewRecorder()
	deps.BatchUpsert(clearRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/batch", clearBody, "application/json", tenantID))
	if clearRec.Code != http.StatusOK {
		t.Fatalf("batch clear status=%d body=%s", clearRec.Code, clearRec.Body.String())
	}
	assertMergeFields(t, repo, tenantID, batchEmail, map[string]any{})

	csvEmail := "csv-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(csvEmail, map[string]any{"FNAME": "CSV"})); err != nil {
		t.Fatalf("seed CSV subscriber: %v", err)
	}
	csvRec := httptest.NewRecorder()
	deps.ImportCSV(csvRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/import", "email\n"+csvEmail+"\n", "text/csv", tenantID))
	if csvRec.Code != http.StatusOK {
		t.Fatalf("CSV status=%d body=%s", csvRec.Code, csvRec.Body.String())
	}
	assertMergeFields(t, repo, tenantID, csvEmail, map[string]any{"FNAME": "CSV"})

	pasteEmail := "paste-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(pasteEmail, map[string]any{"FNAME": "Paste"})); err != nil {
		t.Fatalf("seed paste subscriber: %v", err)
	}
	pasteRec := httptest.NewRecorder()
	pasteBody := fmt.Sprintf(`{"emails":%q}`, pasteEmail)
	deps.BulkPaste(pasteRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/bulk-paste", pasteBody, "application/json", tenantID))
	if pasteRec.Code != http.StatusOK {
		t.Fatalf("paste status=%d body=%s", pasteRec.Code, pasteRec.Body.String())
	}
	assertMergeFields(t, repo, tenantID, pasteEmail, map[string]any{"FNAME": "Paste"})
}

func TestIdentifyTraitsRemainSeparateAndMergesPreserveAudienceFields(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()

	createdEmail := "identify-new-" + uuid.NewString() + "@example.test"
	created, err := repo.Identify(ctx, tenantID, IdentifyInput{
		ExternalID: "new-" + uuid.NewString(),
		Email:      createdEmail,
		Traits:     map[string]any{"favorite_color": "violet"},
	})
	if err != nil {
		t.Fatalf("identify create: %v", err)
	}
	if created.Subscriber.CustomFields["favorite_color"] != "violet" || len(created.Subscriber.MergeFields) != 0 {
		t.Fatalf("identify create namespaces: custom=%#v merge=%#v",
			created.Subscriber.CustomFields, created.Subscriber.MergeFields)
	}

	existingEmail := "identify-existing-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(existingEmail, map[string]any{"FNAME": "Existing"})); err != nil {
		t.Fatalf("seed identify existing: %v", err)
	}
	updated, err := repo.Identify(ctx, tenantID, IdentifyInput{
		ExternalID: "existing-" + uuid.NewString(),
		Email:      existingEmail,
		Traits:     map[string]any{"plan": "pro"},
	})
	if err != nil {
		t.Fatalf("identify update: %v", err)
	}
	if updated.Subscriber.MergeFields["FNAME"] != "Existing" {
		t.Fatalf("identify update wiped merge fields: %#v", updated.Subscriber.MergeFields)
	}
	if _, copied := updated.Subscriber.MergeFields["plan"]; copied {
		t.Fatalf("identify trait copied into merge fields: %#v", updated.Subscriber.MergeFields)
	}

	primaryEmail := "identify-primary-" + uuid.NewString() + "@example.test"
	primaryExternal := "primary-" + uuid.NewString()
	if _, err := repo.Identify(ctx, tenantID, IdentifyInput{ExternalID: primaryExternal, Email: primaryEmail}); err != nil {
		t.Fatalf("seed primary identity: %v", err)
	}
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(primaryEmail, map[string]any{"FNAME": "Primary", "CITY": "Paris"})); err != nil {
		t.Fatalf("seed primary merge fields: %v", err)
	}
	duplicateEmail := "identify-duplicate-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(duplicateEmail, map[string]any{"FNAME": "Duplicate", "LNAME": "Person"})); err != nil {
		t.Fatalf("seed duplicate: %v", err)
	}
	primaryBefore, err := repo.Get(ctx, tenantID, primaryEmail)
	if err != nil {
		t.Fatalf("load primary merge revision: %v", err)
	}
	duplicateBefore, err := repo.Get(ctx, tenantID, duplicateEmail)
	if err != nil {
		t.Fatalf("load duplicate merge revision: %v", err)
	}
	merged, err := repo.Identify(ctx, tenantID, IdentifyInput{
		ExternalID: primaryExternal,
		Email:      duplicateEmail,
		Traits:     map[string]any{"incoming_trait": "custom-only"},
		SubscriberVersions: map[string]string{
			primaryBefore.ID:   primaryBefore.Version,
			duplicateBefore.ID: duplicateBefore.Version,
		},
	})
	if err != nil {
		t.Fatalf("identify merge: %v", err)
	}
	if merged.Action != "merged" {
		t.Fatalf("identify action = %q; want merged", merged.Action)
	}
	wantMerge := map[string]any{"FNAME": "Primary", "LNAME": "Person", "CITY": "Paris"}
	for key, want := range wantMerge {
		if got := merged.Subscriber.MergeFields[key]; got != want {
			t.Fatalf("merged field %s = %#v; want %#v (all=%#v)", key, got, want, merged.Subscriber.MergeFields)
		}
	}
	if _, copied := merged.Subscriber.MergeFields["incoming_trait"]; copied {
		t.Fatalf("merge copied incoming trait into audience fields: %#v", merged.Subscriber.MergeFields)
	}
}

func TestIdentifySafetyIdentityAndTraitContracts(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()

	email := "identify-safe-" + uuid.NewString() + "@example.test"
	created, err := repo.Identify(ctx, tenantID, IdentifyInput{
		Email:  email,
		Traits: map[string]any{"age": "42"},
	})
	if err != nil {
		t.Fatalf("identify safe create: %v", err)
	}
	if created.Action != "created" || created.Subscriber.Status != StatusUnconfirmed ||
		created.Subscriber.MailchimpStatus != "non_subscribed" ||
		created.Subscriber.ConsentTimestamp != nil || created.Subscriber.ConsentSource != ConsentUnknown {
		t.Fatalf("identify fabricated lifecycle/consent: %#v", created.Subscriber)
	}
	if got, ok := created.Subscriber.CustomFields["age"].(float64); !ok || got != 42 {
		t.Fatalf("declared number trait was not normalized: %#v", created.Subscriber.CustomFields)
	}

	invalidEmail := "identify-invalid-" + uuid.NewString() + "@example.test"
	_, err = repo.Identify(ctx, tenantID, IdentifyInput{
		Email: invalidEmail, Traits: map[string]any{"undeclared_private_trait": "secret"},
	})
	var unknownKey *customfields.ErrUnknownKey
	if !errors.As(err, &unknownKey) {
		t.Fatalf("undeclared strict trait err=%v; want ErrUnknownKey", err)
	}
	if _, getErr := repo.Get(ctx, tenantID, invalidEmail); !errors.Is(getErr, ErrNotFound) {
		t.Fatalf("invalid trait created subscriber: get err=%v", getErr)
	}
	_, err = repo.Identify(ctx, tenantID, IdentifyInput{
		Email:  "identify-type-" + uuid.NewString() + "@example.test",
		Traits: map[string]any{"age": "not-a-number"},
	})
	var mismatch *customfields.ErrTypeMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("invalid declared trait err=%v; want ErrTypeMismatch", err)
	}

	profileID := uuid.NewString()
	profileFirst, err := repo.Identify(ctx, tenantID, IdentifyInput{ProfileID: profileID})
	if err != nil {
		t.Fatalf("profile-only identify: %v", err)
	}
	profileAgain, err := repo.Identify(ctx, tenantID, IdentifyInput{ProfileID: strings.ToUpper(profileID)})
	if err != nil {
		t.Fatalf("profile-only identify repeat: %v", err)
	}
	if profileFirst.Subscriber.ID != profileAgain.Subscriber.ID || profileFirst.Subscriber.ProfileID != profileID {
		t.Fatalf("caller profile_id/idempotency lost: first=%#v again=%#v",
			profileFirst.Subscriber, profileAgain.Subscriber)
	}
	assertNonRoutableIdentifyEmail(t, profileFirst.Subscriber.Email)

	externalUpper, err := repo.Identify(ctx, tenantID, IdentifyInput{ExternalID: "CaseSensitiveExternal"})
	if err != nil {
		t.Fatalf("external upper identify: %v", err)
	}
	externalLower, err := repo.Identify(ctx, tenantID, IdentifyInput{ExternalID: "casesensitiveexternal"})
	if err != nil {
		t.Fatalf("external lower identify: %v", err)
	}
	externalRepeat, err := repo.Identify(ctx, tenantID, IdentifyInput{ExternalID: "CaseSensitiveExternal"})
	if err != nil {
		t.Fatalf("external repeat identify: %v", err)
	}
	if externalUpper.Subscriber.ID == externalLower.Subscriber.ID ||
		externalUpper.Subscriber.Email == externalLower.Subscriber.Email ||
		externalRepeat.Subscriber.ID != externalUpper.Subscriber.ID {
		t.Fatalf("external case identity/idempotency collapsed: upper=%#v lower=%#v repeat=%#v",
			externalUpper.Subscriber, externalLower.Subscriber, externalRepeat.Subscriber)
	}
	assertNonRoutableIdentifyEmail(t, externalUpper.Subscriber.Email)
	assertNonRoutableIdentifyEmail(t, externalLower.Subscriber.Email)
	claimedProfileID := uuid.NewString()
	profileClaim, err := repo.Identify(ctx, tenantID, IdentifyInput{
		ProfileID: claimedProfileID, ExternalID: "CaseSensitiveExternal",
	})
	if err != nil {
		t.Fatalf("claim caller profile_id on existing identity: %v", err)
	}
	if profileClaim.Subscriber.ID != externalUpper.Subscriber.ID || profileClaim.Subscriber.ProfileID != claimedProfileID {
		t.Fatalf("caller profile_id not persisted on existing identity: %#v", profileClaim.Subscriber)
	}

	anonymousUpper, err := repo.Identify(ctx, tenantID, IdentifyInput{AnonymousID: "CaseSensitiveAnonymous"})
	if err != nil {
		t.Fatalf("anonymous upper identify: %v", err)
	}
	anonymousLower, err := repo.Identify(ctx, tenantID, IdentifyInput{AnonymousID: "casesensitiveanonymous"})
	if err != nil {
		t.Fatalf("anonymous lower identify: %v", err)
	}
	anonymousRepeat, err := repo.Identify(ctx, tenantID, IdentifyInput{AnonymousID: "CaseSensitiveAnonymous"})
	if err != nil {
		t.Fatalf("anonymous repeat identify: %v", err)
	}
	if anonymousUpper.Subscriber.ID == anonymousLower.Subscriber.ID ||
		anonymousUpper.Subscriber.Email == anonymousLower.Subscriber.Email ||
		anonymousRepeat.Subscriber.ID != anonymousUpper.Subscriber.ID {
		t.Fatalf("anonymous case identity/idempotency collapsed: upper=%#v lower=%#v repeat=%#v",
			anonymousUpper.Subscriber, anonymousLower.Subscriber, anonymousRepeat.Subscriber)
	}
	assertNonRoutableIdentifyEmail(t, anonymousUpper.Subscriber.Email)
	assertNonRoutableIdentifyEmail(t, anonymousLower.Subscriber.Email)

	erasedEmail := "identify-erased-" + uuid.NewString() + "@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("erasure seed scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'test', '{"gdpr_erasure":true}'::jsonb)`, tenantID, erasedEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed identify erasure: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit identify erasure: %v", err)
	}
	if _, err := repo.Identify(ctx, tenantID, IdentifyInput{Email: erasedEmail}); !errors.Is(err, ErrErasureBlocked) {
		t.Fatalf("erased identify err=%v; want ErrErasureBlocked", err)
	}
}

func assertNonRoutableIdentifyEmail(t *testing.T, email string) {
	t.Helper()
	parts := strings.Split(email, "@")
	if len(parts) != 2 || parts[1] != "no-email.invalid" || len(parts[0]) > 64 || len(email) > 254 {
		t.Fatalf("identify placeholder is routable or out of bounds: %q", email)
	}
}

type writePathCountingEngine struct {
	findCalls   int
	createCalls int
	updateCalls int
	deleteCalls int
}

func (e *writePathCountingEngine) CreateSubscriber(context.Context, listmonk.CreateSubscriberReq) (*listmonk.Subscriber, error) {
	e.createCalls++
	return &listmonk.Subscriber{ID: 101}, nil
}

func (e *writePathCountingEngine) UpdateSubscriberStatus(context.Context, int64, listmonk.UpdateSubscriberStatusReq) error {
	e.updateCalls++
	return nil
}

func (e *writePathCountingEngine) FindSubscriberByEmail(context.Context, string) (*listmonk.Subscriber, error) {
	e.findCalls++
	return &listmonk.Subscriber{ID: 101}, nil
}

func (e *writePathCountingEngine) DeleteSubscriber(context.Context, int64) error {
	e.deleteCalls++
	return nil
}

func (e *writePathCountingEngine) assertNoCalls(t *testing.T) {
	t.Helper()
	if e.findCalls != 0 || e.createCalls != 0 || e.updateCalls != 0 || e.deleteCalls != 0 {
		t.Fatalf("external engine called before durable validation: find=%d create=%d update=%d delete=%d",
			e.findCalls, e.createCalls, e.updateCalls, e.deleteCalls)
	}
}

func TestPreflightRejectsInvalidMergeAndErasureBeforeExternalEngine(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()

	invalidEngine := &writePathCountingEngine{}
	deps := &Deps{Repo: repo, Engine: invalidEngine}
	invalidEmail := "invalid-" + uuid.NewString() + "@example.test"
	invalidBody := fmt.Sprintf(`{"email":%q,"merge_fields":{"AGE":"private-invalid-value"}}`, invalidEmail)
	invalidRec := httptest.NewRecorder()
	deps.Create(invalidRec, tenantRequest(http.MethodPost, "/api/v1/subscribers", invalidBody, "application/json", tenantID))
	if invalidRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid create status=%d body=%s", invalidRec.Code, invalidRec.Body.String())
	}
	invalidEngine.assertNoCalls(t)

	batchEngine := &writePathCountingEngine{}
	batchDeps := &Deps{Repo: repo, Engine: batchEngine}
	batchBody := fmt.Sprintf(`{"subscribers":[{"email":%q,"merge_fields":{"AGE":"private-invalid-value"}}]}`, "batch-invalid-"+uuid.NewString()+"@example.test")
	batchRec := httptest.NewRecorder()
	batchDeps.BatchUpsert(batchRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/batch", batchBody, "application/json", tenantID))
	if batchRec.Code != http.StatusOK || !strings.Contains(batchRec.Body.String(), `"error_code":"merge_field_validation_failed"`) {
		t.Fatalf("invalid batch status=%d body=%s", batchRec.Code, batchRec.Body.String())
	}
	if strings.Contains(batchRec.Body.String(), "private-invalid-value") {
		t.Fatalf("batch response leaked invalid value: %s", batchRec.Body.String())
	}
	batchEngine.assertNoCalls(t)

	updateEmail := "update-preflight-" + uuid.NewString() + "@example.test"
	seeded, err := repo.Upsert(ctx, tenantID, writePathCreate(updateEmail, map[string]any{"AGE": 42.0}))
	if err != nil {
		t.Fatalf("seed update preflight subscriber: %v", err)
	}
	updateEngine := &writePathCountingEngine{}
	updateDeps := &Deps{Repo: repo, Engine: updateEngine}
	router := chi.NewRouter()
	router.Patch("/api/v1/subscribers/{id}", updateDeps.Update)
	updateRec := httptest.NewRecorder()
	updateReq := tenantRequest(http.MethodPatch, "/api/v1/subscribers/"+seeded.ID,
		`{"status":"disabled","merge_fields":{"AGE":"private-invalid-value"}}`, "application/json", tenantID)
	updateReq.Header.Set("If-Match", httpcache.ConcurrencyToken("subscriber", seeded.ID, seeded.UpdatedAt))
	router.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid update status=%d body=%s", updateRec.Code, updateRec.Body.String())
	}
	updateEngine.assertNoCalls(t)

	missingRec := httptest.NewRecorder()
	missingReq := tenantRequest(http.MethodPatch, "/api/v1/subscribers/"+seeded.ID,
		`{"display_name":"must not apply"}`, "application/json", tenantID)
	router.ServeHTTP(missingRec, missingReq)
	if missingRec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing If-Match status=%d body=%s", missingRec.Code, missingRec.Body.String())
	}
	if !strings.Contains(missingRec.Body.String(), `"code":"precondition_required"`) {
		t.Fatalf("missing If-Match response lacks structured code: %s", missingRec.Body.String())
	}

	wildcardRec := httptest.NewRecorder()
	wildcardReq := tenantRequest(http.MethodPatch, "/api/v1/subscribers/"+seeded.ID,
		`{"display_name":"must not apply"}`, "application/json", tenantID)
	wildcardReq.Header.Set("If-Match", "*")
	router.ServeHTTP(wildcardRec, wildcardReq)
	if wildcardRec.Code != http.StatusPreconditionRequired {
		t.Fatalf("wildcard If-Match status=%d body=%s", wildcardRec.Code, wildcardRec.Body.String())
	}

	staleEngine := &writePathCountingEngine{}
	staleDeps := &Deps{Repo: repo, Engine: staleEngine}
	staleRouter := chi.NewRouter()
	staleRouter.Patch("/api/v1/subscribers/{id}", staleDeps.Update)
	staleRec := httptest.NewRecorder()
	staleReq := tenantRequest(http.MethodPatch, "/api/v1/subscribers/"+seeded.ID,
		`{"status":"disabled"}`, "application/json", tenantID)
	staleReq.Header.Set("If-Match", `"subscriber:`+seeded.ID+`:v0"`)
	staleRouter.ServeHTTP(staleRec, staleReq)
	if staleRec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale update status=%d body=%s", staleRec.Code, staleRec.Body.String())
	}
	staleEngine.assertNoCalls(t)
	unchanged, err := repo.Get(ctx, tenantID, seeded.ID)
	if err != nil {
		t.Fatalf("read subscriber after stale update: %v", err)
	}
	if unchanged.Status != seeded.Status {
		t.Fatalf("stale update changed local status=%q; want %q", unchanged.Status, seeded.Status)
	}

	// The route accepts either UUID or email selectors, but the concurrency
	// token is always bound to the canonical subscriber UUID. This previously
	// compared against the raw email path value and rejected a valid token.
	selectorRouter := chi.NewRouter()
	selectorRouter.Patch("/api/v1/subscribers/{id}", (&Deps{Repo: repo}).Update)
	selectorRec := httptest.NewRecorder()
	selectorReq := tenantRequest(http.MethodPatch, "/api/v1/subscribers/"+seeded.Email,
		`{"display_name":"Email selector update"}`, "application/json", tenantID)
	selectorReq.Header.Set("If-Match", httpcache.ConcurrencyToken("subscriber", seeded.ID, seeded.UpdatedAt))
	selectorRouter.ServeHTTP(selectorRec, selectorReq)
	if selectorRec.Code != http.StatusOK {
		t.Fatalf("email selector update status=%d body=%s", selectorRec.Code, selectorRec.Body.String())
	}
	var selectorUpdated Subscriber
	if err := json.Unmarshal(selectorRec.Body.Bytes(), &selectorUpdated); err != nil {
		t.Fatalf("decode email selector update: %v", err)
	}
	if selectorUpdated.ID != seeded.ID || selectorUpdated.DisplayName != "Email selector update" {
		t.Fatalf("email selector update returned %+v", selectorUpdated)
	}
	if selectorUpdated.Version == "" || selectorRec.Header().Get("ETag") != selectorUpdated.Version {
		t.Fatalf("email selector response version body=%q header=%q", selectorUpdated.Version, selectorRec.Header().Get("ETag"))
	}

	requiredEmail := "required-" + uuid.NewString() + "@example.test"
	if _, err := repo.Upsert(ctx, tenantID, writePathCreate(requiredEmail, map[string]any{"REQ": "present"})); err != nil {
		t.Fatalf("seed required merge field: %v", err)
	}
	requiredEngine := &writePathCountingEngine{}
	requiredDeps := &Deps{Repo: repo, Engine: requiredEngine}
	requiredRec := httptest.NewRecorder()
	requiredBody := fmt.Sprintf(`{"email":%q,"merge_fields":{}}`, requiredEmail)
	requiredDeps.Create(requiredRec, tenantRequest(http.MethodPost, "/api/v1/subscribers", requiredBody, "application/json", tenantID))
	if requiredRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("required-field clear status=%d body=%s", requiredRec.Code, requiredRec.Body.String())
	}
	requiredEngine.assertNoCalls(t)
	assertMergeFields(t, repo, tenantID, requiredEmail, map[string]any{"REQ": "present"})

	erasedEmail := "erased-" + uuid.NewString() + "@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("erasure seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'test', '{"gdpr_erasure":true}'::jsonb)`, tenantID, erasedEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed erasure suppression: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit erasure suppression: %v", err)
	}
	erasureEngine := &writePathCountingEngine{}
	erasureDeps := &Deps{Repo: repo, Engine: erasureEngine}
	erasureRec := httptest.NewRecorder()
	erasureBody := fmt.Sprintf(`{"email":%q}`, erasedEmail)
	erasureDeps.Create(erasureRec, tenantRequest(http.MethodPost, "/api/v1/subscribers", erasureBody, "application/json", tenantID))
	if erasureRec.Code != http.StatusConflict || !strings.Contains(erasureRec.Body.String(), "erasure_blocked") {
		t.Fatalf("erasure create status=%d body=%s", erasureRec.Code, erasureRec.Body.String())
	}
	erasureEngine.assertNoCalls(t)
}
