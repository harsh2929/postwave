// SPDX-License-Identifier: AGPL-3.0-only
//
// parquet_archive_test.go — unit tests for the Parquet archive sink
// (retention-trail-archive, Compliance P1). The S3 PUT path itself is
// SigV4-only and is covered by s3_signer_test.go; here we focus on:
//
//   - schema correctness (round-trip read of EncodeArchive output)
//   - daily file partitioning + Hive layout in ArchiveKey
//   - parseArchiveConfig defaults + validation
//   - auditRowsToArchive metadata flattening
//
// These tests do not hit the network — they exercise pure encoding +
// path construction so they stay fast and deterministic.

package auditsink

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/parquet-go/parquet-go"
)

func TestArchiveKeyHivePartition(t *testing.T) {
	day := time.Date(2026, 6, 3, 12, 30, 0, 0, time.UTC)
	got := ArchiveKey("audit", "tenant-aaa", day, "")
	want := "audit/tenant=tenant-aaa/year=2026/month=06/day=03.parquet"
	if got != want {
		t.Fatalf("daily key: got %q want %q", got, want)
	}
}

func TestArchiveKeyBatchSuffix(t *testing.T) {
	day := time.Date(2026, 6, 3, 12, 30, 0, 0, time.UTC)
	got := ArchiveKey("audit/", "t1", day, "abcd1234")
	if !strings.HasSuffix(got, "day=03-abcd1234.parquet") {
		t.Fatalf("batch-suffixed key missing suffix: %q", got)
	}
	if strings.HasPrefix(got, "/") {
		t.Fatalf("key must not start with /: %q", got)
	}
}

func TestArchiveKeyPrefixCleanup(t *testing.T) {
	day := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := ArchiveKey("/audit//", "t1", day, "")
	// The leading/trailing slashes must be trimmed.
	if strings.HasPrefix(got, "/") || strings.Contains(got, "//") {
		t.Fatalf("ArchiveKey did not normalise prefix: %q", got)
	}
}

func TestParseArchiveConfigDefaults(t *testing.T) {
	cfg, err := parseArchiveConfig(map[string]any{
		"bucket": "b",
		"region": "us-east-1",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Bucket != "b" || cfg.Region != "us-east-1" {
		t.Fatalf("basic fields: %+v", cfg)
	}
	if cfg.Prefix != "audit" {
		t.Fatalf("prefix default: got %q want audit", cfg.Prefix)
	}
	if cfg.RetentionDays != DefaultArchiveRetentionDays {
		t.Fatalf("retention default: got %d want %d",
			cfg.RetentionDays, DefaultArchiveRetentionDays)
	}
	if cfg.ObjectLockMode != DefaultObjectLockMode {
		t.Fatalf("mode default: got %q want %q",
			cfg.ObjectLockMode, DefaultObjectLockMode)
	}
}

func TestParseArchiveConfigMissingBucket(t *testing.T) {
	_, err := parseArchiveConfig(map[string]any{"region": "us-east-1"})
	if err == nil {
		t.Fatalf("expected error on missing bucket")
	}
}

func TestParseArchiveConfigMissingRegion(t *testing.T) {
	_, err := parseArchiveConfig(map[string]any{"bucket": "b"})
	if err == nil {
		t.Fatalf("expected error on missing region")
	}
}

func TestParseArchiveConfigGovernanceMode(t *testing.T) {
	cfg, err := parseArchiveConfig(map[string]any{
		"bucket":           "b",
		"region":           "us-east-1",
		"object_lock_mode": "governance",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.ObjectLockMode != "GOVERNANCE" {
		t.Fatalf("normalised mode: got %q want GOVERNANCE", cfg.ObjectLockMode)
	}
}

func TestParseArchiveConfigRejectsUnknownMode(t *testing.T) {
	cfg, err := parseArchiveConfig(map[string]any{
		"bucket":           "b",
		"region":           "us-east-1",
		"object_lock_mode": "nonsense",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Unknown modes fall back to COMPLIANCE — never silently downgrade.
	if cfg.ObjectLockMode != "COMPLIANCE" {
		t.Fatalf("unknown mode fallback: got %q want COMPLIANCE",
			cfg.ObjectLockMode)
	}
}

func TestParseArchiveConfigNestedParquetConfig(t *testing.T) {
	// admin.Create wraps the user input under parquet_config; the
	// parser must follow that shape too.
	cfg, err := parseArchiveConfig(map[string]any{
		"parquet_config": map[string]any{
			"bucket":         "nested-bucket",
			"region":         "eu-north-1",
			"retention_days": float64(365),
		},
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Bucket != "nested-bucket" {
		t.Fatalf("nested bucket: got %q", cfg.Bucket)
	}
	if cfg.RetentionDays != 365 {
		t.Fatalf("nested retention: got %d", cfg.RetentionDays)
	}
}

func TestEncodeArchiveRoundTrip(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC)
	in := []ArchiveRow{
		{
			ID:        1,
			TenantID:  "t1",
			Action:    "subscriber.create",
			At:        now.UnixMilli(),
			WrittenAt: now,
			RowHash:   "deadbeef",
		},
		{
			ID:        2,
			TenantID:  "t1",
			Action:    "audit.retention.purge",
			Metadata:  `{"deleted_count":42}`,
			At:        now.Add(time.Second).UnixMilli(),
			WrittenAt: now,
		},
	}
	body, err := EncodeArchive(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(body) == 0 {
		t.Fatalf("empty parquet body")
	}
	// Magic bytes — Parquet files start with PAR1 and end with PAR1.
	if !bytes.HasPrefix(body, []byte("PAR1")) || !bytes.HasSuffix(body, []byte("PAR1")) {
		t.Fatalf("not a parquet file (missing PAR1 sentinels)")
	}
	// Round-trip read.
	reader := parquet.NewGenericReader[ArchiveRow](bytes.NewReader(body))
	defer func() { _ = reader.Close() }()
	out := make([]ArchiveRow, len(in))
	n, err := reader.Read(out)
	if err != nil && err.Error() != "EOF" {
		t.Fatalf("read: %v", err)
	}
	if n != len(in) {
		t.Fatalf("read rows: got %d want %d", n, len(in))
	}
	for i := range in {
		if out[i].ID != in[i].ID || out[i].Action != in[i].Action {
			t.Fatalf("row %d mismatch: got %+v want %+v", i, out[i], in[i])
		}
	}
}

func TestAuditRowsToArchiveFlattensMetadata(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC)
	rows := []AuditRow{{
		ID:       1,
		TenantID: "t",
		Action:   "x",
		At:       now,
		Metadata: map[string]any{"k": "v"},
	}}
	out := auditRowsToArchive(rows, now)
	if len(out) != 1 {
		t.Fatalf("len: %d", len(out))
	}
	if !strings.Contains(out[0].Metadata, `"k"`) {
		t.Fatalf("metadata not JSON-encoded: %q", out[0].Metadata)
	}
	if out[0].At != now.UnixMilli() {
		t.Fatalf("at_unix_ms: got %d want %d", out[0].At, now.UnixMilli())
	}
}

func TestArchiveAthenaDDLDocumentsSchema(t *testing.T) {
	// The DDL string is meant to be operator-readable + paste-into-Athena.
	// Anchoring on a few field names ensures schema drift breaks the test
	// before it silently breaks the doc.
	wantFields := []string{
		"id              BIGINT",
		"tenant_id       STRING",
		"action          STRING",
		"row_hash        STRING",
		"PARTITIONED BY (year STRING, month STRING, day STRING)",
		"STORED AS PARQUET",
	}
	for _, f := range wantFields {
		if !strings.Contains(ArchiveAthenaDDL, f) {
			t.Fatalf("ArchiveAthenaDDL missing %q", f)
		}
	}
}
