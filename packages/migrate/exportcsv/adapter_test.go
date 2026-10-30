// SPDX-License-Identifier: MIT

package exportcsv

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestExportCSVAdapterPreservesSourcePlatform(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "constant-contact.csv")
	body := "email,first_name,status,subscribed_at,tags\nada@example.com,Ada,active,2024-01-02,VIP\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	ad := New(canonical.SourceConstantContact, "constant_contact_csv_export")
	caps := ad.Capabilities()
	if caps.Source != canonical.SourceConstantContact || caps.AuthMethod != "csv_upload" || !caps.Supports.Subscribers {
		t.Fatalf("unexpected capabilities: %+v", caps)
	}

	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{
		AccountID: "cc-export.csv",
		Extra: map[string]string{
			"csv_path":    path,
			"audience_id": "aud_123",
		},
	})
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	rep, err := ad.Discover(context.Background(), sess)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if rep.SubscribersTotal != 1 {
		t.Fatalf("subscribers total = %d", rep.SubscribersTotal)
	}

	subs, next, err := ad.ListSubscribers(context.Background(), sess, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if next != "" || len(subs) != 1 {
		t.Fatalf("next=%q subs=%d", next, len(subs))
	}
	if subs[0].SourcePlatform != canonical.SourceConstantContact {
		t.Fatalf("source platform = %q", subs[0].SourcePlatform)
	}
	if subs[0].CustomFields["postwave_migration_source_format"] != "constant_contact_csv_export" ||
		subs[0].CustomFields["source_audience_id"] != "aud_123" {
		t.Fatalf("custom fields = %+v", subs[0].CustomFields)
	}
}
