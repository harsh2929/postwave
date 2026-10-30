// SPDX-License-Identifier: AGPL-3.0-only

package snowflakeminicore

import (
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/snowflakeminicore/snowflakeminicoretest"
)

// Whether the driver obeys Env, and whether this package runs before the
// driver, can only be seen in a binary that links the driver. That is
// snowflakeminicoretest.RequireLoaderOff, which the tests of internal/warehouse
// and internal/zerocopy_triggers run. This file covers the decision itself.
func TestApplyDefault(t *testing.T) {
	for _, tc := range []struct {
		name     string
		present  bool
		value    string
		wantSets int
		wantNext string
	}{
		{name: "unset turns the loader off", present: false, wantSets: 1, wantNext: "true"},
		{name: "blank turns the loader off", present: true, value: "", wantSets: 1, wantNext: "true"},
		{name: "an operator's false is kept", present: true, value: "false", wantSets: 0, wantNext: "false"},
		{name: "an operator's true is kept", present: true, value: "true", wantSets: 0, wantNext: "true"},
		{name: "any other operator value is kept", present: true, value: "0", wantSets: 0, wantNext: "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{}
			if tc.present {
				env[Env] = tc.value
			}
			var lookups []string
			lookup := func(name string) (string, bool) {
				lookups = append(lookups, name)
				v, ok := env[name]
				return v, ok
			}
			sets := 0
			set := func(name, value string) error {
				sets++
				if name != Env {
					t.Errorf("set %q; the only variable this package may write is %s", name, Env)
				}
				env[name] = value
				return nil
			}

			if err := applyDefault(lookup, set); err != nil {
				t.Fatalf("applyDefault: %v", err)
			}
			if len(lookups) != 1 || lookups[0] != Env {
				t.Errorf("looked up %q, want exactly [%s]", lookups, Env)
			}
			if sets != tc.wantSets {
				t.Errorf("set called %d times, want %d", sets, tc.wantSets)
			}
			if got := env[Env]; got != tc.wantNext {
				t.Errorf("%s = %q afterwards, want %q", Env, got, tc.wantNext)
			}
		})
	}
}

// A failed write is returned, not swallowed, so a caller other than init can
// act on it. init discards it on purpose; see the comment there.
func TestApplyDefaultReturnsTheWriteError(t *testing.T) {
	want := errors.New("setenv refused")
	err := applyDefault(
		func(string) (string, bool) { return "", false },
		func(string, string) error { return want },
	)
	if !errors.Is(err, want) {
		t.Fatalf("applyDefault error = %v, want %v", err, want)
	}
}

// snowflakeminicoretest spells out this package's import path and variable,
// because it must not import this package. A move or a rename that leaves
// its copies behind would make every order check look for a package that no
// binary initializes.
func TestTheOrderCheckNamesThisPackage(t *testing.T) {
	if snowflakeminicoretest.GuardPackage != guardImportPath {
		t.Errorf("snowflakeminicoretest.GuardPackage = %q, but this package is %q", snowflakeminicoretest.GuardPackage, guardImportPath)
	}
	if snowflakeminicoretest.Env != Env {
		t.Errorf("snowflakeminicoretest.Env = %q, but this package sets %q", snowflakeminicoretest.Env, Env)
	}
	if snowflakeminicoretest.DriverPackage != driverImportPath {
		t.Errorf("snowflakeminicoretest.DriverPackage = %q, but the import scan looks for %q", snowflakeminicoretest.DriverPackage, driverImportPath)
	}
}
