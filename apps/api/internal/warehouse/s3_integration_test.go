package warehouse

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/postwave/postwave/apps/api/internal/uploads"
)

// TestPollImportObjectsAgainstRealS3 exercises the import poller against
// a live S3 bucket. Skipped unless WAREHOUSE_S3_TEST_BUCKET is set (the
// CI/dev flow that runs this is responsible for tearing the bucket down).
// The test isolates itself by writing under a unique tenant prefix so it
// cannot collide with other consumers of the same bucket.
func TestPollImportObjectsAgainstRealS3(t *testing.T) {
	bucket := os.Getenv("WAREHOUSE_S3_TEST_BUCKET")
	if bucket == "" {
		t.Skip("WAREHOUSE_S3_TEST_BUCKET not set; skipping live S3 import poll test")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		t.Fatalf("aws cfg: %v", err)
	}
	client := s3.NewFromConfig(cfg)
	store := uploads.NewS3Store(client, bucket, os.Getenv("AWS_KMS_TEST_KEY_ID"))

	tenant := "klv08-smoke-" + time.Now().UTC().Format("20060102T150405")
	connID := "conn-smoke"
	prefix := fmt.Sprintf("warehouse/imports/%s/orders/", connID)

	// Seed three lex-ordered JSONL files, one with a deliberately bad row.
	files := map[string]string{
		prefix + "001.jsonl": `{"subscriber_id":"s1","event_name":"viewed"}` + "\n" +
			`{"subscriber_id":"s2","event_name":"viewed","properties":{"sku":"A"}}` + "\n",
		prefix + "002.jsonl": `oops-not-json` + "\n" +
			`{"subscriber_id":"s3","event_name":"ordered"}` + "\n",
		prefix + "003.jsonl": `{"subscriber_id":"s4","event_name":"checked_out"}` + "\n",
	}
	cleanup := func() {
		for key := range files {
			_ = store.Delete(context.Background(), tenant, key)
		}
	}
	t.Cleanup(cleanup)

	for key, body := range files {
		if _, err := store.Put(ctx, tenant, key, "application/x-ndjson", bytes.NewReader([]byte(body))); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}

	// First poll: cursor empty → expect every object and three good rows + 1 parse error.
	conn := Connection{ID: connID, Provider: "s3"}
	result, err := pollImportObjects(ctx, store, tenant, conn, 10)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	t.Logf("objectsRead=%v rows=%d parseErrors=%+v advancedCursor=%q", result.objectsRead, len(result.rows), result.parseErrors, result.advancedCursor)
	for i, row := range result.rows {
		t.Logf("row[%d] source=%q sub=%q event=%q", i, row.SourceObject, row.SubscriberID, row.EventName)
	}
	if len(result.objectsRead) != 3 {
		t.Fatalf("objectsRead = %d want 3", len(result.objectsRead))
	}
	if len(result.rows) != 4 {
		t.Fatalf("rows = %d want 4 (%+v)", len(result.rows), result.rows)
	}
	if len(result.parseErrors) != 1 {
		t.Fatalf("parseErrors = %d want 1 (%+v)", len(result.parseErrors), result.parseErrors)
	}
	if !strings.HasSuffix(result.advancedCursor, "003.jsonl") {
		t.Fatalf("advancedCursor = %q (want suffix 003.jsonl)", result.advancedCursor)
	}

	// Second poll with the same cursor: idempotent — no new objects.
	conn.LastCursor = result.advancedCursor
	second, err := pollImportObjects(ctx, store, tenant, conn, 10)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(second.objectsRead) != 0 || len(second.rows) != 0 {
		t.Fatalf("second poll re-read objects: %d objects %d rows", len(second.objectsRead), len(second.rows))
	}
}
