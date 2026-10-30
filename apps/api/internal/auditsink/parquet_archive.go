// SPDX-License-Identifier: AGPL-3.0-only
//
// parquet_archive.go — Parquet archive sink (kind=archive).
//
// Writes one Parquet file per tenant per UTC day to S3 with Object
// Lock enabled (WORM). Files land at:
//
//   s3://<bucket>/<prefix>/tenant=<tenant_id>/year=<yyyy>/month=<mm>/day=<dd>.parquet
//
// The Hive-style partition layout above is directly queryable from
// AWS Athena and AWS Glue without manual DDL once the table is
// registered. The Glue/Athena schema is documented at the bottom of
// this file (see ArchiveAthenaDDL).
//
// Object Lock: every PUT carries an x-amz-object-lock-mode header
// (COMPLIANCE by default, GOVERNANCE optional) plus an
// x-amz-object-lock-retain-until-date computed from
// parquet_config.retention_days. Once written under COMPLIANCE mode
// the file CANNOT be deleted or overwritten before the retention
// date elapses — even by the root account. GOVERNANCE mode permits
// privileged deletion (s3:BypassGovernanceRetention) for staging
// rollouts. Object-Lock legal_hold can additionally be flipped on
// the bucket via parquet_config.object_lock_legal_hold.
//
// File-naming consequence: writing the same partition twice (e.g.
// catch-up after a worker outage) collides with the day-key. We use
// a content-hash suffix `<dd>-<batchID>.parquet` to avoid the collision
// while keeping the day partition queryable.

package auditsink

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/parquet-go/parquet-go"
)

// ArchiveRow is the row schema written to Parquet. Field tags drive
// the Parquet column types so the schema stays Glue/Athena compatible
// without a separate DDL build step. Order matches the AthenaDDL
// constant at the bottom of this file.
type ArchiveRow struct {
	ID           int64     `parquet:"id,plain"`
	TenantID     string    `parquet:"tenant_id,plain"`
	UserID       string    `parquet:"user_id,plain,optional"`
	Action       string    `parquet:"action,plain"`
	ResourceType string    `parquet:"resource_type,plain,optional"`
	ResourceID   string    `parquet:"resource_id,plain,optional"`
	Metadata     string    `parquet:"metadata,plain,optional"`
	IP           string    `parquet:"ip,plain,optional"`
	UserAgent    string    `parquet:"user_agent,plain,optional"`
	ActorType    string    `parquet:"actor_type,plain,optional"`
	ActorLabel   string    `parquet:"actor_label,plain,optional"`
	At           int64     `parquet:"at_unix_ms,plain"`
	RowHash      string    `parquet:"row_hash,plain,optional"`
	PrevHash     string    `parquet:"prev_hash,plain,optional"`
	EventID      string    `parquet:"event_id,plain,optional"`
	WrittenAt    time.Time `parquet:"written_at,timestamp(millisecond)"`
}

// ArchiveConfig is the parsed shape of audit_sinks.parquet_config.
// Defaults below are applied by parseArchiveConfig so the worker
// can ship a sane configuration even when the operator only filled
// in bucket + region.
type ArchiveConfig struct {
	Bucket              string `json:"bucket"`
	Prefix              string `json:"prefix"`
	Region              string `json:"region"`
	RetentionDays       int    `json:"retention_days"`
	ObjectLockMode      string `json:"object_lock_mode"`
	ObjectLockLegalHold bool   `json:"object_lock_legal_hold"`
}

// Default Object Lock settings — 7 years (SOC 2 / HIPAA upper bound)
// in COMPLIANCE mode. Operators can override via parquet_config.
const (
	DefaultArchiveRetentionDays = 2555
	DefaultObjectLockMode       = "COMPLIANCE"
)

// parseArchiveConfig pulls the canonical ArchiveConfig from the
// sink's config map. Returns an error when bucket / region are
// missing; defaults the rest.
func parseArchiveConfig(cfg map[string]any) (ArchiveConfig, error) {
	out := ArchiveConfig{
		RetentionDays:  DefaultArchiveRetentionDays,
		ObjectLockMode: DefaultObjectLockMode,
	}
	if cfg == nil {
		return out, errors.New("archive: parquet_config missing")
	}
	pc, _ := cfg["parquet_config"].(map[string]any)
	src := cfg
	if pc != nil {
		src = pc
	}
	if v, ok := src["bucket"].(string); ok {
		out.Bucket = strings.TrimSpace(v)
	}
	if v, ok := src["prefix"].(string); ok {
		out.Prefix = strings.Trim(strings.TrimSpace(v), "/")
	}
	if v, ok := src["region"].(string); ok {
		out.Region = strings.TrimSpace(v)
	}
	if v, ok := src["retention_days"].(float64); ok && v > 0 {
		out.RetentionDays = int(v)
	}
	if v, ok := src["object_lock_mode"].(string); ok {
		m := strings.ToUpper(strings.TrimSpace(v))
		if m == "COMPLIANCE" || m == "GOVERNANCE" {
			out.ObjectLockMode = m
		}
	}
	if v, ok := src["object_lock_legal_hold"].(bool); ok {
		out.ObjectLockLegalHold = v
	}
	if out.Bucket == "" {
		return out, errors.New("archive: bucket required")
	}
	if out.Region == "" {
		return out, errors.New("archive: region required")
	}
	if out.Prefix == "" {
		out.Prefix = "audit"
	}
	return out, nil
}

// EncodeArchive encodes the rows as Parquet bytes. Exposed for tests
// (parquet_archive_test.go round-trips the encoding).
func EncodeArchive(rows []ArchiveRow) ([]byte, error) {
	var buf bytes.Buffer
	w := parquet.NewGenericWriter[ArchiveRow](&buf)
	if _, err := w.Write(rows); err != nil {
		_ = w.Close()
		return nil, fmt.Errorf("parquet write: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("parquet close: %w", err)
	}
	return buf.Bytes(), nil
}

// ArchiveKey builds the Hive-partitioned S3 key for a given tenant /
// day / batch suffix.
func ArchiveKey(prefix, tenantID string, day time.Time, batchSuffix string) string {
	day = day.UTC()
	key := fmt.Sprintf(
		"%s/tenant=%s/year=%04d/month=%02d/day=%02d.parquet",
		strings.Trim(prefix, "/"), tenantID,
		day.Year(), int(day.Month()), day.Day(),
	)
	if batchSuffix != "" {
		key = fmt.Sprintf(
			"%s/tenant=%s/year=%04d/month=%02d/day=%02d-%s.parquet",
			strings.Trim(prefix, "/"), tenantID,
			day.Year(), int(day.Month()), day.Day(), batchSuffix,
		)
	}
	return key
}

// auditRowsToArchive maps the worker's canonical AuditRow into the
// Parquet schema. Metadata is JSON-flattened to a string column so
// schema evolution doesn't trigger a Glue redeploy — Athena's
// json_extract handles per-key access lazily.
func auditRowsToArchive(rows []AuditRow, writtenAt time.Time) []ArchiveRow {
	out := make([]ArchiveRow, 0, len(rows))
	for _, r := range rows {
		metaJSON := ""
		if len(r.Metadata) > 0 {
			b, _ := serializeMetadata(r.Metadata)
			metaJSON = string(b)
		}
		out = append(out, ArchiveRow{
			ID:           r.ID,
			TenantID:     r.TenantID,
			UserID:       r.UserID,
			Action:       r.Action,
			ResourceType: r.ResourceType,
			ResourceID:   r.ResourceID,
			Metadata:     metaJSON,
			IP:           r.IP,
			UserAgent:    r.UserAgent,
			ActorType:    r.ActorType,
			ActorLabel:   r.ActorLabel,
			At:           r.At.UnixMilli(),
			RowHash:      r.RowHash,
			PrevHash:     r.PrevHash,
			EventID:      r.EventID,
			WrittenAt:    writtenAt,
		})
	}
	return out
}

// deliverArchive ships a batch to S3 as a Parquet object. Each
// invocation produces one file keyed by today's UTC date plus a
// content hash to avoid intra-day collisions when a tick produces
// multiple batches.
func (d *Deps) deliverArchive(ctx context.Context, s Sink, rows []AuditRow) error {
	cfg, err := parseArchiveConfig(s.Config)
	if err != nil {
		return err
	}
	// Credentials are independent of parquet_config so the operator
	// can rotate IAM keys without touching the layout.
	creds, err := d.decryptCreds(ctx, s)
	if err != nil {
		return fmt.Errorf("archive: decrypt creds: %w", err)
	}
	access := creds["aws_access_key_id"]
	secret := creds["aws_secret_access_key"]
	if access == "" || secret == "" {
		return errors.New("archive: aws_access_key_id and aws_secret_access_key required")
	}
	now := time.Now().UTC()
	archiveRows := auditRowsToArchive(rows, now)
	body, err := EncodeArchive(archiveRows)
	if err != nil {
		return err
	}
	// Batch suffix: short content hash so distinct batches under the
	// same UTC day each get a unique key.
	batchHash := sha256.Sum256([]byte(fmt.Sprintf("%d-%d-%d", rows[0].ID, rows[len(rows)-1].ID, len(rows))))
	batchSuffix := hex.EncodeToString(batchHash[:4])
	key := ArchiveKey(cfg.Prefix, s.TenantID, now, batchSuffix)
	retainUntil := now.AddDate(0, 0, cfg.RetentionDays)
	return s3PutObjectWithLock(ctx, d.httpClient(),
		cfg.Region, cfg.Bucket, key, access, secret, body,
		cfg.ObjectLockMode, cfg.ObjectLockLegalHold, retainUntil)
}

// s3PutObjectWithLock is s3PutObject extended with Object Lock
// headers (x-amz-object-lock-mode, x-amz-object-lock-retain-until-date,
// x-amz-object-lock-legal-hold). Bucket-level Object Lock must already
// be enabled on the target bucket for these headers to take effect;
// the underlying API returns 400 InvalidRequest otherwise.
func s3PutObjectWithLock(
	ctx context.Context,
	httpC *http.Client,
	region, bucket, key, accessKey, secretKey string,
	body []byte,
	objectLockMode string,
	legalHold bool,
	retainUntil time.Time,
) error {
	host := bucket + ".s3." + region + ".amazonaws.com"
	rawURL := "https://" + host + "/" + escapeS3Key(key)
	if err := validateAuditSinkDestination(rawURL); err != nil {
		return err
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	contentHashBytes := sha256.Sum256(body)
	contentHash := hex.EncodeToString(contentHashBytes[:])

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", contentHash)
	req.Header.Set("Content-Type", "application/vnd.apache.parquet")
	// Object Lock headers.
	if objectLockMode == "COMPLIANCE" || objectLockMode == "GOVERNANCE" {
		req.Header.Set("X-Amz-Object-Lock-Mode", objectLockMode)
		req.Header.Set("X-Amz-Object-Lock-Retain-Until-Date",
			retainUntil.UTC().Format(time.RFC3339))
	}
	if legalHold {
		req.Header.Set("X-Amz-Object-Lock-Legal-Hold", "ON")
	}

	// Canonical request — every signed header alphabetised.
	signedHeaders := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if objectLockMode == "COMPLIANCE" || objectLockMode == "GOVERNANCE" {
		signedHeaders = append(signedHeaders,
			"x-amz-object-lock-mode", "x-amz-object-lock-retain-until-date")
	}
	if legalHold {
		signedHeaders = append(signedHeaders, "x-amz-object-lock-legal-hold")
	}
	sort.Strings(signedHeaders)
	var canonHeaders strings.Builder
	for _, h := range signedHeaders {
		canonHeaders.WriteString(h)
		canonHeaders.WriteByte(':')
		canonHeaders.WriteString(strings.TrimSpace(req.Header.Get(h)))
		canonHeaders.WriteByte('\n')
	}
	canonicalRequest := strings.Join([]string{
		"PUT",
		"/" + escapeS3Key(key),
		"",
		canonHeaders.String(),
		strings.Join(signedHeaders, ";"),
		contentHash,
	}, "\n")
	canonHash := sha256.Sum256([]byte(canonicalRequest))

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, region)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hex.EncodeToString(canonHash[:]),
	}, "\n")

	signingKey := deriveSigningKey(secretKey, dateStamp, region, "s3")
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(stringToSign))
	sig := mac.Sum(nil)

	auth := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey, credentialScope, strings.Join(signedHeaders, ";"), hex.EncodeToString(sig),
	)
	req.Header.Set("Authorization", auth)

	resp, err := httpC.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("s3 PUT returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// serializeMetadata canonicalises a metadata map to JSON bytes.
// Wrapper around encoding/json so we can swap in deterministic
// ordering later without touching callers.
func serializeMetadata(m map[string]any) ([]byte, error) {
	return json.Marshal(m)
}

// ArchiveAthenaDDL is the canonical AWS Glue / Athena CREATE TABLE
// statement for the archive layout. Operators register the external
// table once and Athena queries every tenant's history under the
// Hive-style partitions. Kept here so the schema documentation lives
// next to the writer.
const ArchiveAthenaDDL = `
-- Run once per AWS account / region to register the archive layout.
-- Update <BUCKET> + <PREFIX> to match audit_sinks.parquet_config.
CREATE EXTERNAL TABLE IF NOT EXISTS postwave_audit_archive (
    id              BIGINT,
    tenant_id       STRING,
    user_id         STRING,
    action          STRING,
    resource_type   STRING,
    resource_id     STRING,
    metadata        STRING,   -- JSON-encoded; use json_extract(metadata, '$.field')
    ip              STRING,
    user_agent      STRING,
    actor_type      STRING,
    actor_label     STRING,
    at_unix_ms      BIGINT,
    row_hash        STRING,
    prev_hash       STRING,
    event_id        STRING,
    written_at      TIMESTAMP
)
PARTITIONED BY (year STRING, month STRING, day STRING)
STORED AS PARQUET
LOCATION 's3://<BUCKET>/<PREFIX>/'
TBLPROPERTIES ('parquet.compression'='SNAPPY');

-- After registering, run:
--   MSCK REPAIR TABLE postwave_audit_archive;
-- to load existing day-partitions, or schedule a Glue crawler for
-- continuous discovery.
`
