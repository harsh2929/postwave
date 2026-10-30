// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func templateRouteRequest(method, path, body, id string) *http.Request {
	req := tenantRequest(method, path, body)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
}

func TestTemplateMutationRequiresOneStrongIfMatch(t *testing.T) {
	tests := []struct {
		name   string
		header string
		status int
		code   string
	}{
		{name: "missing", status: http.StatusPreconditionRequired, code: "precondition_required"},
		{name: "wildcard", header: "*", status: http.StatusPreconditionRequired, code: "precondition_required"},
		{name: "weak", header: `W/"campaign-template:template-1:v1"`, status: http.StatusPreconditionFailed, code: "precondition_failed"},
		{name: "multiple", header: `"campaign-template:template-1:v1", "campaign-template:template-1:v2"`, status: http.StatusPreconditionFailed, code: "precondition_failed"},
		{name: "malformed", header: `campaign-template:template-1:v1`, status: http.StatusPreconditionFailed, code: "precondition_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			repo := &templateRepositoryStub{updateFn: func(context.Context, string, string, UpdateInput) (*Template, error) {
				called = true
				return nil, nil
			}}
			req := templateRouteRequest(http.MethodPatch, "/api/v1/campaign-templates/template-1", `{"name":"Updated"}`, "template-1")
			if tt.header != "" {
				req.Header.Set("If-Match", tt.header)
			}
			rec := httptest.NewRecorder()
			(&Deps{Repo: repo}).Update(rec, req)
			if rec.Code != tt.status || !strings.Contains(rec.Body.String(), `"code":"`+tt.code+`"`) {
				t.Fatalf("status=%d body=%s, want %d/%s", rec.Code, rec.Body.String(), tt.status, tt.code)
			}
			if called {
				t.Fatal("repository called with an unusable If-Match")
			}
		})
	}
}

func TestTemplateUpdateMapsStaleTokenAndReturnsFreshETag(t *testing.T) {
	t.Run("stale", func(t *testing.T) {
		repo := &templateRepositoryStub{updateFn: func(_ context.Context, _, _ string, in UpdateInput) (*Template, error) {
			if in.IfMatch != `"campaign-template:template-1:v1"` {
				t.Fatalf("IfMatch=%q", in.IfMatch)
			}
			return nil, ErrTemplatePrecondition
		}}
		req := templateRouteRequest(http.MethodPatch, "/api/v1/campaign-templates/template-1", `{"name":"Updated"}`, "template-1")
		req.Header.Set("If-Match", `"campaign-template:template-1:v1"`)
		rec := httptest.NewRecorder()
		(&Deps{Repo: repo}).Update(rec, req)
		if rec.Code != http.StatusPreconditionFailed {
			t.Fatalf("status=%d body=%s, want 412", rec.Code, rec.Body.String())
		}
	})

	t.Run("success", func(t *testing.T) {
		repo := &templateRepositoryStub{updateFn: func(context.Context, string, string, UpdateInput) (*Template, error) {
			return &Template{
				ID: "template-1", TenantID: "tenant-1", TemplateKind: templateKindEditable,
				ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned,
				Version: 2,
			}, nil
		}}
		req := templateRouteRequest(http.MethodPatch, "/api/v1/campaign-templates/template-1", `{"name":"Updated"}`, "template-1")
		req.Header.Set("If-Match", `"campaign-template:template-1:v1"`)
		rec := httptest.NewRecorder()
		(&Deps{Repo: repo}).Update(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		want := `"campaign-template:template-1:v2"`
		if rec.Header().Get("ETag") != want || !strings.Contains(rec.Body.String(), `campaign-template:template-1:v2`) {
			t.Fatalf("headers=%v body=%s, want fresh ETag %s", rec.Header(), rec.Body.String(), want)
		}
	})
}

func TestArchiveRestoreCapabilitiesAreLifecycleAware(t *testing.T) {
	active := &Template{
		ID: "template-1", TenantID: "tenant-1", TemplateKind: templateKindEditable,
		ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned,
		Version: 4,
	}
	projectTemplate(active, unrestrictedTemplatePresentation)
	if !active.Capabilities.CanArchive || active.Capabilities.CanRestore || !active.Capabilities.CanDelete {
		t.Fatalf("active capabilities=%+v", active.Capabilities)
	}
	archivedAt := time.Now().UTC()
	active.ArchivedAt = &archivedAt
	projectTemplate(active, unrestrictedTemplatePresentation)
	if active.Capabilities.CanArchive || !active.Capabilities.CanRestore ||
		active.Capabilities.CanEditDirectly || active.Capabilities.CanUseDirectly {
		t.Fatalf("archived capabilities=%+v", active.Capabilities)
	}
	if active.RecommendedAction != "campaign_template_restore" ||
		ValidateTemplateEligibility(active) == nil || ValidateTemplateAdaptationEligibility(active) == nil {
		t.Fatalf("archived projection action=%q warnings=%+v", active.RecommendedAction, active.Warnings)
	}

	reference := &Template{
		ID: "reference-1", TenantID: "tenant-1", TemplateKind: templateKindReference,
		ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned,
		ReferenceAdaptationAllowed: true, ReferenceDirectUseAllowed: true, Version: 1,
	}
	projectTemplate(reference, unrestrictedTemplatePresentation)
	if reference.Capabilities.CanArchive || reference.Capabilities.CanRestore || reference.Capabilities.CanDelete {
		t.Fatalf("reference lifecycle capabilities=%+v", reference.Capabilities)
	}
}

func TestArchivedFilterIsStrictAndDefaultsActive(t *testing.T) {
	for raw, want := range map[string]string{
		"": "active", "active": "active", "archived": "archived", "all": "all",
	} {
		got, err := canonicalArchiveFilter(raw)
		if err != nil || got != want {
			t.Fatalf("canonicalArchiveFilter(%q)=(%q,%v), want %q", raw, got, err, want)
		}
	}
	if _, err := canonicalArchiveFilter("everything"); err != ErrInvalidArchiveFilter {
		t.Fatalf("invalid archived filter error=%v", err)
	}
}
