// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEngagementClassificationMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1934_engagement_event_classification_v2.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE TABLE subscriber_event_observations",
		"CREATE TABLE event_classifications",
		"CREATE TABLE event_reclassification_runs",
		"worker_id                text",
		"lease_token              uuid",
		"lease_expires_at         timestamptz",
		"heartbeat_at             timestamptz",
		"attempt_count            integer NOT NULL DEFAULT 0",
		"classified_count + unchanged_count <= candidate_count",
		"state, lease_expires_at, updated_at, id",
		"active event reclassification lease cannot be stolen",
		"lease owner changes require a new token",
		"terminal event reclassification write changed lease identity",
		"event_reclassification_runs FORCE ROW LEVEL SECURITY",
		"current_setting('app.engagement_classifier_worker', true) = 'true'",
		"recipient_identity_hmac",
		"ordered_headers_complete boolean NOT NULL DEFAULT false",
		"privacy_expiry_at        timestamptz NOT NULL",
		"external engagement observation object requires exact-version deletion before database purge",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing required fragment %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"WITH CHECK (TRUE)",
		"GRANT DELETE ON EVENT_RECLASSIFICATION_RUNS",
		"GRANT UPDATE, DELETE ON EVENT_CLASSIFICATIONS",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration contains forbidden fragment %q", forbidden)
		}
	}
}
