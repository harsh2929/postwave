// SPDX-License-Identifier: MIT

// Package exportcsv wraps the universal CSV importer for source-specific
// export flows. Some ESPs do not expose complete read APIs or require bespoke
// commercial access for historical exports; these adapters provide an honest
// migration-only path by accepting the platform's CSV export and preserving
// the source platform on every canonical subscriber.
package exportcsv

import (
	"context"
	"fmt"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	csvadapter "github.com/postwave/migrate/csv"
)

type Adapter struct {
	source canonical.SourcePlatform
	format string
	csv    *csvadapter.Adapter
}

func New(source canonical.SourcePlatform, format string) *Adapter {
	if strings.TrimSpace(format) == "" {
		format = string(source) + "_csv_export"
	}
	return &Adapter{
		source: source,
		format: format,
		csv:    csvadapter.New(),
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     a.source,
		AuthMethod: "csv_upload",
	}
	c.Supports.Subscribers = true
	c.Supports.ConsentTimestamps = true
	return c
}

func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.Extra == nil || creds.Extra["csv_path"] == "" {
		return adapter.Session{}, fmt.Errorf("%s: csv_path required: %w", a.source, adapter.ErrAuth)
	}
	sess, err := a.csv.Authenticate(ctx, creds)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("%s: csv export: %w", a.source, err)
	}
	if err := csvadapter.ApplyExportProfile(&sess, a.source); err != nil {
		return adapter.Session{}, err
	}
	sess.Source = a.source
	sess.AccountID = firstNonEmpty(creds.AccountID, creds.Extra["file_name"], string(a.source)+"-export")
	if sess.Extra == nil {
		sess.Extra = cloneMap(creds.Extra)
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	sess.Extra["source_format"] = a.format
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
		subs[i].SourcePlatform = a.source
		if subs[i].CustomFields == nil {
			subs[i].CustomFields = map[string]interface{}{}
		}
		subs[i].CustomFields["postwave_migration_source"] = string(a.source)
		subs[i].CustomFields["postwave_migration_source_format"] = a.format
		if listID := sess.Extra["list_id"]; strings.TrimSpace(listID) != "" {
			subs[i].CustomFields["source_list_id"] = strings.TrimSpace(listID)
		}
		if audienceID := sess.Extra["audience_id"]; strings.TrimSpace(audienceID) != "" {
			subs[i].CustomFields["source_audience_id"] = strings.TrimSpace(audienceID)
		}
	}
	return subs, next, nil
}

func (a *Adapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}

func (a *Adapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
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
