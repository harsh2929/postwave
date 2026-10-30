// SPDX-License-Identifier: MIT

package substack

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func init() {
	adapter.Register(canonical.SourceSubstack, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for official Substack CSV/ZIP exports.
type Adapter struct{}

// New constructs a Substack adapter. It reads only the user-owned local export.
func New() *Adapter { return &Adapter{} }

// Capabilities advertises Substack's file-export feature set.
func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceSubstack,
		AuthMethod: "csv_upload",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = false
	c.Supports.Automations = false
	c.Supports.CampaignArchive = true
	// The export preserves membership tier metadata, but neither a signup
	// timestamp nor an arbitrary Stripe account is a safe billing/consent
	// migration contract. Both remain explicit review surfaces.
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = false
	c.Supports.Templates = false
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = false
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

// Authenticate validates and stores prepared Substack export paths.
// Required keys in creds.Extra:
//
//	subs_csv          — path to Substack subscribers CSV (required)
//	archive_csv       — path to Substack posts CSV (optional)
//	archive_stats_csv — path to enriched/scraped post stats CSV (optional)
func (a *Adapter) Authenticate(_ context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.Extra == nil {
		return adapter.Session{}, fmt.Errorf("substack: missing extras: %w", adapter.ErrAuth)
	}
	for _, key := range []string{"stripe_account_id", "stripe_product_ids", "stripe_price_ids"} {
		if strings.TrimSpace(creds.Extra[key]) != "" {
			return adapter.Session{}, fmt.Errorf("substack: %s is not accepted; a caller-supplied Stripe reference cannot prove publication-bound billing ownership: %w", key, adapter.ErrAuth)
		}
	}
	for _, key := range []string{"substack_cookie", "session_cookie", "cookie"} {
		if strings.TrimSpace(creds.Extra[key]) != "" {
			return adapter.Session{}, fmt.Errorf("substack: %s is not accepted; use a user-owned export instead of an unsupported browser session: %w", key, adapter.ErrAuth)
		}
	}
	if creds.Extra["subs_csv"] == "" {
		return adapter.Session{}, fmt.Errorf("substack: subs_csv required: %w", adapter.ErrAuth)
	}
	if info, err := os.Stat(creds.Extra["subs_csv"]); err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("path is not a regular file")
		}
		return adapter.Session{}, fmt.Errorf("substack: subs_csv not readable: %w: %w", adapter.ErrAuth, err)
	}
	if err := validateSubscribersCSVPath(creds.Extra["subs_csv"]); err != nil {
		return adapter.Session{}, fmt.Errorf("%w: %w", adapter.ErrAuth, err)
	}
	subsFile, err := os.Open(creds.Extra["subs_csv"])
	if err != nil {
		return adapter.Session{}, fmt.Errorf("substack: subs_csv not readable: %w: %w", adapter.ErrAuth, err)
	}
	_, subscriberErr := countSubscribersCSV(subsFile)
	closeErr := subsFile.Close()
	if subscriberErr != nil {
		return adapter.Session{}, fmt.Errorf("substack: invalid subscriber CSV: %w: %w", adapter.ErrAuth, subscriberErr)
	}
	if closeErr != nil {
		return adapter.Session{}, fmt.Errorf("substack: close subscriber CSV: %w: %w", adapter.ErrAuth, closeErr)
	}
	for _, key := range []string{"archive_csv", "archive_dir", "archive_stats_csv", "bundle_path", "bundle_manifest_path"} {
		if candidate := strings.TrimSpace(creds.Extra[key]); candidate != "" {
			info, err := os.Stat(candidate)
			if err == nil && key == "archive_dir" && !info.IsDir() {
				err = fmt.Errorf("path is not a directory")
			}
			if err == nil && key != "archive_dir" && !info.Mode().IsRegular() {
				err = fmt.Errorf("path is not a regular file")
			}
			if err != nil {
				return adapter.Session{}, fmt.Errorf("substack: %s not readable: %w: %w", key, adapter.ErrAuth, err)
			}
		}
	}
	if archivePath := strings.TrimSpace(creds.Extra["archive_csv"]); archivePath != "" {
		f, err := os.Open(archivePath)
		if err != nil {
			return adapter.Session{}, fmt.Errorf("substack: archive_csv not readable: %w: %w", adapter.ErrAuth, err)
		}
		_, countErr := countPostsCSV(f)
		_ = f.Close()
		if countErr != nil {
			return adapter.Session{}, fmt.Errorf("substack: invalid archive_csv: %w: %w", adapter.ErrAuth, countErr)
		}
	}
	if statsPath := creds.Extra["archive_stats_csv"]; statsPath != "" {
		if _, err := loadPostStatsCSV(statsPath); err != nil {
			return adapter.Session{}, fmt.Errorf("substack: invalid archive_stats_csv: %w: %w", adapter.ErrAuth, err)
		}
	}
	if archiveDir := strings.TrimSpace(creds.Extra["archive_dir"]); archiveDir != "" {
		if _, _, err := indexPostExportFiles(archiveDir); err != nil {
			return adapter.Session{}, fmt.Errorf("substack: invalid archive_dir: %w: %w", adapter.ErrAuth, err)
		}
	}
	fingerprintPath := firstNonEmpty(creds.Extra["bundle_path"], creds.Extra["subs_csv"])
	fingerprint, err := sha256File(fingerprintPath)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("substack: fingerprint export: %w: %w", adapter.ErrAuth, err)
	}
	if manifestPath := strings.TrimSpace(creds.Extra["bundle_manifest_path"]); manifestPath != "" {
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			return adapter.Session{}, fmt.Errorf("substack: read export manifest: %w: %w", adapter.ErrAuth, err)
		}
		var manifest ExportManifest
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return adapter.Session{}, fmt.Errorf("substack: invalid export manifest: %w: %w", adapter.ErrAuth, err)
		}
		if manifest.SchemaVersion != 1 || len(manifest.Entries) == 0 || strings.TrimSpace(manifest.ArchiveSHA256) == "" {
			return adapter.Session{}, fmt.Errorf("substack: export manifest is incomplete or unsupported: %w", adapter.ErrAuth)
		}
		if creds.Extra["bundle_path"] != "" && !strings.EqualFold(manifest.ArchiveSHA256, fingerprint) {
			return adapter.Session{}, fmt.Errorf("substack: export manifest does not match the uploaded ZIP: %w", adapter.ErrAuth)
		}
	}
	extra := cloneMap(creds.Extra)
	extra["export_fingerprint"] = fingerprint
	return adapter.Session{
		AccountID: "substack-export:" + fingerprint[:24],
		Source:    canonical.SourceSubstack,
		Extra:     extra,
	}, nil
}

// Discover counts the normalized subscriber, sent-email archive, membership
// metadata, aggregate report, and source-archive evidence in the export.
func (a *Adapter) Discover(_ context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport

	subsPath, archivePath := pathsFromSession(sess)
	if subsPath != "" {
		f, err := os.Open(subsPath)
		if err != nil {
			return rep, fmt.Errorf("open subs csv: %w", err)
		}
		total, err := countSubscribersCSV(f)
		_ = f.Close()
		if err != nil {
			return rep, err
		}
		rep.SubscribersTotal = total
		f, err = os.Open(subsPath)
		if err != nil {
			return rep, fmt.Errorf("reopen subs csv: %w", err)
		}
		rep.PaidSubsTotal, err = countPaidMembershipsCSV(f)
		_ = f.Close()
		if err != nil {
			return rep, err
		}
		headers, headerErr := csvHeaderFromPath(subsPath)
		if headerErr != nil {
			return rep, headerErr
		}
		if !headerHasAny(headers, "state", "status", "subscription_status", "email_status", "email_disabled") {
			rep.Warnings = append(rep.Warnings, "Subscriber export has no email-status column; every otherwise-active row remains unconfirmed until send permission is reviewed.")
		}
		rep.Warnings = append(rep.Warnings, "Substack signup dates are retained as provenance and are not treated as portable consent timestamps.")
	}
	if archivePath != "" {
		f, err := os.Open(archivePath)
		if err != nil {
			return rep, fmt.Errorf("open archive csv: %w", err)
		}
		total, countErr := countPostsCSV(f)
		_ = f.Close()
		if countErr != nil {
			return rep, fmt.Errorf("count archive csv: %w", countErr)
		}
		rep.ArchiveTotal = total
		rep.CampaignsTotal = total
		_, stats, statsErr := indexPostExportFiles(archiveDirFromSession(sess))
		if statsErr != nil {
			return rep, statsErr
		}
		rep.ReportsTotal = len(stats)
		if statsPath := archiveStatsPathFromSession(sess); statsPath != "" {
			parsed, statsErr := loadPostStatsCSV(statsPath)
			if statsErr != nil {
				return rep, statsErr
			}
			if len(parsed) > rep.ReportsTotal {
				rep.ReportsTotal = len(parsed)
			}
		}
	} else {
		rep.Warnings = append(rep.Warnings, "This upload contains subscribers only; no posts.csv archive was detected.")
	}
	if rep.PaidSubsTotal > 0 {
		rep.Warnings = append(rep.Warnings, "Paid/founding/gift/comp tiers are membership evidence only; billing continuity requires a publication-bound handoff with Substack and the payment provider.")
	}
	rep.SourceArchiveTotal = sourceArchiveItemCount(sess)
	return rep, nil
}

// ListSubscribers reads the Substack subscriber CSV with a row-index cursor.
// It returns a page from a deterministic, fully de-duplicated snapshot so a
// later suppression row can never be stranded behind an earlier active row.
func (a *Adapter) ListSubscribers(_ context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	subsPath, _ := pathsFromSession(sess)
	if subsPath == "" {
		return nil, "", fmt.Errorf("substack: missing subs csv path")
	}
	f, err := os.Open(subsPath)
	if err != nil {
		return nil, "", fmt.Errorf("open subs csv: %w", err)
	}
	defer func() { _ = f.Close() }()

	const pageSize = 1000
	start, err := parseCursor(cursor, "subscriber")
	if err != nil {
		return nil, "", err
	}
	batch, nextRow, err := streamSubscribersCSV(f, start, pageSize)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if nextRow > 0 {
		next = strconv.Itoa(nextRow)
	}
	return batch, next, nil
}

// ListSegments — Substack has no segment concept.
func (a *Adapter) ListSegments(_ context.Context, _ adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}

// ListAutomations — Substack has no automation concept.
func (a *Adapter) ListAutomations(_ context.Context, _ adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

// ListCampaignArchive parses the Substack posts CSV (if provided). Cursor is
// a stringified row index for resume.
func (a *Adapter) ListCampaignArchive(_ context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	_, archivePath := pathsFromSession(sess)
	if archivePath == "" {
		return nil, "", nil
	}
	f, err := os.Open(archivePath)
	if err != nil {
		return nil, "", fmt.Errorf("open archive csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	const pageSize = 200
	start, err := parseCursor(cursor, "archive")
	if err != nil {
		return nil, "", err
	}
	batch, nextRow, err := streamPostsCSVWithArchive(f, start, pageSize, archiveDirFromSession(sess))
	if err != nil {
		return nil, "", err
	}
	if statsPath := archiveStatsPathFromSession(sess); statsPath != "" && len(batch) > 0 {
		stats, err := loadPostStatsCSV(statsPath)
		if err != nil {
			return nil, "", err
		}
		applyPostStats(batch, stats)
	}
	next := ""
	if nextRow > 0 {
		next = strconv.Itoa(nextRow)
	}
	return batch, next, nil
}

// ListPaidSubs deliberately refuses an arbitrary connected-account read.
// Substack can use Stripe and Apple in-app purchase; an account ID alone does
// not prove publication/product ownership and migration evidence is not a live
// Moosewave entitlement.
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, fmt.Errorf("substack: automated billing continuity is not supported; coordinate a publication-bound handoff: %w", adapter.ErrUnsupported)
}

// pathsFromSession recovers CSV paths from the per-job session. The environment
// fallback preserves compatibility with older local examples.
func pathsFromSession(sess adapter.Session) (subsCSV, archiveCSV string) {
	if sess.Extra != nil {
		subsCSV = sess.Extra["subs_csv"]
		archiveCSV = sess.Extra["archive_csv"]
	}
	if subsCSV == "" {
		subsCSV = os.Getenv("SUBSTACK_SUBS_CSV")
	}
	if archiveCSV == "" {
		archiveCSV = os.Getenv("SUBSTACK_ARCHIVE_CSV")
	}
	return
}

func archiveStatsPathFromSession(sess adapter.Session) string {
	if sess.Extra != nil && sess.Extra["archive_stats_csv"] != "" {
		return sess.Extra["archive_stats_csv"]
	}
	return os.Getenv("SUBSTACK_ARCHIVE_STATS_CSV")
}

func archiveDirFromSession(sess adapter.Session) string {
	if sess.Extra != nil {
		return strings.TrimSpace(sess.Extra["archive_dir"])
	}
	return ""
}

func parseCursor(cursor, resource string) (int, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(cursor)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("substack: invalid %s cursor %q: %w", resource, cursor, adapter.ErrSourceUnavailable)
	}
	return value, nil
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
