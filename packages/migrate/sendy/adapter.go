// SPDX-License-Identifier: MIT

// Package sendy implements the Sendy source adapter.
//
// Sendy's official API exposes account/list discovery and subscriber mutation
// endpoints, but it does not expose a complete subscriber-list export API.
// For data-loss-safe migrations, this adapter therefore treats Sendy as a
// first-class CSV-export source: users upload Sendy's "Export all subscribers"
// CSV and Moosewave maps it through the same resumable importer used by the
// universal CSV source while preserving `source_platform=sendy`.
package sendy

import (
	"context"
	"fmt"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	csvadapter "github.com/postwave/migrate/csv"
)

func init() {
	adapter.Register(canonical.SourceSendy, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for Sendy CSV exports.
type Adapter struct {
	csv *csvadapter.Adapter
}

// New constructs a Sendy adapter.
func New() *Adapter {
	return &Adapter{csv: csvadapter.New()}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceSendy,
		AuthMethod: "csv_upload",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = false
	c.Supports.Automations = false
	c.Supports.CampaignArchive = false
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = false
	c.Supports.Campaigns = false
	c.Supports.Reports = false
	c.Supports.Groups = false
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.Extra == nil || creds.Extra["csv_path"] == "" {
		return adapter.Session{}, fmt.Errorf("sendy: csv_path required: %w", adapter.ErrAuth)
	}
	sess, err := a.csv.Authenticate(ctx, creds)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("sendy: csv export: %w", err)
	}
	if err := csvadapter.ApplyExportProfile(&sess, canonical.SourceSendy); err != nil {
		return adapter.Session{}, err
	}
	sess.Source = canonical.SourceSendy
	sess.AccountID = firstNonEmpty(creds.AccountID, creds.Extra["file_name"], "sendy-export")
	if sess.Extra == nil {
		sess.Extra = cloneMap(creds.Extra)
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	sess.Extra["source_format"] = "sendy_csv_export"
	return sess, nil
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	return a.csv.Discover(ctx, sess)
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	subs, next, err := a.csv.ListSubscribers(ctx, sess, cursor)
	if err != nil {
		return nil, "", err
	}
	for i := range subs {
		subs[i].SourcePlatform = canonical.SourceSendy
		if subs[i].CustomFields == nil {
			subs[i].CustomFields = map[string]interface{}{}
		}
		subs[i].CustomFields["sendy_import_source"] = "csv_export"
		if listID := sess.Extra["list_id"]; listID != "" {
			subs[i].CustomFields["sendy_list_id"] = listID
		}
	}
	return subs, next, nil
}

func (a *Adapter) ListSegments(_ context.Context, _ adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListAutomations(_ context.Context, _ adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListCampaignArchive(_ context.Context, _ adapter.Session, _ string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}

func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
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
