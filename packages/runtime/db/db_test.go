package db

import "testing"

func TestPrivilegedRoleBypassIsLocalOnly(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	for _, configured := range []bool{false, true} {
		t.Run(map[bool]string{false: "environment", true: "config"}[configured], func(t *testing.T) {
			values := map[string]string{"POSTWAVE_ENV": "production"}
			if !configured {
				values["POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE"] = "1"
			}
			allowed, err := privilegedRoleBypassAllowed(configured, env(values))
			if err == nil || allowed {
				t.Fatalf("protected bypass = (%v, %v), want (false, error)", allowed, err)
			}
		})
	}

	allowed, err := privilegedRoleBypassAllowed(true, env(map[string]string{
		"POSTWAVE_ENV": "development",
	}))
	if err != nil || !allowed {
		t.Fatalf("local configured bypass = (%v, %v), want (true, nil)", allowed, err)
	}
}
