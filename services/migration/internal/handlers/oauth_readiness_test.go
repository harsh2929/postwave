package handlers

import (
	"github.com/postwave/migrate/canonical"
	"testing"
)

func TestOAuthRequiresCompleteAppAndSafeCallback(t *testing.T) {
	for _, source := range []canonical.SourcePlatform{canonical.SourceMailchimp, canonical.SourceConvertKit} {
		t.Run(string(source), func(t *testing.T) {
			prefix := "MAILCHIMP"
			if source == canonical.SourceConvertKit {
				prefix = "CONVERTKIT"
			}
			t.Setenv(prefix+"_CLIENT_ID", "app")
			t.Setenv(prefix+"_CLIENT_SECRET", "secret")
			t.Setenv("POSTWAVE_ENV", "staging")
			for _, raw := range []string{"", "/callback", "http://localhost/callback", "http://app.example/callback", "https://user:pass@app.example/callback", "https://app.example/callback#fragment"} {
				if ok, _ := NewMigration(raw).oauthReady(source); ok {
					t.Fatalf("unsafe callback accepted: %s", raw)
				}
			}
			h := NewMigration("https://app.example/app/migrations/oauth/callback?source={source}")
			if ok, message := h.oauthReady(source); !ok {
				t.Fatal(message)
			}
			t.Setenv(prefix+"_CLIENT_SECRET", " \t ")
			if ok, _ := h.oauthReady(source); ok {
				t.Fatal("blank secret accepted")
			}
			t.Setenv(prefix+"_CLIENT_SECRET", "secret")
			t.Setenv("POSTWAVE_ENV", "development")
			if ok, message := NewMigration("http://localhost:3000/callback").oauthReady(source); !ok {
				t.Fatal(message)
			}
		})
	}
}
