// SPDX-License-Identifier: AGPL-3.0-only

package regions

import "testing"

func TestParseRegionPools_HappyPath(t *testing.T) {
	in := "us-east-1=postgres://us-host:5432/db, eu-central-1=postgres://eu-host:5432/db"
	out, err := ParseRegionPools(in)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out["us-east-1"] != "postgres://us-host:5432/db" {
		t.Errorf("us-east-1=%q", out["us-east-1"])
	}
	if out["eu-central-1"] != "postgres://eu-host:5432/db" {
		t.Errorf("eu-central-1=%q", out["eu-central-1"])
	}
}

func TestParseRegionPools_EmptyOK(t *testing.T) {
	out, err := ParseRegionPools("")
	if err != nil {
		t.Fatalf("err on empty: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("expected empty map, got %d entries", len(out))
	}
}

func TestParseRegionPools_RejectsInvalid(t *testing.T) {
	cases := []string{
		"no-equals-sign",
		"=missing-region",
		"us-east-1=",                  // empty url
		"bogus-region=postgres://...", // not in Allowed()
	}
	for _, c := range cases {
		if _, err := ParseRegionPools(c); err == nil {
			t.Errorf("expected error for %q, got nil", c)
		}
	}
}

func TestRegistry_LocalAndForRegion(t *testing.T) {
	r := NewRegistry("us-east-1")
	// No pools yet — Local() returns nil; ForRegion returns
	// ErrUnreachableRegion.
	if r.Local() != nil {
		t.Error("Local() should be nil before Register")
	}
	if _, err := r.ForRegion("us-east-1"); err == nil {
		t.Error("ForRegion should error before Register")
	}
}
