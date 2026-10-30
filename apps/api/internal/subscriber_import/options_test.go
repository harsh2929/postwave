// SPDX-License-Identifier: AGPL-3.0-only
//
// A11 coverage: the wizard's job-level options (consent provenance,
// tags, auto_create_properties) — PATCH validation round-trip, tag
// merging at import time, the consent_records proof shape, and the
// auto-create-property key derivation. DB-backed paths follow the
// package convention (pure helpers locked here, e2e covers SQL).

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"

	migratecsv "github.com/postwave/migrate/csv"
)

// --- PATCH validation round-trip ------------------------------------

func TestValidatePatch_RoundTrip(t *testing.T) {
	body := `{
		"on_existing": "update",
		"consent_source": " signed_form ",
		"consent_source_url": "https://example.com/signup",
		"consent_captured_at": "2026-06-01T12:30:00Z",
		"consent_legal_basis": "consent",
		"consent_jurisdiction": "gb",
		"consent_reason": "The signed signup form explicitly covered marketing email.",
		"consent_policy_version": "privacy-2026-06",
		"consent_evidence_reference": "receipt:CONSENT-123",
		"consent_scope": "email_marketing",
		"consent_scope_acknowledged": true,
		"tags": ["vip", "spring-2026", "vip"],
		"auto_create_properties": true
	}`
	var in patchInput
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	pv, verr := validatePatch(in)
	if verr != nil {
		t.Fatalf("validate: %s (%s)", verr.msg, verr.code)
	}
	if pv.ConsentSource == nil || *pv.ConsentSource != "signed_form" {
		t.Errorf("consent_source: %v", pv.ConsentSource)
	}
	if pv.ConsentSourceURL == nil || *pv.ConsentSourceURL != "https://example.com/signup" {
		t.Errorf("consent_source_url: %v", pv.ConsentSourceURL)
	}
	want := time.Date(2026, 6, 1, 12, 30, 0, 0, time.UTC)
	if pv.ConsentCapturedAt == nil || !pv.ConsentCapturedAt.Equal(want) {
		t.Errorf("consent_captured_at: %v", pv.ConsentCapturedAt)
	}
	// Tags deduped, order preserved.
	if len(pv.Tags) != 2 || pv.Tags[0] != "vip" || pv.Tags[1] != "spring-2026" {
		t.Errorf("tags: %v", pv.Tags)
	}
	if pv.AutoCreateProps == nil || !*pv.AutoCreateProps {
		t.Errorf("auto_create_properties: %v", pv.AutoCreateProps)
	}
}

func TestValidatePatch_AbsentFieldsStayUntouched(t *testing.T) {
	var in patchInput
	if err := json.Unmarshal([]byte(`{"mapping": null}`), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	pv, verr := validatePatch(in)
	if verr != nil {
		t.Fatalf("validate: %v", verr)
	}
	if pv.ConsentSource != nil || pv.ConsentSourceURL != nil ||
		pv.ConsentCapturedAt != nil || pv.ConsentPatchPresent || pv.ClearConsentContract ||
		pv.Tags != nil || pv.AutoCreateProps != nil {
		t.Errorf("absent fields must stay nil/untouched: %+v", pv)
	}
}

func TestValidatePatch_ExplicitEmptyClears(t *testing.T) {
	body := `{"consent_scope_acknowledged": false, "tags": []}`
	var in patchInput
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	pv, verr := validatePatch(in)
	if verr != nil {
		t.Fatalf("validate: %v", verr)
	}
	if !pv.ConsentPatchPresent || !pv.ClearConsentContract {
		t.Errorf("negative scope acknowledgement should atomically clear the contract: %+v", pv)
	}
	if pv.Tags == nil || len(pv.Tags) != 0 {
		t.Errorf("explicit [] should clear tags (non-nil empty): %v", pv.Tags)
	}
}

func TestValidatePatch_Rejections(t *testing.T) {
	str := func(v string) *string { return &v }
	boolean := func(v bool) *bool { return &v }
	valid := func() patchInput {
		return patchInput{
			ConsentSource:            str("signed_form"),
			ConsentSourceURL:         str("https://example.com/signup"),
			ConsentCapturedAt:        str("2026-06-01T12:30:00Z"),
			ConsentLegalBasis:        str("consent"),
			ConsentJurisdiction:      str("GB"),
			ConsentReason:            str("The signed form explicitly covered marketing email."),
			ConsentPolicyVersion:     str("privacy-2026-06"),
			ConsentEvidenceReference: str("receipt:CONSENT-123"),
			ConsentScope:             str("email_marketing"),
			ConsentScopeAcknowledged: boolean(true),
		}
	}
	cases := []struct {
		name  string
		input patchInput
		code  string
	}{
		{name: "bad timestamp", input: func() patchInput { in := valid(); in.ConsentCapturedAt = str("yesterday"); return in }(), code: "invalid_consent_captured_at"},
		{name: "future timestamp", input: func() patchInput { in := valid(); in.ConsentCapturedAt = str("2999-01-01T00:00:00Z"); return in }(), code: "future_consent_captured_at"},
		{name: "relative url", input: func() patchInput { in := valid(); in.ConsentSourceURL = str("/signup"); return in }(), code: "invalid_consent_source_url"},
		{name: "secret url", input: func() patchInput {
			in := valid()
			in.ConsentSourceURL = str("https://example.com/signup?access_token=secret")
			return in
		}(), code: "invalid_consent_source_url"},
		{name: "source is import, not evidence", input: func() patchInput { in := valid(); in.ConsentSource = str("csv_import"); return in }(), code: "invalid_consent_source"},
		{name: "wrong legal basis", input: func() patchInput { in := valid(); in.ConsentLegalBasis = str("legitimate_interest"); return in }(), code: "invalid_consent_legal_basis"},
		{name: "unsafe evidence reference", input: func() patchInput {
			in := valid()
			in.ConsentEvidenceReference = str("https://example.com/receipt?token=secret")
			return in
		}(), code: "invalid_consent_evidence_reference"},
		{name: "wrong scope", input: func() patchInput { in := valid(); in.ConsentScope = str("all"); return in }(), code: "invalid_consent_scope"},
		{name: "incomplete", input: patchInput{ConsentSource: str("signed_form")}, code: "incomplete_consent_contract"},
		{name: "empty tag", input: patchInput{Tags: []string{"ok", "  "}}, code: "invalid_tags"},
		{name: "too many tags", input: patchInput{Tags: func() []string {
			out := make([]string, MaxImportTags+1)
			for i := range out {
				out[i] = fmt.Sprintf("tag-%d", i)
			}
			return out
		}()}, code: "invalid_tags"},
		{name: "tag too long", input: patchInput{Tags: []string{strings.Repeat("x", MaxTagLength+1)}}, code: "invalid_tags"},
	}
	for _, c := range cases {
		_, verr := validatePatch(c.input)
		if verr == nil {
			t.Errorf("%s: expected rejection", c.name)
			continue
		}
		if verr.code != c.code {
			t.Errorf("%s: code %q want %q", c.name, verr.code, c.code)
		}
	}
}

func manyTagsJSON(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = fmt.Sprintf("%q", fmt.Sprintf("tag-%d", i))
	}
	return strings.Join(parts, ",")
}

// Handler-level: invalid payloads are rejected with a 400 BEFORE any
// DB access (nil pool stays untouched), proving validation gates the
// persistence path.
func TestPatchHandler_RejectsInvalidBeforeDB(t *testing.T) {
	d := &Deps{Pool: nil}
	r := chi.NewRouter()
	r.Patch("/api/v1/subscriber-imports/{id}", d.Patch)

	for _, body := range []string{
		`{"consent_captured_at": "not-a-time"}`,
		`{"tags": [""]}`,
		`{"consent_source_url": "notaurl"}`,
		`{"on_existing": "merge"}`,
	} {
		req := httptest.NewRequest(http.MethodPatch,
			"/api/v1/subscriber-imports/11111111-1111-1111-1111-111111111111",
			bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(context.Background(),
			&middleware.Tenant{ID: "22222222-2222-2222-2222-222222222222"}))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d want 400 (%s)", body, rec.Code, rec.Body.String())
		}
	}
}

// --- tags applied on import -----------------------------------------

func TestMergeTags_AppendsAndDedupes(t *testing.T) {
	got, err := mergeTags([]string{"vip", "churned"}, []string{"spring-2026", "vip"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"vip", "churned", "spring-2026"}
	if len(got) != len(want) {
		t.Fatalf("merged: %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("merged order: %v want %v", got, want)
		}
	}
}

func TestMergeTags_JobTagsOnRowsWithoutTagColumn(t *testing.T) {
	// Job-level tags must land even when the CSV has no tags column.
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
	}}
	fields, err := buildRowFields([]string{"a@b.com"}, m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := mergeTags(fields.Tags, []string{"imported-2026"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "imported-2026" {
		t.Fatalf("job tags should apply: %v", got)
	}
}

// --- consent rows written -------------------------------------------

func TestProofInput_Shape(t *testing.T) {
	captured := time.Date(2026, 6, 1, 12, 30, 0, 0, time.UTC)
	o := importOptions{
		ConsentSource: "signed_form", ConsentSourceURL: "https://example.com/landing",
		ConsentCapturedAt: &captured, ConsentLegalBasis: "consent",
		ConsentJurisdiction: "GB", ConsentReason: "Signed form covered marketing email.",
		ConsentPolicyVersion: "privacy-2026-06", ConsentEvidenceReference: "receipt:CONSENT-123",
		ConsentScope: ImportConsentScope, ConsentScopeAcknowledged: true,
		ConsentContractVersion: ImportConsentContractVersion,
	}
	in := o.proofInput(
		"tenant-1", "import-1", "approval-1", "subscriber-1", "a@b.com",
		strings.Repeat("b", 64), strings.Repeat("c", 64),
	)
	if in.TenantID != "tenant-1" || in.SubscriberID != "subscriber-1" || in.Email != "a@b.com" {
		t.Fatalf("identity drifted: %+v", in)
	}
	if in.ConsentStatus != "granted" || in.Channel != "email" {
		t.Errorf("status/channel: %s/%s", in.ConsentStatus, in.Channel)
	}
	if in.Source != "form" {
		t.Errorf("source: %s", in.Source)
	}
	if in.SourceURL != "" {
		t.Errorf("per-subscriber proof must not duplicate the reviewed approval URL: %s", in.SourceURL)
	}
	if !in.CapturedAt.Equal(captured) {
		t.Errorf("captured_at: %v", in.CapturedAt)
	}
	if in.Evidence["import_id"] != "import-1" || in.Evidence["approval_id"] != "approval-1" ||
		in.Evidence["source_row_fingerprint"] != strings.Repeat("b", 64) ||
		in.Evidence["evidence_fingerprint"] != strings.Repeat("c", 64) {
		t.Errorf("evidence: %v", in.Evidence)
	}
	if _, duplicated := in.Evidence["consent_source_raw"]; duplicated {
		t.Errorf("normalized approval evidence must not be duplicated per subscriber: %v", in.Evidence)
	}
}

func TestHasConsent(t *testing.T) {
	if (importOptions{}).hasConsent() {
		t.Error("empty options must not write proof rows")
	}
	ts := time.Now()
	for i, o := range []importOptions{
		{ConsentSource: "manual"},
		{ConsentSourceURL: "https://x.example"},
		{ConsentCapturedAt: &ts},
		{ConsentSource: "unknown", ConsentSourceURL: "https://x.example", ConsentCapturedAt: &ts},
	} {
		if o.hasConsent() {
			t.Errorf("case %d: partial or unknown proof must not establish consent", i)
		}
	}
	complete := importOptions{
		ConsentSource: "double_optin", ConsentSourceURL: "https://x.example/receipt/123",
		ConsentCapturedAt: &ts, ConsentLegalBasis: "consent", ConsentJurisdiction: "GB",
		ConsentReason: "Double opt-in confirmation received.", ConsentPolicyVersion: "privacy-v1",
		ConsentEvidenceReference: "receipt:CONSENT-123", ConsentScope: ImportConsentScope,
		ConsentScopeAcknowledged: true, ConsentContractVersion: ImportConsentContractVersion,
	}
	if !complete.hasConsent() {
		t.Error("complete source, evidence URL, and capture time should establish consent")
	}
	status, source, captured := complete.subscriberStatusAndConsent()
	if status != "enabled" || source != "double_optin" || captured != &ts {
		t.Fatalf("complete proof mapping = %q/%q/%v", status, source, captured)
	}
	status, source, captured = (importOptions{ConsentSource: "double_optin"}).subscriberStatusAndConsent()
	if status != "unconfirmed" || source != "unknown" || captured != nil {
		t.Fatalf("partial proof must fail closed, got %q/%q/%v", status, source, captured)
	}
}

// proofSource must only ever emit members of the consent_records
// CHECK enum (0248) — anything else fails the INSERT at the DB.
func TestProofSource_AlwaysInEnum(t *testing.T) {
	enum := map[string]bool{
		"form": true, "double_optin": true, "single_optin": true,
		"api": true, "import": true, "admin": true,
		"preference_center": true, "one_click": true,
		"webhook": true, "unknown": true,
	}
	inputs := []string{
		"", "csv_import", "signup_form", "manual", "double_optin",
		"api", "form", "totally made up", "preference_center",
	}
	for _, in := range inputs {
		if got := proofSource(in); !enum[got] {
			t.Errorf("proofSource(%q) = %q not in enum", in, got)
		}
	}
	// Pass-through + alias pinning.
	if proofSource("double_optin") != "double_optin" {
		t.Error("enum value must pass through")
	}
	if proofSource("signup_form") != "form" || proofSource("manual") != "admin" ||
		proofSource("csv_import") != "import" {
		t.Error("wizard aliases drifted")
	}
}

// subscriberConsentSource must only emit members of the narrower
// subscribers.consent_source CHECK set (0003).
func TestSubscriberConsentSource_AlwaysInEnum(t *testing.T) {
	enum := map[string]bool{
		"double_optin": true, "single_optin": true,
		"import": true, "api": true, "unknown": true,
	}
	for _, in := range []string{"", "csv_import", "signup_form", "manual", "double_optin", "api", "junk"} {
		if got := subscriberConsentSource(in); !enum[got] {
			t.Errorf("subscriberConsentSource(%q) = %q not in enum", in, got)
		}
	}
	if subscriberConsentSource("double_optin") != "double_optin" ||
		subscriberConsentSource("signup_form") != "import" {
		t.Error("mapping drifted")
	}
}

// --- auto-create property path --------------------------------------

func TestPropertyCandidatesFromMapping(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "Plan", Kind: migratecsv.KindCustom, CustomKey: "plan"},
		{Index: 2, Name: "company_size", Kind: migratecsv.KindCustom},            // fallback to Name
		{Index: 3, Name: "Full Name", Kind: migratecsv.KindName},                 // → "name"
		{Index: 4, Name: "Bad Key!", Kind: migratecsv.KindCustom},                // invalid → skipped
		{Index: 5, Name: "plan", Kind: migratecsv.KindCustom, CustomKey: "plan"}, // dup → skipped
		{Index: 6, Name: "tags", Kind: migratecsv.KindTags},                      // not a property
	}}
	got := propertyCandidatesFromMapping(m)
	want := map[string]string{"plan": "Plan", "company_size": "company_size"}
	if len(got) != len(want) {
		t.Fatalf("candidates: %+v", got)
	}
	for _, c := range got {
		if want[c.Key] != c.Label {
			t.Errorf("candidate %q label %q want %q", c.Key, c.Label, want[c.Key])
		}
	}
}

func TestValidPropertyKey(t *testing.T) {
	valid := []string{"plan", "company_size", "a", "k9", "x_1"}
	invalid := []string{"", "Plan", "9lives", "_lead", "has space", "kéy",
		strings.Repeat("a", 65)}
	for _, k := range valid {
		if !validPropertyKey(k) {
			t.Errorf("%q should be valid", k)
		}
	}
	for _, k := range invalid {
		if validPropertyKey(k) {
			t.Errorf("%q should be invalid", k)
		}
	}
}

// ensureCustomProperties with no candidates (or nil pool) is a no-op
// — guards the inline path when auto_create_properties is on but the
// mapping has no custom columns.
func TestEnsureCustomProperties_NoCandidatesNoop(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
	}}
	if err := ensureCustomProperties(context.Background(), nil, "tenant-1", m); err != nil {
		t.Fatalf("no-candidate mapping must noop: %v", err)
	}
}

// --- SUB-102: per-column mapping override validation -----------------

func mappingWithHeaders(cols []migratecsv.ColumnMapping) migratecsv.Mapping {
	headers := make([]string, len(cols))
	for i, col := range cols {
		headers[i] = col.Name
	}
	return migratecsv.Mapping{Headers: headers, Columns: cols}
}

func TestValidateMappingOverride_AcceptsValid(t *testing.T) {
	known := map[string]struct{}{"plan": {}}
	m := mappingWithHeaders([]migratecsv.ColumnMapping{
		{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "Full Name", Kind: migratecsv.KindName},
		{Index: 2, Name: "Groups", Kind: migratecsv.KindTags},
		{Index: 3, Name: "Plan", Kind: migratecsv.KindCustom, CustomKey: "plan"}, // registered
		{Index: 4, Name: "company_size", Kind: migratecsv.KindCustom},            // new, valid key via Name
		{Index: 5, Name: "Notes", Kind: migratecsv.KindIgnore},                   // skip column
	})
	if verr := validateMappingOverride(m, known); verr != nil {
		t.Fatalf("expected valid mapping, got %s (%s)", verr.msg, verr.code)
	}
}

func TestValidateMappingOverride_Rejections(t *testing.T) {
	known := map[string]struct{}{}
	cases := []struct {
		name string
		cols []migratecsv.ColumnMapping
		code string
	}{
		{
			name: "unknown kind",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
				{Index: 1, Name: "X", Kind: migratecsv.FieldKind("zip_code")},
			},
			code: "invalid_mapping_kind",
		},
		{
			name: "no email column",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Name", Kind: migratecsv.KindName},
			},
			code: "no_email_column",
		},
		{
			name: "two email columns",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Primary", Kind: migratecsv.KindEmail},
				{Index: 1, Name: "Secondary", Kind: migratecsv.KindEmail},
			},
			code: "multiple_email_columns",
		},
		{
			name: "invalid custom key",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
				{Index: 1, Name: "Bad Key!", Kind: migratecsv.KindCustom},
			},
			code: "invalid_custom_key",
		},
		{
			name: "duplicate singleton target",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
				{Index: 1, Name: "First", Kind: migratecsv.KindName},
				{Index: 2, Name: "Display", Kind: migratecsv.KindName},
			},
			code: "duplicate_mapping_targets",
		},
		{
			name: "duplicate custom target",
			cols: []migratecsv.ColumnMapping{
				{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
				{Index: 1, Name: "Company", Kind: migratecsv.KindCustom, CustomKey: "company"},
				{Index: 2, Name: "Organisation", Kind: migratecsv.KindCustom, CustomKey: "COMPANY"},
			},
			code: "duplicate_mapping_targets",
		},
	}
	for _, c := range cases {
		verr := validateMappingOverride(mappingWithHeaders(c.cols), known)
		if verr == nil {
			t.Errorf("%s: expected rejection", c.name)
			continue
		}
		if verr.code != c.code {
			t.Errorf("%s: code %q want %q", c.name, verr.code, c.code)
		}
	}
}

func TestValidateMappingTargets_ReportsEveryConflictAndSource(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "First", Kind: migratecsv.KindName},
		{Index: 2, Name: "Display", Kind: migratecsv.KindName},
		{Index: 3, Name: "Company", Kind: migratecsv.KindCustom, CustomKey: "company"},
		{Index: 4, Name: "Organisation", Kind: migratecsv.KindCustom, CustomKey: "COMPANY"},
	}}
	verr := validateMappingTargets(m)
	if verr == nil || verr.code != "duplicate_mapping_targets" {
		t.Fatalf("expected duplicate_mapping_targets, got %#v", verr)
	}
	for _, want := range []string{"name", "First", "Display", `custom field "company"`, "Company", "Organisation"} {
		if !strings.Contains(verr.msg, want) {
			t.Errorf("message %q does not identify %q", verr.msg, want)
		}
	}
}

// Registry history cannot bypass canonical key syntax; otherwise dry-run,
// auto-create and execution would validate/write different JSON keys.
func TestValidateMappingOverride_RegisteredMalformedKeyStillFails(t *testing.T) {
	known := map[string]struct{}{"legacy key with spaces": {}}
	m := mappingWithHeaders([]migratecsv.ColumnMapping{
		{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "Legacy", Kind: migratecsv.KindCustom, CustomKey: "legacy key with spaces"},
	})
	if verr := validateMappingOverride(m, known); verr == nil || verr.code != "invalid_custom_key" {
		t.Fatalf("registered malformed key must fail: %#v", verr)
	}
}

// CustomKey falls back to the (lowercased) column Name when empty, matching
// buildRowFields. A column named "Plan" with no CustomKey maps onto "plan".
func TestValidateMappingOverride_CustomKeyFallsBackToName(t *testing.T) {
	known := map[string]struct{}{"plan": {}}
	m := mappingWithHeaders([]migratecsv.ColumnMapping{
		{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "Plan", Kind: migratecsv.KindCustom}, // no CustomKey
	})
	if verr := validateMappingOverride(m, known); verr != nil {
		t.Fatalf("Name fallback to registered key should pass: %s", verr.msg)
	}
}

// Handler-level: a PATCH carrying an invalid per-column mapping override is
// rejected with 400 BEFORE any DB access (nil pool stays untouched), proving
// the SUB-102 validation gates the persistence path. knownCustomKeys with a
// nil pool returns an empty set, so the syntactic/email checks still run.
func TestPatchHandler_RejectsInvalidMappingBeforeDB(t *testing.T) {
	d := &Deps{Pool: nil}
	r := chi.NewRouter()
	r.Patch("/api/v1/subscriber-imports/{id}", d.Patch)

	bodies := []string{
		// no email column
		`{"mapping":{"columns":[{"index":0,"name":"Name","kind":"name"}]}}`,
		// two email columns
		`{"mapping":{"columns":[{"index":0,"name":"A","kind":"email"},{"index":1,"name":"B","kind":"email"}]}}`,
		// unknown kind
		`{"mapping":{"columns":[{"index":0,"name":"A","kind":"email"},{"index":1,"name":"Zip","kind":"postal_code"}]}}`,
		// invalid custom key (unregistered + bad syntax)
		`{"mapping":{"columns":[{"index":0,"name":"A","kind":"email"},{"index":1,"name":"Bad Key!","kind":"custom"}]}}`,
		// two non-email columns mapped onto one singleton target
		`{"mapping":{"columns":[{"index":0,"name":"A","kind":"email"},{"index":1,"name":"First","kind":"name"},{"index":2,"name":"Display","kind":"name"}]}}`,
		// normalized custom keys collide
		`{"mapping":{"columns":[{"index":0,"name":"A","kind":"email"},{"index":1,"name":"Company","kind":"custom","custom_key":"company"},{"index":2,"name":"Organisation","kind":"custom","custom_key":"COMPANY"}]}}`,
	}
	for _, body := range bodies {
		req := httptest.NewRequest(http.MethodPatch,
			"/api/v1/subscriber-imports/11111111-1111-1111-1111-111111111111",
			bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(context.Background(),
			&middleware.Tenant{ID: "22222222-2222-2222-2222-222222222222"}))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d want 400 (%s)", body, rec.Code, rec.Body.String())
		}
	}
}
