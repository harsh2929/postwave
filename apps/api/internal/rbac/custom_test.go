// SPDX-License-Identifier: AGPL-3.0-only
package rbac

import "testing"

func TestParsePermissions(t *testing.T) {
	got, err := ParsePermissions([]string{"campaigns.write", "reports.read"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 || got[0] != PermCampaignsWrite || got[1] != PermReportsRead {
		t.Fatalf("got %v", got)
	}
}

func TestParsePermissionsRejectsUnknown(t *testing.T) {
	// A custom role must never be able to grant a capability the platform does
	// not define — otherwise a typo or an injected value becomes a silent
	// grant. Fail closed and name the offenders.
	_, err := ParsePermissions([]string{"campaigns.write", "campaigns.delete_everything", ""})
	if err == nil {
		t.Fatal("expected an error for unknown permissions")
	}
}

func TestIsBuiltInRole(t *testing.T) {
	for _, r := range []string{"owner", "admin", "editor", "viewer", "member", " Owner "} {
		if !IsBuiltInRole(r) {
			t.Errorf("IsBuiltInRole(%q) = false, want true", r)
		}
	}
	for _, r := range []string{"", "support-agent", "custom"} {
		if IsBuiltInRole(r) {
			t.Errorf("IsBuiltInRole(%q) = true, want false", r)
		}
	}
}

func TestResolveGrantsBuiltInWins(t *testing.T) {
	// A built-in role always resolves from the matrix — a tenant cannot
	// redefine "admin" by inserting a custom role of the same name and
	// escalate/loosen it.
	custom := map[string][]Permission{"admin": {PermSubscribersRead}} // attempted override
	grants := ResolveGrants("admin", custom)
	if !CanGrants(grants, PermBillingManage) {
		t.Error("built-in admin lost billing.manage — custom override must not shadow a built-in role")
	}
}

func TestResolveGrantsCustomRole(t *testing.T) {
	// "support" is a custom role: campaigns read + reports read, nothing else.
	custom := map[string][]Permission{
		"support": {PermCampaignsRead, PermReportsRead},
	}
	grants := ResolveGrants("support", custom)
	if !CanGrants(grants, PermCampaignsRead) || !CanGrants(grants, PermReportsRead) {
		t.Error("custom role missing its granted permissions")
	}
	if CanGrants(grants, PermCampaignsWrite) || CanGrants(grants, PermBillingManage) {
		t.Error("custom role granted a permission it was not given")
	}
	// Case-insensitive role match.
	if !CanGrants(ResolveGrants(" Support ", custom), PermCampaignsRead) {
		t.Error("custom role match should be case-insensitive/trimmed")
	}
}

func TestResolveGrantsUnknownRoleFailsClosed(t *testing.T) {
	grants := ResolveGrants("ghost", map[string][]Permission{"support": {PermReportsRead}})
	if len(grants) != 0 {
		t.Errorf("unknown role resolved to %d grants, want 0 (fail closed)", len(grants))
	}
}
