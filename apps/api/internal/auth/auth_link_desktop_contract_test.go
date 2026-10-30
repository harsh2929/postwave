// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

type desktopAuthContractFixtures struct {
	Version  int                          `json:"version"`
	Audience string                       `json:"audience"`
	Cases    []desktopAuthContractFixture `json:"cases"`
}

type desktopAuthContractFixture struct {
	Source    string `json:"source"`
	Flow      string `json:"flow"`
	Token     string `json:"token"`
	State     string `json:"state"`
	Signature string `json:"signature"`
	NativeURL string `json:"native_url"`
}

// This fixture is consumed by the API signer, Rust native validator, and
// renderer parser tests. It prevents each layer from proving a different,
// internally-consistent auth-link shape again.
func TestDesktopAuthLinkV1CrossLayerFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "desktop", "auth-link-v1-contract-fixtures.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures desktopAuthContractFixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if fixtures.Version != authLinkVersion || fixtures.Audience != authLinkAudienceMobile {
		t.Fatalf("shared contract metadata drifted: version=%d audience=%q", fixtures.Version, fixtures.Audience)
	}
	if len(fixtures.Cases) != 3 {
		t.Fatalf("fixture count=%d, want magic email + OAuth callback + reset", len(fixtures.Cases))
	}

	wantSources := map[string]bool{
		"magic_email":    false,
		"oauth_callback": false,
		"password_reset": false,
	}
	// Fixed test-only HMAC key used to make the public contract vectors
	// deterministic. Production keys are deployment secrets and never enter
	// fixtures or source control.
	key := []byte("0123456789abcdef0123456789abcdef")
	for _, fixture := range fixtures.Cases {
		if _, ok := wantSources[fixture.Source]; !ok {
			t.Fatalf("unknown fixture source %q", fixture.Source)
		}
		wantSources[fixture.Source] = true
		binding := authLinkBinding{
			Version:  fixtures.Version,
			Flow:     fixture.Flow,
			Audience: fixtures.Audience,
			State:    fixture.State,
		}
		gotSignature, signErr := signAuthLink(key, fixture.Token, binding)
		if signErr != nil {
			t.Fatalf("sign %s: %v", fixture.Source, signErr)
		}
		if gotSignature != fixture.Signature {
			t.Fatalf("%s signature=%q, want %q", fixture.Source, gotSignature, fixture.Signature)
		}
		if verifyErr := (&Deps{AuthLinkSigningKey: key}).verifyAuthLinkProof(
			fixture.Token,
			fixture.Flow,
			AuthLinkProofFields{
				LinkVersion:   fixtures.Version,
				LinkFlow:      fixture.Flow,
				LinkAudience:  fixtures.Audience,
				State:         fixture.State,
				LinkSignature: fixture.Signature,
			},
		); verifyErr != nil {
			t.Fatalf("verify %s: %v", fixture.Source, verifyErr)
		}

		native, parseErr := url.Parse(fixture.NativeURL)
		if parseErr != nil {
			t.Fatalf("parse native URL for %s: %v", fixture.Source, parseErr)
		}
		query := native.Query()
		if native.Scheme != "moosewave" || native.Host != "auth" ||
			native.Path != "/"+fixture.Flow || query.Get("token") != fixture.Token ||
			query.Get("v") != "1" || query.Get("flow") != fixture.Flow ||
			query.Get("aud") != fixtures.Audience || query.Get("state") != fixture.State ||
			query.Get("sig") != fixture.Signature {
			t.Fatalf("%s native URL does not preserve the signed envelope: %s", fixture.Source, fixture.NativeURL)
		}
	}
	for source, seen := range wantSources {
		if !seen {
			t.Errorf("missing required fixture source %s", source)
		}
	}
}
