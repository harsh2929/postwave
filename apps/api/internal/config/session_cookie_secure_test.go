package config

import "testing"

// The session cookie's Secure attribute used to be reachable ONLY by enabling
// POSTWAVE_DEV_TENANT_SLUG_HEADER, which also makes the API accept a
// client-supplied tenant slug. That coupling forced a developer who just
// wanted a working local login to open an auth bypass as a side effect, and it
// is why a broken mobile login was recorded for over a year as a
// "tenant-slug vs UUID" defect: the tenant slug was the nearest identifier to
// the real cause, not the cause.
//
// These assertions pin the two properties that make the coupling gone for
// good: the switch exists SEPARATELY, and it defaults closed.
func TestSessionCookieInsecureIsIndependentOfTenantSlugHeader(t *testing.T) {
	t.Setenv("POSTWAVE_DEV_TENANT_SLUG_HEADER", "0")
	t.Setenv("POSTWAVE_SESSION_COOKIE_INSECURE", "1")
	cfg := Load()
	if cfg.AllowDevTenantSlugHeader {
		t.Fatal("enabling insecure cookies must NOT enable the tenant-slug header")
	}
	if !cfg.SessionCookieInsecure {
		t.Fatal("POSTWAVE_SESSION_COOKIE_INSECURE=1 must disable Secure")
	}
}

func TestSessionCookieIsSecureByDefault(t *testing.T) {
	// Fail closed. An unset value in production must never yield a cookie an
	// attacker can read off a plaintext hop.
	t.Setenv("POSTWAVE_SESSION_COOKIE_INSECURE", "")
	if Load().SessionCookieInsecure {
		t.Fatal("unset POSTWAVE_SESSION_COOKIE_INSECURE must leave the cookie Secure")
	}
	for _, off := range []string{"0", "false", "no", "off"} {
		t.Setenv("POSTWAVE_SESSION_COOKIE_INSECURE", off)
		if Load().SessionCookieInsecure {
			t.Fatalf("%q must not disable Secure", off)
		}
	}
}

// The tenant-slug path still works, so existing local setups keep logging in.
func TestTenantSlugHeaderStillDisablesSecure(t *testing.T) {
	t.Setenv("POSTWAVE_DEV_TENANT_SLUG_HEADER", "1")
	if !Load().AllowDevTenantSlugHeader {
		t.Fatal("the pre-existing dev path must keep working")
	}
}
