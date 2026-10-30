package config

import "testing"

// Both spellings of loopback must be dev-allowed, because a browser treats
// them as DIFFERENT ORIGINS. http://127.0.0.1:3000 and http://localhost:3000
// reach the same dev server, but only one of them used to pass the CSRF gate —
// so a developer who typed the numeric form saw every write 403 with
// "forbidden_origin" and an app that looked broken rather than misaddressed.
//
// Production is unaffected: CORS_ALLOWED_ORIGINS overrides this default, and
// these entries are loopback-only, which no external host can present.
func TestCORSDefaultsCoverBothLoopbackSpellings(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "")
	cfg := Load()

	allowed := make(map[string]bool, len(cfg.CORSAllowedOrigins))
	for _, o := range cfg.CORSAllowedOrigins {
		allowed[o] = true
	}

	for _, port := range []string{"3000", "5173", "1420"} {
		for _, host := range []string{"localhost", "127.0.0.1"} {
			want := "http://" + host + ":" + port
			if !allowed[want] {
				t.Errorf("dev CORS default is missing %q; a browser on that origin "+
					"gets forbidden_origin on every state-changing request", want)
			}
		}
	}
}
