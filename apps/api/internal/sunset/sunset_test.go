// SPDX-License-Identifier: AGPL-3.0-only
package sunset

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func withTenant(r *http.Request, id string) *http.Request {
	if r.Body != nil && r.Body != http.NoBody {
		r.Header.Set("Content-Type", "application/json")
	}
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: id}))
}

// ---- engine tests ----

func TestEngine_Run_SuppressActionApplied(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, err := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "Sunset Inactive", InactiveDays: 180, Action: ActionSuppress, Enabled: true,
	})
	if err != nil {
		t.Fatalf("create policy: %v", err)
	}
	subs.CandidatesByPolicy[p.ID] = []Candidate{
		{SubscriberID: "sub-1", Email: "a@example.com", InactiveDays: 200},
		{SubscriberID: "sub-2", Email: "b@example.com", InactiveDays: 365},
	}
	summary, err := eng.Run(context.Background(), "tenant-A", p.ID)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if summary.CandidatesSeen != 2 {
		t.Errorf("candidatesSeen = %d, want 2", summary.CandidatesSeen)
	}
	if summary.ByAction[ActionSuppress] != 2 {
		t.Errorf("suppress count = %d, want 2", summary.ByAction[ActionSuppress])
	}
	if len(subs.Suppressions) != 2 {
		t.Errorf("expected 2 suppressions, got %d", len(subs.Suppressions))
	}
}

func TestEngine_Run_TagActionApplied(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, _ := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "tag", InactiveDays: 90, Action: ActionTag, Enabled: true,
	})
	subs.CandidatesByPolicy[p.ID] = []Candidate{
		{SubscriberID: "sub-1", Email: "a@example.com"},
	}
	summary, _ := eng.Run(context.Background(), "tenant-A", p.ID)
	if summary.ByAction[ActionTag] != 1 {
		t.Errorf("tag count = %d, want 1", summary.ByAction[ActionTag])
	}
	if len(subs.Tags["sub-1"]) != 1 || subs.Tags["sub-1"][0] != "sunset_candidate" {
		t.Errorf("expected sunset_candidate tag on sub-1, got %v", subs.Tags["sub-1"])
	}
}

func TestEngine_Run_WinbackActionApplied(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, _ := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "wb", InactiveDays: 90, Action: ActionWinback, Enabled: true,
	})
	subs.CandidatesByPolicy[p.ID] = []Candidate{
		{SubscriberID: "sub-1"},
		{SubscriberID: "sub-2"},
	}
	_, _ = eng.Run(context.Background(), "tenant-A", p.ID)
	if len(subs.WinbackEnqueued) != 2 {
		t.Errorf("winback enqueued = %d, want 2", len(subs.WinbackEnqueued))
	}
}

func TestEngine_Run_ExcludedTagsSkipped(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, _ := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "skip-vips", InactiveDays: 90, Action: ActionSuppress, Enabled: true,
		ExcludedTags: []string{"vip", "customer"},
	})
	subs.CandidatesByPolicy[p.ID] = []Candidate{
		{SubscriberID: "sub-1", Email: "vip@example.com", Tags: []string{"vip"}},
		{SubscriberID: "sub-2", Email: "nobody@example.com"},
	}
	summary, _ := eng.Run(context.Background(), "tenant-A", p.ID)
	if summary.ByAction[ActionSuppress] != 1 {
		t.Errorf("suppress count = %d, want 1 (sub-1 excluded)", summary.ByAction[ActionSuppress])
	}
	if summary.ByAction[ActionSkipped] != 1 {
		t.Errorf("skipped count = %d, want 1", summary.ByAction[ActionSkipped])
	}
	if len(subs.Suppressions) != 1 || subs.Suppressions[0] != "nobody@example.com" {
		t.Errorf("expected only nobody@ suppressed, got %v", subs.Suppressions)
	}
}

func TestEngine_Run_DisabledPolicyShortCircuits(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, _ := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "off", InactiveDays: 90, Action: ActionSuppress, Enabled: false,
	})
	subs.CandidatesByPolicy[p.ID] = []Candidate{{SubscriberID: "sub-1", Email: "x@example.com"}}
	summary, err := eng.Run(context.Background(), "tenant-A", p.ID)
	if err != nil {
		t.Fatalf("disabled policy should not error, got %v", err)
	}
	if summary.CandidatesSeen != 0 {
		t.Errorf("disabled policy should NOT scan, got candidatesSeen=%d", summary.CandidatesSeen)
	}
	if len(subs.Suppressions) != 0 {
		t.Errorf("disabled policy must NOT execute actions")
	}
}

func TestEngine_Run_IdempotentExecutionLog(t *testing.T) {
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	eng := NewEngine(policies, subs)
	p, _ := policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "idem", InactiveDays: 90, Action: ActionTag, Enabled: true,
	})
	subs.CandidatesByPolicy[p.ID] = []Candidate{{SubscriberID: "sub-1", Email: "a@example.com"}}
	for i := 0; i < 3; i++ {
		_, _ = eng.Run(context.Background(), "tenant-A", p.ID)
	}
	execs, _ := policies.ListExecutions(context.Background(), "tenant-A", p.ID, 100)
	if len(execs) != 1 {
		t.Errorf("expected 1 execution row across 3 runs, got %d", len(execs))
	}
}

// ---- re-engagement template tests ----

func TestGenerateTemplate_SoftVariantDefaults(t *testing.T) {
	tmpl := GenerateTemplate(BrandSnapshot{}, 50, TemplateOptions{})
	if tmpl.Variant != "soft" {
		t.Errorf("default variant = %q, want soft", tmpl.Variant)
	}
	if tmpl.Subject == "" || tmpl.BodyText == "" || tmpl.BodyHTML == "" {
		t.Errorf("template missing core fields: %+v", tmpl)
	}
	if tmpl.CandidateCount != 50 {
		t.Errorf("candidate count = %d, want 50", tmpl.CandidateCount)
	}
}

func TestGenerateTemplate_VariantsDiffer(t *testing.T) {
	soft := GenerateTemplate(BrandSnapshot{WorkspaceName: "Acme"}, 1, TemplateOptions{Variant: "soft"})
	direct := GenerateTemplate(BrandSnapshot{WorkspaceName: "Acme"}, 1, TemplateOptions{Variant: "direct"})
	last := GenerateTemplate(BrandSnapshot{WorkspaceName: "Acme"}, 1, TemplateOptions{Variant: "last_chance"})
	subjects := map[string]string{"soft": soft.Subject, "direct": direct.Subject, "last_chance": last.Subject}
	seen := map[string]struct{}{}
	for variant, subj := range subjects {
		if _, dup := seen[subj]; dup {
			t.Errorf("variant %q has duplicate subject %q", variant, subj)
		}
		seen[subj] = struct{}{}
	}
}

func TestGenerateTemplate_NoSpammyShapes(t *testing.T) {
	// Templates must NOT trip the most obvious eqscore rules so they
	// ship at a clean grade.
	tmpl := GenerateTemplate(BrandSnapshot{ProductName: "Moosewave"}, 100, TemplateOptions{Variant: "last_chance"})
	if strings.Contains(strings.ToUpper(tmpl.Subject), "!!!") {
		t.Errorf("subject has excessive punctuation: %q", tmpl.Subject)
	}
	if tmpl.Subject == strings.ToUpper(tmpl.Subject) && len(tmpl.Subject) > 6 {
		t.Errorf("subject is all caps: %q", tmpl.Subject)
	}
	for _, phrase := range []string{"FREE", "ACT NOW", "GUARANTEED"} {
		if strings.Contains(strings.ToUpper(tmpl.Subject), phrase) {
			t.Errorf("subject contains spammy phrase %q: %q", phrase, tmpl.Subject)
		}
	}
}

func TestGenerateTemplate_HTMLContainsUnsubscribeLink(t *testing.T) {
	tmpl := GenerateTemplate(BrandSnapshot{UnsubscribeURL: "https://example.com/unsub"}, 1, TemplateOptions{})
	if !strings.Contains(tmpl.BodyHTML, "https://example.com/unsub") {
		t.Errorf("HTML body missing unsubscribe URL")
	}
	if !strings.Contains(tmpl.BodyHTML, "unsubscribe") {
		t.Errorf("HTML body missing unsubscribe link text")
	}
}

func TestGenerateTemplate_EscapesURLsInHTMLAttributeContext(t *testing.T) {
	tmpl := GenerateTemplate(BrandSnapshot{
		HomepageURL:    `https://example.com/" onmouseover="alert(1)`,
		UnsubscribeURL: `https://example.com/unsub?a=1&b=2`,
	}, 1, TemplateOptions{})
	if strings.Contains(tmpl.BodyHTML, `onmouseover="alert(1)`) {
		t.Fatalf("generated HTML contains an injectable attribute: %s", tmpl.BodyHTML)
	}
	if !strings.Contains(tmpl.BodyHTML, `&quot; onmouseover=&quot;alert(1)`) {
		t.Fatalf("generated HTML did not attribute-escape the URL: %s", tmpl.BodyHTML)
	}
	if !strings.Contains(tmpl.BodyHTML, `unsub?a=1&amp;b=2`) {
		t.Fatalf("generated HTML did not escape URL ampersands: %s", tmpl.BodyHTML)
	}
}

func TestGenerateTemplate_FallbacksFireOnEmptyBrand(t *testing.T) {
	tmpl := GenerateTemplate(BrandSnapshot{}, 0, TemplateOptions{Variant: "direct"})
	// Empty WorkspaceName should fall back to "our team" — i.e. the
	// subject should NEVER contain empty interpolated values.
	if strings.Contains(tmpl.Subject, "  ") || strings.HasSuffix(tmpl.Subject, " ") {
		t.Errorf("subject has unfilled placeholder shape: %q", tmpl.Subject)
	}
}

// ---- handler tests ----

func newDepsForTests(t *testing.T) *Deps {
	t.Helper()
	policies := NewMemoryPolicyStore(nil)
	subs := NewMemorySubscriberStore()
	return &Deps{Engine: NewEngine(policies, subs), Policies: policies}
}

func TestCreatePolicy_HappyPath(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"name":"Sunset","inactiveDays":180,"action":"suppress","enabled":true}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/policies", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CreatePolicy(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	var got Policy
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID == "" || got.Name != "Sunset" || got.Action != ActionSuppress {
		t.Errorf("policy not hydrated: %+v", got)
	}
}

func TestCreatePolicy_InvalidInactiveDays(t *testing.T) {
	d := newDepsForTests(t)
	for _, days := range []int{29, 731, 0, -10} {
		body := bytes.NewBufferString(`{"name":"x","inactiveDays":` + itoa(days) + `,"action":"tag","enabled":true}`)
		req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/policies", body), "tenant-A")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.CreatePolicy(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("inactiveDays=%d should 400, got %d", days, rec.Code)
		}
	}
}

func TestCreatePolicy_InvalidAction(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"name":"x","inactiveDays":90,"action":"DELETE_THEM_ALL","enabled":true}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/policies", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CreatePolicy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("invalid action should 400, got %d", rec.Code)
	}
}

func TestPreviewReengagement_RoundTrip(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"brand":{"workspaceName":"Acme","productName":"Acme Weekly"},"candidateCount":42,"variant":"direct"}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/reengagement/preview", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PreviewReengagement(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got Template
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.CandidateCount != 42 || got.Variant != "direct" {
		t.Errorf("template echo wrong: %+v", got)
	}
}

func TestPreviewReengagement_RejectsUnsafeOrUnboundedInputs(t *testing.T) {
	d := newDepsForTests(t)
	tests := []struct {
		name string
		body any
	}{
		{
			name: "javascript homepage",
			body: map[string]any{"brand": map[string]any{"HomepageURL": "javascript:alert(1)"}},
		},
		{
			name: "non tls unsubscribe",
			body: map[string]any{"brand": map[string]any{"UnsubscribeURL": "http://example.com/unsub"}},
		},
		{
			name: "embedded credentials",
			body: map[string]any{"brand": map[string]any{"HomepageURL": "https://user:pass@example.com"}},
		},
		{
			name: "unknown variant",
			body: map[string]any{"brand": map[string]any{}, "variant": "surprise"},
		},
		{
			name: "negative count",
			body: map[string]any{"brand": map[string]any{}, "candidateCount": -1},
		},
		{
			name: "oversized name",
			body: map[string]any{"brand": map[string]any{"WorkspaceName": strings.Repeat("a", 161)}},
		},
		{
			name: "control character",
			body: map[string]any{"brand": map[string]any{"SenderName": "safe\nunsafe"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(tc.body)
			if err != nil {
				t.Fatalf("marshal body: %v", err)
			}
			req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/reengagement/preview", bytes.NewReader(encoded)), "tenant-A")
			rec := httptest.NewRecorder()
			d.PreviewReengagement(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "validation_failed") {
				t.Fatalf("missing stable validation code: %s", rec.Body.String())
			}
		})
	}
}

func TestRunPolicy_HandlerRoundTrip(t *testing.T) {
	d := newDepsForTests(t)
	// Create a policy directly via the store so we have a known id.
	p, _ := d.Policies.CreatePolicy(context.Background(), "tenant-A", Policy{
		Name: "Sunset", InactiveDays: 180, Action: ActionTag, Enabled: true,
	})
	// Plant a candidate via the subscriber store.
	subStore := d.Engine.Subscribers.(*MemorySubscriberStore)
	subStore.CandidatesByPolicy[p.ID] = []Candidate{{SubscriberID: "sub-1", Email: "a@example.com"}}

	r := chi.NewRouter()
	d.MountRoutes(r)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/sunset/policies/"+p.ID+"/run", nil), "tenant-A")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var sum RunSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &sum); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if sum.CandidatesSeen != 1 || sum.ByAction[ActionTag] != 1 {
		t.Errorf("RunSummary wrong: %+v", sum)
	}
}

func TestListPolicies_TenantBoundary(t *testing.T) {
	d := newDepsForTests(t)
	_, _ = d.Policies.CreatePolicy(context.Background(), "tenant-A", Policy{Name: "A-pol", InactiveDays: 90, Action: ActionTag, Enabled: true})
	_, _ = d.Policies.CreatePolicy(context.Background(), "tenant-B", Policy{Name: "B-pol", InactiveDays: 90, Action: ActionTag, Enabled: true})
	req := withTenant(httptest.NewRequest("GET", "/api/v1/sunset/policies", nil), "tenant-A")
	rec := httptest.NewRecorder()
	d.ListPolicies(rec, req)
	var resp struct {
		Items []Policy `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	for _, p := range resp.Items {
		if p.TenantID != "tenant-A" {
			t.Errorf("cross-tenant leak: %q", p.TenantID)
		}
	}
}

// itoa is a small helper local to the test file so we don't depend on
// strconv (handlers.go already uses it but the test scope is narrow).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// Compile-time guard: time package import (used by RunSummary timestamps)
// stays in scope when tests use the engine.
var _ = time.Second
