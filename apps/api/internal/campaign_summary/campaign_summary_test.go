// SPDX-License-Identifier: AGPL-3.0-only

package campaign_summary

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRenderDeterministic(t *testing.T) {
	t.Run("strong send vs baseline", func(t *testing.T) {
		out := renderDeterministic(inputs{OpenRate: 0.50, BaselineOpenRate: 0.30, ClickRate: 0.10})
		if !strings.Contains(out, "Strong send") {
			t.Errorf("expected strong-send framing, got: %s", out)
		}
		if !strings.Contains(out, "+20.0 pp") {
			t.Errorf("expected +20.0 pp delta, got: %s", out)
		}
	})

	t.Run("underperformed", func(t *testing.T) {
		out := renderDeterministic(inputs{OpenRate: 0.10, BaselineOpenRate: 0.30})
		if !strings.Contains(out, "Underperformed") {
			t.Errorf("expected underperformed framing, got: %s", out)
		}
		if !strings.Contains(out, "A/B test a sharper subject") {
			t.Errorf("expected subject-test suggestion for underperformers, got: %s", out)
		}
	})

	t.Run("top link concentration", func(t *testing.T) {
		out := renderDeterministic(inputs{
			OpenRate: 0.4, BaselineOpenRate: 0.4, ClickRate: 0.2,
			TopLinkURL: "https://x.test/buy", TopLinkPct: 0.6,
		})
		if !strings.Contains(out, "https://x.test/buy") || !strings.Contains(out, "60%") {
			t.Errorf("expected top-link callout, got: %s", out)
		}
	})

	t.Run("drift advisory above threshold", func(t *testing.T) {
		out := renderDeterministic(inputs{OpenRate: 0.4, BaselineOpenRate: 0.4, VoiceDriftScore: 0.35})
		if !strings.Contains(out, "Voice drift score") {
			t.Errorf("expected drift advisory at 0.35, got: %s", out)
		}
	})

	t.Run("no drift advisory below threshold", func(t *testing.T) {
		out := renderDeterministic(inputs{OpenRate: 0.4, BaselineOpenRate: 0.4, VoiceDriftScore: 0.10})
		if strings.Contains(out, "Voice drift score") {
			t.Errorf("did not expect drift advisory at 0.10, got: %s", out)
		}
	})
}

func TestClassifyByHeuristic(t *testing.T) {
	cases := map[string]string{
		"Re: your launch":       "reply",
		"FWD: pricing":          "reply",
		"please unsubscribe":    "unsub",
		"Out of office":         "ooo",
		"Loved this newsletter": "other",
	}
	for subject, want := range cases {
		if got := classifyByHeuristic(subject); got != want {
			t.Errorf("classifyByHeuristic(%q) = %q, want %q", subject, got, want)
		}
	}
}

func TestActorIsAdmin(t *testing.T) {
	admin := middleware.WithUser(context.Background(), &middleware.User{Role: "admin"})
	owner := middleware.WithUser(context.Background(), &middleware.User{Role: "Owner"})
	editor := middleware.WithUser(context.Background(), &middleware.User{Role: "editor"})
	if !actorIsAdmin(admin) {
		t.Error("admin should be admin")
	}
	if !actorIsAdmin(owner) {
		t.Error("owner (any case) should be admin")
	}
	if actorIsAdmin(editor) {
		t.Error("editor should not be admin")
	}
	if actorIsAdmin(context.Background()) {
		t.Error("no user => not admin")
	}
}

// Force regenerate by a non-admin is rejected before any DB work, so the
// 403 path is exercisable with a nil pool.
func TestRegenerateForceRequiresAdmin(t *testing.T) {
	d := &Deps{Pool: nil} // never reached — gate returns first
	ctx := middleware.WithUser(
		middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"}),
		&middleware.User{Role: "editor"},
	)
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/campaigns/c1/summary/regenerate", strings.NewReader(`{"force":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.regenerate(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "admin_required") {
		t.Errorf("expected admin_required error, got: %s", rec.Body.String())
	}
}

func TestRegenerateRequiresTenant(t *testing.T) {
	d := &Deps{Pool: nil}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c1/summary/regenerate", nil)
	rec := httptest.NewRecorder()
	d.regenerate(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
