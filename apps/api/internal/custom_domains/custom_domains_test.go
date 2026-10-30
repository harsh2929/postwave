package custom_domains

// Tests for custom_domains. The Repo methods need postgres; we cover
// the validation branches in Create + the Resolver-driven verify
// flow against a stub DNS resolver.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// stubResolver lets us drive checkRecords without real DNS.
type stubResolver struct {
	cnames map[string]string
	txts   map[string][]string
	err    error
}

func (s *stubResolver) LookupCNAME(_ context.Context, host string) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	v, ok := s.cnames[host]
	if !ok {
		return "", errors.New("no such host")
	}
	return v, nil
}
func (s *stubResolver) LookupTXT(_ context.Context, host string) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	v, ok := s.txts[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	return v, nil
}

type stubDomainStore struct {
	createResult *Domain
	createErr    error
	createCalls  int
	createdName  string
	createdUse   Purpose
	createdDNS   []DNSRecord

	listResult []Domain
	listErr    error
	getResult  *Domain
	getErr     error
	getCalls   int

	updateErr      error
	updateCalls    int
	updatedRecords []DNSRecord
	updatedCurrent bool

	deleteErr     error
	deleteCalls   int
	deletedTenant string
	deletedDomain string
}

func (s *stubDomainStore) Create(_ context.Context, _ string, domain string, purpose Purpose, records []DNSRecord) (*Domain, error) {
	s.createCalls++
	s.createdName = domain
	s.createdUse = purpose
	s.createdDNS = append([]DNSRecord(nil), records...)
	if s.createErr != nil {
		return nil, s.createErr
	}
	if s.createResult != nil {
		return s.createResult, nil
	}
	return &Domain{ID: "domain-1", Domain: domain, Purpose: purpose, DNSRecords: records}, nil
}

func (s *stubDomainStore) List(_ context.Context, _ string) ([]Domain, error) {
	return s.listResult, s.listErr
}

func (s *stubDomainStore) Get(_ context.Context, _ string, _ string) (*Domain, error) {
	s.getCalls++
	return s.getResult, s.getErr
}

func (s *stubDomainStore) UpdateVerification(_ context.Context, _ string, _ string, records []DNSRecord, verified bool) error {
	s.updateCalls++
	s.updatedRecords = append([]DNSRecord(nil), records...)
	s.updatedCurrent = verified
	if s.updateErr != nil {
		return s.updateErr
	}
	if s.getResult != nil {
		s.getResult.DNSRecords = append([]DNSRecord(nil), records...)
		s.getResult.Verified = verified
		if verified {
			now := time.Now()
			s.getResult.VerifiedAt = &now
		} else {
			s.getResult.VerifiedAt = nil
		}
	}
	return nil
}

func (s *stubDomainStore) Delete(_ context.Context, tenantID string, id string) error {
	s.deleteCalls++
	s.deletedTenant = tenantID
	s.deletedDomain = id
	return s.deleteErr
}

func tenantRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	return req
}

func withRouteID(req *http.Request, id string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}

// TestCheckRecords_AllPresent — both CNAME + TXT match → true.
func TestCheckRecords_AllPresent(t *testing.T) {
	res := &stubResolver{
		cnames: map[string]string{"forms.example.com": "edge.moosewave.com."},
		txts: map[string][]string{
			"_postwave-verify.forms.example.com": {"pw-verify=tok"},
		},
	}
	records := []DNSRecord{
		{Type: "CNAME", Name: "forms.example.com", Value: "edge.moosewave.com"},
		{Type: "TXT", Name: "_postwave-verify.forms.example.com", Value: "pw-verify=tok"},
	}
	results, ok := checkRecords(context.Background(), res, records)
	if !ok {
		t.Error("checkRecords returned false; want true")
	}
	for _, rec := range results {
		if !rec.Verified || rec.Error != "" {
			t.Fatalf("record = %+v, want verified with no error", rec)
		}
	}
}

// TestCheckRecords_MissingTXT — TXT lookup fails → false.
func TestCheckRecords_MissingTXT(t *testing.T) {
	res := &stubResolver{
		cnames: map[string]string{"forms.example.com": "edge.moosewave.com."},
	}
	records := []DNSRecord{
		{Type: "CNAME", Name: "forms.example.com", Value: "edge.moosewave.com"},
		{Type: "TXT", Name: "_postwave-verify.forms.example.com", Value: "pw-verify=tok"},
	}
	results, ok := checkRecords(context.Background(), res, records)
	if ok {
		t.Error("missing TXT should return false")
	}
	if results[0].Verified != true {
		t.Fatalf("CNAME result = %+v, want verified", results[0])
	}
	if results[1].Verified != false || !strings.Contains(results[1].Error, "TXT lookup") {
		t.Fatalf("TXT result = %+v, want lookup error", results[1])
	}
}

func TestCanonicalizeHostname(t *testing.T) {
	t.Parallel()

	valid := map[string]string{
		" Mail.Example.COM ": "mail.example.com",
		"a-b.c9.example":     "a-b.c9.example",
		"0.example":          "0.example",
	}
	for input, want := range valid {
		input, want := input, want
		t.Run("valid_"+want, func(t *testing.T) {
			t.Parallel()
			got, err := canonicalizeHostname(input)
			if err != nil || got != want {
				t.Fatalf("canonicalizeHostname(%q) = %q, %v; want %q, nil", input, got, err, want)
			}
		})
	}

	longestRegistrable := strings.Join([]string{
		strings.Repeat("a", 63),
		strings.Repeat("b", 63),
		strings.Repeat("c", 63),
		strings.Repeat("d", 44),
	}, ".")
	if len(longestRegistrable) != maxRegistrableHostnameBytes {
		t.Fatalf("longest registrable fixture length = %d, want %d", len(longestRegistrable), maxRegistrableHostnameBytes)
	}
	if got, err := canonicalizeHostname(longestRegistrable); err != nil || got != longestRegistrable {
		t.Fatalf("canonicalizeHostname(maximum) = %q, %v; want accepted", got, err)
	}

	challengeTooLong := strings.Join([]string{
		strings.Repeat("a", 63),
		strings.Repeat("b", 63),
		strings.Repeat("c", 63),
		strings.Repeat("d", 45),
	}, ".")

	tooLong := strings.Join([]string{
		strings.Repeat("a", 63),
		strings.Repeat("b", 63),
		strings.Repeat("c", 63),
		strings.Repeat("d", 62),
	}, ".")
	invalid := []string{
		"",
		"https://example.com",
		"example.com:443",
		"example.com/path",
		"example.com?next=x",
		"127.0.0.1",
		"127.000.000.001",
		"127.1",
		"::1",
		"*.example.com",
		".example.com",
		"example..com",
		"example.com.",
		"-mail.example.com",
		"mail-.example.com",
		strings.Repeat("a", 64) + ".example",
		challengeTooLong,
		tooLong,
		"localhost",
		"internal",
		"router",
		"münich.example",
		"xn--mnich-kva.example",
		"under_score.example",
	}
	for _, input := range invalid {
		input := input
		t.Run("invalid_"+strings.ReplaceAll(input, "/", "_"), func(t *testing.T) {
			t.Parallel()
			if got, err := canonicalizeHostname(input); got != "" || !errors.Is(err, ErrInvalidDomain) {
				t.Fatalf("canonicalizeHostname(%q) = %q, %v; want empty ErrInvalidDomain", input, got, err)
			}
		})
	}
}

func TestDecodeStoredDNSRecordsFailsClosedButKeepsHistoricalChallengeVisible(t *testing.T) {
	t.Parallel()

	historicalOwner := strings.Repeat("n", maxStoredDNSRecordName)
	valid, err := json.Marshal([]DNSRecord{
		{Type: "TXT", Name: historicalOwner, Value: "pw-verify=0123456789abcdef0123456789abcdef"},
	})
	if err != nil {
		t.Fatal(err)
	}
	records, err := decodeStoredDNSRecords(valid)
	if err != nil || len(records) != 1 || records[0].Name != historicalOwner {
		t.Fatalf("decodeStoredDNSRecords(historical) = %+v, %v", records, err)
	}

	tooMany, err := json.Marshal(make([]DNSRecord, maxStoredDNSRecords+1))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"invalid_json":   []byte(`{"type":`),
		"json_null":      []byte(`null`),
		"too_many":       tooMany,
		"invalid_type":   []byte(`[{"type":"MX","name":"mail.example.com","value":"mail.example.com"}]`),
		"oversized_name": []byte(`[{"type":"TXT","name":"` + strings.Repeat("n", maxStoredDNSRecordName+1) + `","value":"token"}]`),
		"unknown_error":  []byte(`[{"type":"TXT","name":"_postwave-verify.example.com","value":"token","error":"database detail"}]`),
	}
	for name, raw := range cases {
		name, raw := name, raw
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if records, err := decodeStoredDNSRecords(raw); err == nil || records != nil {
				t.Fatalf("decodeStoredDNSRecords(%s) = %+v, %v; want nil error result", name, records, err)
			}
		})
	}
}

func TestValidateStoredDomainDowngradesHistoricalAggregateFalsePositive(t *testing.T) {
	t.Parallel()

	verifiedAt := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	domain := Domain{
		Domain:     "mail.example.com",
		Purpose:    PurposeLinks,
		Verified:   true,
		VerifiedAt: &verifiedAt,
		DNSRecords: []DNSRecord{
			{Type: "CNAME", Name: "mail.example.com", Value: "edge.moosewave.com", Verified: true},
			{Type: "TXT", Name: "_postwave-verify.mail.example.com", Value: "pw-verify=token", Error: "TXT lookup failed"},
		},
	}

	if err := validateStoredDomain(&domain); err != nil {
		t.Fatalf("validateStoredDomain() error = %v", err)
	}
	if domain.Verified || domain.VerifiedAt != nil {
		t.Fatalf("stale aggregate survived validation: %+v", domain)
	}
}

func TestCheckRecords_EmptySetCannotVerify(t *testing.T) {
	results, ok := checkRecords(context.Background(), &stubResolver{}, nil)
	if ok {
		t.Fatal("empty DNS record set verified; want fail-closed false")
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v, want empty", results)
	}
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{Repo: &Repo{Pool: nil}, RegistrationEnabled: true}
	body := `{"domain":"` + strings.Repeat("x", int(customDomainJSONMaxBodyBytes)) + `.example.com","purpose":"forms"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/custom-domains", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.Create(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestCheckRecords_WrongCNAME — CNAME pointing elsewhere → false.
func TestCheckRecords_WrongCNAME(t *testing.T) {
	res := &stubResolver{
		cnames: map[string]string{"forms.example.com": "elsewhere.example."},
	}
	records := []DNSRecord{
		{Type: "CNAME", Name: "forms.example.com", Value: "edge.moosewave.com"},
	}
	results, ok := checkRecords(context.Background(), res, records)
	if ok {
		t.Error("wrong CNAME target should return false")
	}
	if results[0].Verified || !strings.Contains(results[0].Error, "CNAME target") {
		t.Fatalf("CNAME result = %+v, want target mismatch", results[0])
	}
}

func TestCreate_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/custom-domains",
		strings.NewReader(`{"domain":"x.com","purpose":"forms"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestCreate_RegistrationDefaultsOffBeforeDecodeOrWrite(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store}
	r := tenantRequest(http.MethodPost, "/api/v1/custom-domains", "not-json")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	d.Create(w, r)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "custom_domain_registration_unavailable") {
		t.Fatalf("body = %q, want stable capability code", w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if store.createCalls != 0 {
		t.Fatalf("create calls = %d, want zero", store.createCalls)
	}
}

func TestCreate_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}, RegistrationEnabled: true}
	r := httptest.NewRequest("POST", "/api/v1/custom-domains", strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestCreate_RejectsMissingDomain(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}, RegistrationEnabled: true}
	r := httptest.NewRequest("POST", "/api/v1/custom-domains",
		strings.NewReader(`{"purpose":"forms"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_domain") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestCreate_RejectsBadPurpose(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}, RegistrationEnabled: true}
	r := httptest.NewRequest("POST", "/api/v1/custom-domains",
		strings.NewReader(`{"domain":"x.com","purpose":"badness"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_purpose") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestCreateRejectsNonExactAndDuplicateProperties(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		body string
		code string
	}{
		"case_variant": {
			body: `{"Domain":"mail.example.com","purpose":"forms"}`,
			code: "unknown_field",
		},
		"duplicate": {
			body: `{"domain":"mail.example.com","domain":"links.example.com","purpose":"forms"}`,
			code: "bad_json",
		},
	}
	for name, test := range tests {
		name, test := name, test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			store := &stubDomainStore{}
			deps := &Deps{store: store, RegistrationEnabled: true}
			r := tenantRequest(http.MethodPost, "/api/v1/custom-domains", test.body)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			deps.Create(w, r)

			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status = %d body = %q, want 400 %s", w.Code, w.Body.String(), test.code)
			}
			if store.createCalls != 0 {
				t.Fatalf("create calls = %d, want zero", store.createCalls)
			}
		})
	}
}

func TestCreate_RejectsInvalidHostnameWithStableCode(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store, RegistrationEnabled: true}
	r := tenantRequest(http.MethodPost, "/api/v1/custom-domains",
		`{"domain":"https://mail.example.com/path","purpose":"forms"}`)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	d.Create(w, r)

	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_domain") {
		t.Fatalf("status = %d body = %q, want stable invalid_domain 400", w.Code, w.Body.String())
	}
	if store.createCalls != 0 {
		t.Fatalf("create calls = %d, want zero", store.createCalls)
	}
}

func TestCreate_EnabledCanonicalizesBeforePersisting(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store, RegistrationEnabled: true}
	r := tenantRequest(http.MethodPost, "/api/v1/custom-domains",
		`{"domain":" Mail.Example.COM ","purpose":"links"}`)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	d.Create(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}
	if store.createCalls != 1 || store.createdName != "mail.example.com" || store.createdUse != PurposeLinks {
		t.Fatalf("create = calls:%d domain:%q purpose:%q", store.createCalls, store.createdName, store.createdUse)
	}
	if len(store.createdDNS) != 2 || store.createdDNS[0].Name != "mail.example.com" ||
		store.createdDNS[1].Name != "_postwave-verify.mail.example.com" {
		t.Fatalf("records = %+v, want canonical names", store.createdDNS)
	}
}

func TestCreate_InvalidConfiguredCNAMETargetFailsClosed(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{
		store:               store,
		RegistrationEnabled: true,
		VerifyTargetCNAME:   "https://edge.moosewave.com/path",
	}
	r := tenantRequest(http.MethodPost, "/api/v1/custom-domains",
		`{"domain":"mail.example.com","purpose":"links"}`)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	d.Create(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body = %q, want 500", w.Code, w.Body.String())
	}
	if store.createCalls != 0 {
		t.Fatalf("create calls = %d, want zero", store.createCalls)
	}
	if strings.Contains(w.Body.String(), "edge.moosewave.com") {
		t.Fatalf("response leaked target configuration: %q", w.Body.String())
	}
}

func TestCreate_DuplicateMapsToStableConflict(t *testing.T) {
	store := &stubDomainStore{createErr: ErrDomainTaken}
	d := &Deps{store: store, RegistrationEnabled: true}
	r := tenantRequest(http.MethodPost, "/api/v1/custom-domains",
		`{"domain":"mail.example.com","purpose":"forms"}`)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	d.Create(w, r)

	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "domain_taken") {
		t.Fatalf("status = %d body = %q, want stable domain_taken 409", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "23505") || strings.Contains(w.Body.String(), "custom_domains_domain_key") {
		t.Fatalf("response leaked database detail: %q", w.Body.String())
	}
}

func TestListAndMountedDetailAreNoStore(t *testing.T) {
	domain := Domain{
		ID:         "domain-1",
		TenantID:   "tenant_test",
		Domain:     "mail.example.com",
		Purpose:    PurposeForms,
		DNSRecords: []DNSRecord{{Type: "CNAME", Name: "mail.example.com", Value: "edge.moosewave.com"}},
	}
	store := &stubDomainStore{listResult: []Domain{domain}, getResult: &domain}
	d := &Deps{store: store}

	listRecorder := httptest.NewRecorder()
	d.List(listRecorder, tenantRequest(http.MethodGet, "/api/v1/custom-domains", ""))
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200; body=%s", listRecorder.Code, listRecorder.Body.String())
	}
	if got := listRecorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("list Cache-Control = %q, want no-store", got)
	}

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant_test"})))
		})
	})
	d.MountRoutes(router)
	detailRecorder := httptest.NewRecorder()
	router.ServeHTTP(detailRecorder, httptest.NewRequest(http.MethodGet, "/api/v1/custom-domains/domain-1", nil))
	if detailRecorder.Code != http.StatusOK || !strings.Contains(detailRecorder.Body.String(), "mail.example.com") {
		t.Fatalf("detail status = %d body = %q, want mounted domain detail", detailRecorder.Code, detailRecorder.Body.String())
	}
	if got := detailRecorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("detail Cache-Control = %q, want no-store", got)
	}
}

func TestVerify_RegressionPersistsCurrentFailureAtomically(t *testing.T) {
	verifiedAt := time.Now().Add(-time.Hour)
	domain := &Domain{
		ID:         "domain-1",
		TenantID:   "tenant_test",
		Domain:     "mail.example.com",
		Purpose:    PurposeForms,
		Verified:   true,
		VerifiedAt: &verifiedAt,
		DNSRecords: []DNSRecord{
			{Type: "CNAME", Name: "mail.example.com", Value: "edge.moosewave.com", Verified: true},
			{Type: "TXT", Name: "_postwave-verify.mail.example.com", Value: "pw-verify=tok", Verified: true},
		},
	}
	store := &stubDomainStore{getResult: domain}
	d := &Deps{store: store, Resolver: &stubResolver{err: errors.New("DNS unavailable")}, VerificationEnabled: true}
	r := withRouteID(tenantRequest(http.MethodPost, "/api/v1/custom-domains/domain-1/verify", ""), "domain-1")
	w := httptest.NewRecorder()

	d.Verify(w, r)

	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"verified":false`) {
		t.Fatalf("status = %d body = %q, want current failed verification", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("verify Cache-Control = %q, want no-store", got)
	}
	if store.updateCalls != 1 || store.updatedCurrent {
		t.Fatalf("update = calls:%d verified:%v, want one atomic false update", store.updateCalls, store.updatedCurrent)
	}
	if domain.Verified || domain.VerifiedAt != nil {
		t.Fatalf("persisted domain = verified:%v verifiedAt:%v, want current false/nil", domain.Verified, domain.VerifiedAt)
	}
	for _, record := range store.updatedRecords {
		if record.Verified || record.Error == "" {
			t.Fatalf("updated record = %+v, want failed observation", record)
		}
	}
}

func TestVerify_PersistenceFailureIsNotIgnored(t *testing.T) {
	domain := &Domain{
		ID:      "domain-1",
		Domain:  "mail.example.com",
		Purpose: PurposeForms,
		DNSRecords: []DNSRecord{
			{Type: "CNAME", Name: "mail.example.com", Value: "edge.moosewave.com"},
		},
	}
	store := &stubDomainStore{getResult: domain, updateErr: errors.New("write failed")}
	d := &Deps{
		store:               store,
		VerificationEnabled: true,
		Resolver: &stubResolver{
			cnames: map[string]string{"mail.example.com": "edge.moosewave.com."},
		},
	}
	r := withRouteID(tenantRequest(http.MethodPost, "/api/v1/custom-domains/domain-1/verify", ""), "domain-1")
	w := httptest.NewRecorder()

	d.Verify(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", w.Code, w.Body.String())
	}
	if store.updateCalls != 1 {
		t.Fatalf("update calls = %d, want one", store.updateCalls)
	}
	if strings.Contains(w.Body.String(), "write failed") {
		t.Fatalf("response leaked persistence detail: %q", w.Body.String())
	}
}

func TestMountedMutationRoutesShareCentralOperationalHold(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store, Resolver: &stubResolver{err: errors.New("resolver must not run")}}
	router := chi.NewRouter()
	d.MountRoutes(router)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
		code   string
	}{
		{name: "registration", method: http.MethodPost, path: "/api/v1/custom-domains", body: `{}`, code: "custom_domain_registration_unavailable"},
		{name: "verification", method: http.MethodPost, path: "/api/v1/custom-domains/domain-1/verify", code: "custom_domain_verification_unavailable"},
		{name: "removal", method: http.MethodDelete, path: "/api/v1/custom-domains/domain-1", code: "custom_domain_removal_unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-1", TenantID: "tenant_test", Role: "admin"})
			req = req.WithContext(ctx)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("status = %d body = %q, want stable %s 503", recorder.Code, recorder.Body.String(), test.code)
			}
			if got := recorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Fatalf("Cache-Control = %q, want private no-store", got)
			}
		})
	}
	if store.createCalls != 0 || store.getCalls != 0 || store.updateCalls != 0 || store.deleteCalls != 0 {
		t.Fatalf("held routes touched repository: create=%d get=%d update=%d delete=%d", store.createCalls, store.getCalls, store.updateCalls, store.deleteCalls)
	}
}

func TestVerifyAuthenticatesBeforeCapabilityDisclosure(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store}
	req := withRouteID(httptest.NewRequest(http.MethodPost, "/api/v1/custom-domains/domain-1/verify", nil), "domain-1")
	recorder := httptest.NewRecorder()
	d.Verify(recorder, req)

	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "no_tenant") {
		t.Fatalf("status = %d body = %q, want tenant 401", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "custom_domain_verification_unavailable") || store.getCalls != 0 {
		t.Fatalf("unauthenticated verification disclosed policy or touched repository: body=%q get=%d", recorder.Body.String(), store.getCalls)
	}
}

func TestDelete_DefaultsOffBeforeRepositoryAccess(t *testing.T) {
	t.Run("no repository configured", func(t *testing.T) {
		d := &Deps{}
		r := withRouteID(
			tenantRequest(http.MethodDelete, "/api/v1/custom-domains/domain-1", ""),
			"domain-1",
		)
		w := httptest.NewRecorder()

		d.Delete(w, r)

		if w.Code != http.StatusServiceUnavailable ||
			!strings.Contains(w.Body.String(), "custom_domain_removal_unavailable") {
			t.Fatalf("status = %d body = %q, want stable removal 503", w.Code, w.Body.String())
		}
		if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
			t.Fatalf("Cache-Control = %q, want private no-store", got)
		}
	})

	t.Run("configured repository is not touched", func(t *testing.T) {
		store := &stubDomainStore{}
		d := &Deps{store: store}
		r := withRouteID(
			tenantRequest(http.MethodDelete, "/api/v1/custom-domains/domain-1", ""),
			"domain-1",
		)
		w := httptest.NewRecorder()

		d.Delete(w, r)

		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
		}
		if store.deleteCalls != 0 {
			t.Fatalf("delete calls = %d, want zero", store.deleteCalls)
		}
	})
}

func TestDelete_AuthenticatesBeforeCapabilityDisclosure(t *testing.T) {
	store := &stubDomainStore{}
	d := &Deps{store: store}
	r := withRouteID(
		httptest.NewRequest(http.MethodDelete, "/api/v1/custom-domains/domain-1", nil),
		"domain-1",
	)
	w := httptest.NewRecorder()

	d.Delete(w, r)

	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "no_tenant") {
		t.Fatalf("status = %d body = %q, want tenant 401", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "custom_domain_removal_unavailable") {
		t.Fatalf("unauthenticated response disclosed capability state: %q", w.Body.String())
	}
	if store.deleteCalls != 0 {
		t.Fatalf("delete calls = %d, want zero", store.deleteCalls)
	}
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want private no-store", got)
	}
}

func TestDelete_ExplicitlyEnabledPreservesIdempotentSuccess(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "existing row", err: nil},
		{name: "already absent row", err: ErrNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &stubDomainStore{deleteErr: test.err}
			d := &Deps{store: store, RemovalEnabled: true}
			r := withRouteID(
				tenantRequest(http.MethodDelete, "/api/v1/custom-domains/domain-1", ""),
				"domain-1",
			)
			w := httptest.NewRecorder()

			d.Delete(w, r)

			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
				t.Fatalf("status = %d body = %q, want idempotent 200", w.Code, w.Body.String())
			}
			if store.deleteCalls != 1 || store.deletedTenant != "tenant_test" || store.deletedDomain != "domain-1" {
				t.Fatalf(
					"delete = calls:%d tenant:%q domain:%q",
					store.deleteCalls,
					store.deletedTenant,
					store.deletedDomain,
				)
			}
			if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Fatalf("Cache-Control = %q, want private no-store", got)
			}
		})
	}
}

func TestDelete_EnabledBackendFailureIsSanitized(t *testing.T) {
	store := &stubDomainStore{
		deleteErr: errors.New("DELETE FROM custom_domains leaked-secret"),
	}
	d := &Deps{store: store, RemovalEnabled: true}
	r := withRouteID(
		tenantRequest(http.MethodDelete, "/api/v1/custom-domains/domain-1", ""),
		"domain-1",
	)
	w := httptest.NewRecorder()

	d.Delete(w, r)

	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "internal_error") {
		t.Fatalf("status = %d body = %q, want sanitized 500", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "custom_domains") || strings.Contains(w.Body.String(), "leaked-secret") {
		t.Fatalf("response leaked backend detail: %q", w.Body.String())
	}
	if store.deleteCalls != 1 {
		t.Fatalf("delete calls = %d, want one", store.deleteCalls)
	}
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want private no-store", got)
	}
}

type testSQLStateError struct{ state string }

func (e testSQLStateError) Error() string    { return "database constraint detail" }
func (e testSQLStateError) SQLState() string { return e.state }

func TestIsUniqueViolation(t *testing.T) {
	if !isUniqueViolation(errors.Join(errors.New("wrapped"), testSQLStateError{state: "23505"})) {
		t.Fatal("wrapped 23505 was not recognized")
	}
	if isUniqueViolation(testSQLStateError{state: "23503"}) {
		t.Fatal("non-unique SQL state was recognized")
	}
}

// TestNewToken — generates a 32-char hex string each time, distinct
// across calls.
func TestNewToken(t *testing.T) {
	a, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 32 {
		t.Errorf("len = %d, want 32", len(a))
	}
	b, _ := newToken()
	if a == b {
		t.Errorf("two consecutive tokens collided: %q", a)
	}
}
