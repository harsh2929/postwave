// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRevisionTrackingIdentityMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1936_campaign_revision_tracking_identity.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS tracking_settings jsonb NOT NULL DEFAULT '{}'::jsonb",
		"campaign_content_revisions_tracking_settings_object_check",
		"jsonb_typeof(tracking_settings) = 'object'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("tracking-identity migration missing %q", required)
		}
	}
}
