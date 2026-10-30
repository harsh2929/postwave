// SPDX-License-Identifier: AGPL-3.0-only
//
// snowflake_shareback.go — Snowflake Native App "Shareback" sink.
//
// Zero-copy data shares into a customer's Snowflake account. The
// shipping mechanism is a *signed reverse-pull*:
//
//  1. Moosewave writes the audit batch to its OCSF S3 archive
//     (audit-archive bucket, ndjson, layout matches the existing s3
//     sink — see deliverS3 in auditsink.go).
//  2. A Snowflake Native App installed in the customer account polls
//     the Moosewave catalog endpoint, receives a presigned S3 GET URL
//     keyed on the customer's tenant_id, and COPIES INTO an external
//     stage backed by that bucket. The native app's manifest +
//     Terraform module live in docs/marketplace/snowflake-native-app/.
//
// Shareback config (audit_sinks.config):
//
//	account_locator  — required, e.g. xy12345.eu-central-1.aws
//	share_name       — required, must match the Snowflake share name
//	                   the Native App created on install
//	bucket           — required, the Moosewave-owned S3 archive bucket
//	                   the share reads from (one per region)
//	region           — required, AWS region of bucket
//	prefix           — optional, key prefix inside bucket
//
// Shareback credentials (audit_sinks.credentials_envelope):
//
//	aws_access_key_id      — Moosewave's writer credentials (NOT the
//	                         customer's — Moosewave owns the bucket)
//	aws_secret_access_key  — paired secret
//
// The customer never sees these keys; they're held inside the
// Moosewave tenant's encrypted credentials envelope so an operator can
// rotate them independently of the published Marketplace listing.

package auditsink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// accountLocatorRe accepts the two canonical Snowflake account-locator
// shapes:
//
//	<account>.<region>.<cloud>  (preferred, e.g. xy12345.eu-central-1.aws)
//	<account>_<region>_<cloud>  (legacy underscore variant)
//
// Either also tolerates a bare <account>-style id (org-prefixed orgs).
var accountLocatorRe = regexp.MustCompile(
	`^[A-Za-z0-9_-]{3,64}([._-][A-Za-z0-9_-]{2,32}){0,3}$`,
)

// snowflakeSharebackConfig is the parsed shape of a snowflake_shareback
// sink's config. We validate up-front so the worker fails fast on the
// first delivery rather than silently writing to nowhere.
type snowflakeSharebackConfig struct {
	AccountLocator string
	ShareName      string
	Bucket         string
	Region         string
	Prefix         string
}

func parseSnowflakeSharebackConfig(cfg map[string]any) (snowflakeSharebackConfig, error) {
	var out snowflakeSharebackConfig
	if cfg == nil {
		return out, errors.New("snowflake_shareback: config required")
	}
	out.AccountLocator, _ = cfg["account_locator"].(string)
	out.ShareName, _ = cfg["share_name"].(string)
	out.Bucket, _ = cfg["bucket"].(string)
	out.Region, _ = cfg["region"].(string)
	out.Prefix, _ = cfg["prefix"].(string)
	out.AccountLocator = strings.TrimSpace(out.AccountLocator)
	out.ShareName = strings.TrimSpace(out.ShareName)
	out.Bucket = strings.TrimSpace(out.Bucket)
	out.Region = strings.TrimSpace(out.Region)
	out.Prefix = strings.TrimSpace(out.Prefix)
	if out.AccountLocator == "" {
		return out, errors.New("snowflake_shareback: account_locator required")
	}
	if !accountLocatorRe.MatchString(out.AccountLocator) {
		return out, fmt.Errorf(
			"snowflake_shareback: account_locator %q does not match the Snowflake locator format (e.g. xy12345.eu-central-1.aws)",
			out.AccountLocator)
	}
	if out.ShareName == "" {
		return out, errors.New("snowflake_shareback: share_name required")
	}
	if out.Bucket == "" {
		return out, errors.New("snowflake_shareback: bucket required")
	}
	if out.Region == "" {
		return out, errors.New("snowflake_shareback: region required")
	}
	return out, nil
}

// deliverSnowflakeShareback writes the batch to the Moosewave-owned S3
// archive bucket the Native App pulls from. The on-the-wire shape is
// OCSF NDJSON when output_format=ocsf_1_8 (the recommended default for
// SIEM consumers); otherwise the native AuditRow JSON.
//
// We DO NOT call any Snowflake API here — the customer's Snowflake
// instance pulls from S3 on its own schedule, driven by the Native
// App's `COPY INTO ... FROM @<external_stage>` task. That's the
// "signed reverse-pull" pattern: the writer owns the source, the
// reader owns the schedule.
func (d *Deps) deliverSnowflakeShareback(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	cfg, err := parseSnowflakeSharebackConfig(s.Config)
	if err != nil {
		return err
	}
	access := creds["aws_access_key_id"]
	secret := creds["aws_secret_access_key"]
	if access == "" || secret == "" {
		return errors.New(
			"snowflake_shareback: aws_access_key_id and aws_secret_access_key required")
	}
	payloads := rowPayloads(s, rows)
	var buf bytes.Buffer
	for _, p := range payloads {
		line, _ := json.Marshal(p)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	// Layout: <prefix>/<account_locator>/<share_name>/<tenant>/<from>-<to>.jsonl
	//
	// The account_locator + share_name in the path lets one Moosewave
	// region/bucket serve multiple Snowflake customers — the Native
	// App's stage points at exactly the subtree it's authorised to read,
	// preventing accidental cross-tenant exposure even if a presigned
	// URL leaks.
	prefix := strings.TrimPrefix(cfg.Prefix, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	suffix := "jsonl"
	if s.OutputFormat == FormatOCSF18 {
		suffix = "ocsf.jsonl"
	}
	key := fmt.Sprintf(
		"%s%s/%s/%s/%d-%d.%s",
		prefix, cfg.AccountLocator, cfg.ShareName, s.TenantID,
		rows[0].ID, rows[len(rows)-1].ID, suffix,
	)
	return s3PutObject(ctx, d.httpClient(), cfg.Region, cfg.Bucket, key, access, secret, buf.Bytes())
}

// SnowflakeShareKey is exposed for the Marketplace catalog endpoint
// (when we ship it) — it lets the Native App's polling lambda compute
// the same key path the writer used. Kept package-public so tests can
// assert the layout stays compatible across releases.
func SnowflakeShareKey(prefix, accountLocator, shareName, tenantID string, fromID, toID int64, ocsf bool) string {
	prefix = strings.TrimPrefix(prefix, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	suffix := "jsonl"
	if ocsf {
		suffix = "ocsf.jsonl"
	}
	return fmt.Sprintf("%s%s/%s/%s/%d-%d.%s",
		prefix, accountLocator, shareName, tenantID, fromID, toID, suffix)
}
