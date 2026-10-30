package affiliates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func TestAffiliateOperationalBoundariesRemainClosed(t *testing.T) {
	t.Parallel()
	if AdminOperationsAvailable {
		t.Fatal("affiliate admin operations unexpectedly available")
	}
	if PublicOfferAvailable {
		t.Fatal("public affiliate offer unexpectedly available")
	}
	if NewAttributionAvailable {
		t.Fatal("new affiliate attribution unexpectedly available")
	}
	if PayoutOperationsAvailable {
		t.Fatal("affiliate payout operations unexpectedly available")
	}
	if OperationallyAvailable() {
		t.Fatal("affiliate program unexpectedly operational")
	}
}

func TestClosedAffiliateMountsRegisterNoRoutes(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	deps := &Deps{}
	deps.MountAdminRoutes(router)
	deps.MountPublicRoutes(router)

	for _, route := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/admin/affiliates"},
		{method: http.MethodPost, path: "/api/public/affiliates/signup"},
		{method: http.MethodGet, path: "/api/public/affiliates/track"},
		{method: http.MethodGet, path: "/api/public/affiliates/pixel.gif"},
	} {
		req := httptest.NewRequest(route.method, route.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d, want 404", route.method, route.path, rec.Code)
		}
	}
}

func TestDirectAttributionEntryPointsFailClosed(t *testing.T) {
	t.Parallel()
	deps := &Deps{}
	if err := deps.HandleStripeEvent(context.Background(), StripeEvent{}); !errors.Is(err, ErrProgramUnavailable) {
		t.Fatalf("HandleStripeEvent error = %v, want ErrProgramUnavailable", err)
	}
	if err := deps.ReverseConversion(context.Background(), "cus_closed", "pi_closed"); !errors.Is(err, ErrProgramUnavailable) {
		t.Fatalf("ReverseConversion error = %v, want ErrProgramUnavailable", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/public/affiliates/track?ref=partner", nil)
	rec := httptest.NewRecorder()
	if _, err := RecordClickFromRequest(
		context.Background(),
		nil,
		CookieConfig{},
		rec,
		req,
		"partner",
	); !errors.Is(err, ErrProgramUnavailable) {
		t.Fatalf("RecordClickFromRequest error = %v, want ErrProgramUnavailable", err)
	}
}

func TestLegacyStripeHandlerFailsClosedBeforeReadingPayload(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPost, "/api/internal/stripe/webhook", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).StripeWebhookHandler(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != "affiliate_program_unavailable" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

// TestNoProductionCallerReadsASingleAvailabilityFlag enforces the invariant
// availability.go states in prose and nothing else checks:
//
//	"A partial flag change must never expose enrollment, partner records,
//	 attribution, commission moderation, or settlement independently."
//
// `OperationallyAvailable()` ANDs the four flags, which makes the COMBINED
// check correct. It does nothing to stop a future caller reading
// `PublicOfferAvailable` on its own and lighting up one quarter of a commercial
// programme — which is precisely the partial launch the comment forbids, and
// the kind of change that looks harmless in review because the flag it touches
// is still `false`.
//
// This is the same shape as every other guard hole found in this programme: the
// stated rule was one-directional. `TestFlagsAreFalse` proves the flags are off;
// nothing proved they can only be read TOGETHER.
//
// Scanned over source rather than asserted about this package's own symbols, so
// a caller added anywhere under apps/api is caught.
func TestNoProductionCallerReadsASingleAvailabilityFlag(t *testing.T) {
	flags := []string{
		"AdminOperationsAvailable",
		"PublicOfferAvailable",
		"NewAttributionAvailable",
		"PayoutOperationsAvailable",
	}
	root := filepath.Join("..", "..")
	var offenders []string
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		// availability.go is where the flags are DECLARED and where
		// OperationallyAvailable legitimately reads all four.
		if filepath.Base(path) == "availability.go" {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		scanned++
		text := string(body)
		for _, flag := range flags {
			if strings.Contains(text, flag) {
				offenders = append(offenders, path+" reads "+flag)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	// Vacuity floor: a walk that finds no Go files would pass while checking
	// nothing at all.
	if scanned < 200 {
		t.Fatalf("scanned only %d non-test Go files; the walk is not reaching "+
			"the tree and this test proves nothing", scanned)
	}
	if len(offenders) > 0 {
		t.Errorf("these read an affiliate availability flag directly:\n  %s\n"+
			"Use affiliates.OperationallyAvailable(), which requires the COMPLETE "+
			"release boundary. Reading one flag is how a commercial programme "+
			"gets launched a quarter at a time.", strings.Join(offenders, "\n  "))
	}
}
