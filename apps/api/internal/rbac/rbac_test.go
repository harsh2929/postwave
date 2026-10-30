// SPDX-License-Identifier: AGPL-3.0-only
package rbac

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCanBuiltInRoles(t *testing.T) {
	cases := []struct {
		role string
		perm Permission
		want bool
	}{
		// Owner can do everything, including the owner-exclusive lever.
		{"owner", PermAccountManage, true},
		{"owner", PermBillingManage, true},
		{"owner", PermCampaignsWrite, true},
		// Admin is fully privileged EXCEPT the owner-exclusive account lever
		// (ownership transfer / close account).
		{"admin", PermBillingManage, true},
		{"admin", PermMembersManage, true},
		{"admin", PermAccountManage, false},
		// Editor: content read+write, but NOT billing/admin/transactional.
		// This is the exact distinction the register says was missing —
		// "may edit campaigns but not billing".
		{"editor", PermCampaignsWrite, true},
		{"editor", PermSubscribersWrite, true},
		{"editor", PermReportsRead, true},
		{"editor", PermBillingManage, false},
		{"editor", PermAPIKeysManage, false},
		{"editor", PermTransactionalSend, false},
		{"editor", PermAuditConfigure, false},
		// Viewer: read-only. The register's headline defect was that editor
		// and viewer were indistinguishable; here they diverge on writes.
		{"viewer", PermCampaignsRead, true},
		{"viewer", PermReportsRead, true},
		{"viewer", PermCampaignsWrite, false},
		{"viewer", PermSubscribersWrite, false},
		// Member behaves like viewer (read-only).
		{"member", PermCampaignsRead, true},
		{"member", PermCampaignsWrite, false},
		// Case-insensitive + trimmed.
		{" Editor ", PermCampaignsWrite, true},
		{"EDITOR", PermBillingManage, false},
		// Unknown / empty role fails closed on every permission.
		{"", PermCampaignsRead, false},
		{"superuser", PermCampaignsRead, false},
	}
	for _, tc := range cases {
		if got := Can(tc.role, tc.perm); got != tc.want {
			t.Errorf("Can(%q, %q) = %v, want %v", tc.role, tc.perm, got, tc.want)
		}
	}
}

func TestEditorAndViewerAreDistinguishable(t *testing.T) {
	// The whole point of G-48: there must exist at least one permission that
	// separates editor from viewer.
	var diverged bool
	for _, p := range AllPermissions() {
		if Can("editor", p) != Can("viewer", p) {
			diverged = true
			break
		}
	}
	if !diverged {
		t.Fatal("editor and viewer grant identical permissions — the exact defect G-48 names")
	}
}

func TestPermissionsForRoleIsMonotonic(t *testing.T) {
	// Owner ⊇ admin ⊇ editor ⊇ viewer for the shared (non-owner-exclusive)
	// permissions — a sanity check that the tiers nest rather than criss-cross.
	shared := func(role string) map[Permission]bool {
		m := map[Permission]bool{}
		for _, p := range PermissionsForRole(role) {
			if p == PermAccountManage {
				continue // owner-exclusive; excluded from the nesting check
			}
			m[p] = true
		}
		return m
	}
	owner, admin, editor, viewer := shared("owner"), shared("admin"), shared("editor"), shared("viewer")
	for p := range admin {
		if !owner[p] {
			t.Errorf("admin has %q but owner does not", p)
		}
	}
	for p := range editor {
		if !admin[p] {
			t.Errorf("editor has %q but admin does not", p)
		}
	}
	for p := range viewer {
		if !editor[p] {
			t.Errorf("viewer has %q but editor does not", p)
		}
	}
}

func TestRequirePermission(t *testing.T) {
	roleOf := func(r *http.Request) (string, bool) {
		role := r.Header.Get("X-Test-Role")
		return role, role != ""
	}
	handler := RequirePermission(PermCampaignsWrite, roleOf)(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)
	check := func(role string, wantStatus int) {
		req := httptest.NewRequest(http.MethodPost, "/x", nil)
		if role != "no-principal" {
			req.Header.Set("X-Test-Role", role)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != wantStatus {
			t.Errorf("role=%q status=%d, want %d", role, rec.Code, wantStatus)
		}
	}
	check("editor", http.StatusOK)        // has campaigns.write
	check("viewer", http.StatusForbidden) // lacks it
	check("no-principal", http.StatusUnauthorized)
}
