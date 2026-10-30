// SPDX-License-Identifier: AGPL-3.0-only
package rbacresolve

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/rbac"
)

// fakeChecker is a PermissionChecker that returns a canned decision — lets the
// middleware be tested without a database.
type fakeChecker struct {
	allow bool
	err   error
	saw   struct {
		tenant, role string
		perm         rbac.Permission
	}
}

func (f *fakeChecker) Can(_ context.Context, tenantID, role string, perm rbac.Permission) (bool, error) {
	f.saw.tenant, f.saw.role, f.saw.perm = tenantID, role, perm
	return f.allow, f.err
}

func principalFrom(header string) PrincipalFunc {
	return func(r *http.Request) (string, string, bool) {
		role := r.Header.Get(header)
		if role == "" {
			return "", "", false
		}
		return "tenant-1", role, true
	}
}

func run(t *testing.T, checker PermissionChecker, role string) int {
	t.Helper()
	h := RequirePermission(rbac.PermCampaignsWrite, checker, principalFrom("X-Role"))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }),
	)
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	if role != "" {
		req.Header.Set("X-Role", role)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestRequirePermissionAllows(t *testing.T) {
	chk := &fakeChecker{allow: true}
	if code := run(t, chk, "editor"); code != http.StatusOK {
		t.Fatalf("code = %d, want 200", code)
	}
	// The middleware must forward the resolved principal + permission to the checker.
	if chk.saw.tenant != "tenant-1" || chk.saw.role != "editor" || chk.saw.perm != rbac.PermCampaignsWrite {
		t.Errorf("checker saw %+v, want tenant-1/editor/campaigns.write", chk.saw)
	}
}

func TestRequirePermissionDenies(t *testing.T) {
	if code := run(t, &fakeChecker{allow: false}, "viewer"); code != http.StatusForbidden {
		t.Errorf("denied role: code = %d, want 403", code)
	}
}

func TestRequirePermissionMissingPrincipalIs401(t *testing.T) {
	if code := run(t, &fakeChecker{allow: true}, ""); code != http.StatusUnauthorized {
		t.Errorf("no principal: code = %d, want 401", code)
	}
}

func TestRequirePermissionFailsClosedOnError(t *testing.T) {
	// A checker error (e.g. store outage) must DENY, never allow — a resolution
	// failure cannot become a privilege escalation. That is the property; the
	// status is how it is reported.
	//
	// It reports 503 now, not 403. A 403 asserts "you are not allowed", which is
	// something we do not know when the grant store could not be read — the
	// caller may well have the permission. 503 with `reason: runtime` says what
	// actually happened, so a client can offer "try again shortly" instead of
	// sending someone to an admin who will find nothing wrong. The request is
	// refused either way, which is what fail-closed means.
	code := run(t, &fakeChecker{err: errors.New("db down")}, "admin")
	if code == http.StatusOK || code < 400 {
		t.Fatalf("checker error: code = %d — a resolution failure must never "+
			"allow the request through", code)
	}
	if code != http.StatusServiceUnavailable {
		t.Errorf("checker error: code = %d, want 503", code)
	}
}
