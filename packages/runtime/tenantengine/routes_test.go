package tenantengine

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func routeFixture() Route {
	return Route{TenantID: "00000000-0000-4000-8000-000000000001", DestinationID: "00000000-0000-4000-8000-000000000101", BaseURL: "https://engine-a.example.test", AdminUser: "api", AdminPassword: "secret-not-for-errors"}
}

func TestRegistryRejectsAmbiguousRoutingAndMalformedConfiguration(t *testing.T) {
	base := routeFixture()
	other := base
	other.TenantID = "00000000-0000-4000-8000-000000000002"
	other.DestinationID = "00000000-0000-4000-8000-000000000102"
	other.BaseURL = "https://ENGINE-A.example.test:443/"
	raw, _ := json.Marshal([]Route{base, other})
	for _, input := range []string{string(raw), `[]`, `null`, `[{}]`, `[`, `[{"admin_password":"secret-not-for-errors","extra":true}]`} {
		_, err := Parse(input)
		if err == nil {
			t.Fatalf("accepted invalid route configuration")
		}
		if strings.Contains(err.Error(), base.AdminPassword) {
			t.Fatal("credential echoed")
		}
	}
	other.BaseURL = "https://engine-b.example.test"
	raw, _ = json.Marshal([]Route{base, other})
	reg, err := Parse(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []Route{base, other} {
		got, err := reg.Resolve(want.TenantID)
		if err != nil || got != want {
			t.Fatalf("wrong route: %v", err)
		}
	}
	for _, missing := range []string{"", "untrusted", "00000000-0000-4000-8000-000000000003"} {
		if _, err := reg.Resolve(missing); err == nil {
			t.Fatal("unknown tenant fell through")
		}
	}
	if Tenant(WithTenant(context.Background(), base.TenantID)) != base.TenantID {
		t.Fatal("tenant context missing")
	}
}

func TestRegistryRejectsReusedIdentityAndUnsafeURLs(t *testing.T) {
	for _, change := range []func(*Route){
		func(r *Route) { r.BaseURL = "https://engine-b.test" }, // same tenant + instance
		func(r *Route) {
			r.TenantID = "00000000-0000-4000-8000-000000000002"
			r.BaseURL = "https://engine-b.test"
		}, // same instance
		func(r *Route) { r.BaseURL = "https://user:secret@example.test" },
		func(r *Route) { r.BaseURL = "file:///tmp/engine" },
		func(r *Route) { r.BaseURL = "https://engine.test/../engine" },
		func(r *Route) { r.BaseURL = "https://engine.test/%2e%2e" },
		func(r *Route) { r.AdminPassword = " " },
	} {
		original, other := routeFixture(), routeFixture()
		change(&other)
		raw, _ := json.Marshal([]Route{original, other})
		if _, err := Parse(string(raw)); err == nil {
			t.Fatal("accepted reused/unsafe route")
		}
	}
}
