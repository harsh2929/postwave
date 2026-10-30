// SPDX-License-Identifier: AGPL-3.0-only

package apikeys

import (
	"os"
	"strings"
	"testing"
)

func TestAPIKeyPrincipalMigrationNeverGuessesALegacyUser(t *testing.T) {
	raw, err := os.ReadFile(
		"../../../../infra/migrations/1828_api_key_user_principal.sql",
	)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := strings.ToLower(string(raw))
	for _, required := range []string{
		"add column if not exists user_id uuid",
		"foreign key (tenant_id, user_id)",
		"references users(tenant_id, id)",
		"legacy keys remain null",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"update api_keys",
		"set user_id =",
		"order by case users.role",
		"limit 1",
		"set not null",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("migration guesses or requires a legacy principal via %q", forbidden)
		}
	}
}
