// SPDX-License-Identifier: MIT

package sendy

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestSendyCSVExportAdapter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sendy.csv")
	csv := "email,name,status,subscribed_at,tags\nalice@example.com,Alice,Subscribed,2024-01-02,VIP\nbob@example.com,Bob,Unsubscribed,2024-01-03,Churned\n"
	if err := os.WriteFile(path, []byte(csv), 0o600); err != nil {
		t.Fatal(err)
	}

	ad := New()
	caps := ad.Capabilities()
	if caps.Source != canonical.SourceSendy || caps.AuthMethod != "csv_upload" || !caps.Supports.Subscribers {
		t.Fatalf("unexpected capabilities: %+v", caps)
	}

	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{
		AccountID: "sendy-export.csv",
		Extra: map[string]string{
			"csv_path": path,
			"list_id":  "abc123",
		},
	})
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if sess.Source != canonical.SourceSendy {
		t.Fatalf("session source = %q", sess.Source)
	}

	discovery, err := ad.Discover(context.Background(), sess)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if discovery.SubscribersTotal != 2 {
		t.Fatalf("subscribers total = %d", discovery.SubscribersTotal)
	}

	subs, next, err := ad.ListSubscribers(context.Background(), sess, "")
	if err != nil {
		t.Fatalf("list subscribers: %v", err)
	}
	if next != "" {
		t.Fatalf("next cursor = %q", next)
	}
	if len(subs) != 2 {
		t.Fatalf("subscriber count = %d", len(subs))
	}
	if subs[0].SourcePlatform != canonical.SourceSendy {
		t.Fatalf("source platform = %q", subs[0].SourcePlatform)
	}
	if subs[0].CustomFields["sendy_list_id"] != "abc123" {
		t.Fatalf("sendy list id not preserved: %+v", subs[0].CustomFields)
	}
}
