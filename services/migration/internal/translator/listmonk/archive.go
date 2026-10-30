package listmonk

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// PersistCampaignArchive writes a canonical CampaignArchive into Moosewave's
// own `campaign_archive` table (infra/migrations/0005_automations_archive.sql).
//
// We deliberately do NOT recreate these as Listmonk campaigns — they're sent
// history, not future sends. Moosewave's reader UI will surface them straight
// out of this table.
func PersistCampaignArchive(ctx context.Context, db *sql.DB, tenantID, jobID string, c canonical.CampaignArchive) (id string, err error) {
	contentFingerprint, err := campaignArchiveContentFingerprint(c)
	if err != nil {
		return "", err
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return "", err
	}
	defer commitTx(tx, &err)

	const q = `
		INSERT INTO campaign_archive
			(tenant_id, source_id, subject, html, text, sent_at, recipients_count, opens, clicks, source_platform, content_fingerprint)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (tenant_id, source_platform, source_id)
		DO NOTHING
		RETURNING id::text
	`
	created := true
	if err := tx.QueryRowContext(ctx, q,
		tenantID,
		c.SourceID,
		c.Subject,
		c.HTML,
		c.Text,
		c.SentAt,
		c.RecipientsCount,
		c.Opens,
		c.Clicks,
		string(c.SourcePlatform),
		contentFingerprint,
	).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			created = false
			var existingFingerprint sql.NullString
			if err := tx.QueryRowContext(ctx, `
SELECT id::text, content_fingerprint
  FROM campaign_archive
 WHERE tenant_id = $1::uuid
   AND source_platform = $2
   AND source_id = $3
 FOR SHARE`, tenantID, string(c.SourcePlatform), c.SourceID).Scan(&id, &existingFingerprint); err != nil {
				return "", fmt.Errorf("load existing campaign archive %q after uniqueness conflict: %w", c.SourceID, err)
			}
			if !existingFingerprint.Valid || strings.TrimSpace(existingFingerprint.String) == "" {
				return "", fmt.Errorf("campaign archive %q predates immutable content binding; refusing to certify or overwrite the existing row", c.SourceID)
			}
			if existingFingerprint.String != contentFingerprint {
				return "", fmt.Errorf("campaign archive %q changed after its immutable destination row was created; preserve a new source version or explicitly rebuild before retry", c.SourceID)
			}
		} else {
			return "", fmt.Errorf("persist campaign archive %q: %w", c.SourceID, err)
		}
	}
	if !created {
		// A different migration (or a legacy import) may already own the global
		// tenant/platform/source row. Count it as available, but never attach a
		// destructive current-job ledger or create duplicate materialized rows.
		// A same-job ledger proves the prior transaction committed atomically, in
		// which case replaying the idempotent child reconciliation is safe.
		if jobID == "" {
			return id, nil
		}
		ownedID, err := existingImportedDestinationTx(ctx, tx, tenantID, jobID, ResourceCampaignArchive, c.SourceID)
		if err != nil {
			return "", fmt.Errorf("load campaign archive retry ownership %q: %w", c.SourceID, err)
		}
		if ownedID == "" {
			return id, nil
		}
		if ownedID != id {
			return "", fmt.Errorf("campaign archive %q retry ledger points to %q, but the unique destination is %q", c.SourceID, ownedID, id)
		}
		campaignID, err := persistArchivedCampaignRowTx(ctx, tx, tenantID, jobID, c)
		if err != nil {
			return "", err
		}
		if campaignID != "" {
			if err := replayCampaignReportEventsTx(ctx, tx, tenantID, jobID, campaignID, c); err != nil {
				return "", err
			}
		}
		return id, nil
	}
	if jobID != "" {
		meta := map[string]interface{}{
			"operation":           "created",
			"subject":             c.Subject,
			"sent_at":             c.SentAt,
			"content_fingerprint": contentFingerprint,
		}
		if len(c.Report) > 0 {
			meta["report"] = c.Report
		}
		if len(c.Warnings) > 0 {
			meta["warnings"] = c.Warnings
		}
		if err := recordImportedResourceTx(ctx, tx, ImportedResource{
			TenantID:            tenantID,
			JobID:               jobID,
			ResourceType:        ResourceCampaignArchive,
			SourcePlatform:      c.SourcePlatform,
			SourceID:            c.SourceID,
			DestinationType:     DestinationPostwaveCampaign,
			DestinationID:       id,
			DestinationMetadata: meta,
		}); err != nil {
			return "", err
		}
		campaignID, err := persistArchivedCampaignRowTx(ctx, tx, tenantID, jobID, c)
		if err != nil {
			return "", err
		}
		if campaignID != "" {
			if err := replayCampaignReportEventsTx(ctx, tx, tenantID, jobID, campaignID, c); err != nil {
				return "", err
			}
		}
	}
	return id, nil
}

func campaignArchiveContentFingerprint(c canonical.CampaignArchive) (string, error) {
	raw, err := json.Marshal(struct {
		SourceID        string                   `json:"source_id"`
		Subject         string                   `json:"subject"`
		HTML            string                   `json:"html"`
		Text            string                   `json:"text"`
		SentAt          time.Time                `json:"sent_at"`
		RecipientsCount int                      `json:"recipients_count"`
		Opens           int                      `json:"opens"`
		Clicks          int                      `json:"clicks"`
		Report          map[string]interface{}   `json:"report"`
		Warnings        []string                 `json:"warnings"`
		SourcePlatform  canonical.SourcePlatform `json:"source_platform"`
	}{
		SourceID: c.SourceID, Subject: c.Subject, HTML: c.HTML, Text: c.Text, SentAt: c.SentAt.UTC(),
		RecipientsCount: c.RecipientsCount, Opens: c.Opens, Clicks: c.Clicks, Report: c.Report,
		Warnings: c.Warnings, SourcePlatform: c.SourcePlatform,
	})
	if err != nil {
		return "", fmt.Errorf("fingerprint campaign archive %q: %w", c.SourceID, err)
	}
	digest := sha256.Sum256(append([]byte("postwave-campaign-archive-v1\x00"), raw...))
	return fmt.Sprintf("%x", digest[:]), nil
}

func persistArchivedCampaignRowTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, c canonical.CampaignArchive) (string, error) {
	if id, _ := existingImportedDestinationTx(ctx, tx, tenantID, jobID, ResourceCampaign, c.SourceID); id != "" {
		return id, nil
	}
	delivery, _ := json.Marshal(map[string]interface{}{
		"source_platform": c.SourcePlatform,
		"source_id":       c.SourceID,
		"archived":        true,
		"report":          c.Report,
	})
	name := c.Subject
	if strings.TrimSpace(name) == "" {
		name = "Imported Mailchimp campaign " + c.SourceID
	}
	var sentAt interface{}
	if !c.SentAt.IsZero() {
		sentAt = c.SentAt
	}
	var id string
	if err := tx.QueryRowContext(ctx, `
INSERT INTO campaigns (
  tenant_id, name, subject, status, body_html, plain_text, sent_at,
  campaign_type, editor_mode, tracking_settings, delivery_settings
)
VALUES ($1::uuid, $2, $3, 'sent', $4, $5, $6,
        'regular', 'html', '{}'::jsonb, $7::jsonb)
RETURNING id::text`, tenantID, name, c.Subject, c.HTML, c.Text, sentAt, string(delivery)).Scan(&id); err != nil {
		return "", fmt.Errorf("persist archived campaign row %q: %w", c.SourceID, err)
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceCampaign,
		SourcePlatform:  c.SourcePlatform,
		SourceID:        c.SourceID,
		DestinationType: DestinationPostwaveCampaignRow,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation": "created",
			"subject":   c.Subject,
			"sent_at":   c.SentAt,
		},
	}); err != nil {
		return "", err
	}
	return id, nil
}

func replayCampaignReportEventsTx(ctx context.Context, tx *sql.Tx, tenantID, jobID, campaignID string, c canonical.CampaignArchive) error {
	if len(c.Report) == 0 {
		return nil
	}
	events := mailchimpReportEvents(c)
	for _, ev := range events {
		meta, _ := json.Marshal(ev.Metadata)
		var id string
		err := tx.QueryRowContext(ctx, `
INSERT INTO campaign_report_events (
  tenant_id, campaign_id, subscriber_email, event_type, link_url,
  user_agent, ip, country, region, city, device, client, revenue_cents,
  metadata, at, source, provider_event_id, message_id
)
VALUES (
  $1::uuid, $2::uuid, NULLIF($3, ''), $4, NULLIF($5, ''),
  NULLIF($6, ''), NULLIF($7, '')::inet, NULLIF($8, ''), NULLIF($9, ''),
  NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13,
  $14::jsonb, $15, 'mailchimp', $16, NULLIF($17, '')
)
ON CONFLICT (tenant_id, source, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
RETURNING id::text`,
			tenantID, campaignID, ev.Email, ev.Type, ev.LinkURL, ev.UserAgent, ev.IP,
			ev.Country, ev.Region, ev.City, ev.Device, ev.Client, ev.RevenueCents,
			string(meta), ev.At, ev.ProviderEventID, ev.MessageID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("replay Mailchimp report event %q: %w", ev.ProviderEventID, err)
		}
		if jobID != "" && id != "" {
			if err := recordImportedResourceTx(ctx, tx, ImportedResource{
				TenantID:        tenantID,
				JobID:           jobID,
				ResourceType:    ResourceCampaignEvent,
				SourcePlatform:  c.SourcePlatform,
				SourceID:        ev.ProviderEventID,
				DestinationType: DestinationPostwaveCampaignEvent,
				DestinationID:   id,
				DestinationMetadata: map[string]interface{}{
					"operation":          "created",
					"campaign_source_id": c.SourceID,
					"event_type":         ev.Type,
					"subscriber_email":   ev.Email,
				},
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

type reportEvent struct {
	Type            string
	Email           string
	LinkURL         string
	UserAgent       string
	IP              string
	Country         string
	Region          string
	City            string
	Device          string
	Client          string
	RevenueCents    int
	At              time.Time
	MessageID       string
	ProviderEventID string
	Metadata        map[string]interface{}
}

func mailchimpReportEvents(c canonical.CampaignArchive) []reportEvent {
	out := []reportEvent{}
	appendEvent := func(ev reportEvent) {
		if ev.Type == "" {
			return
		}
		if ev.At.IsZero() {
			ev.At = c.SentAt
		}
		if ev.At.IsZero() {
			ev.At = time.Now().UTC()
		}
		if ev.Metadata == nil {
			ev.Metadata = map[string]interface{}{}
		}
		if ev.ProviderEventID == "" {
			ev.ProviderEventID = stableReportEventID(c.SourceID, ev)
		}
		out = append(out, ev)
	}

	if page := mapFromReport(c.Report, "sent_to"); page != nil {
		for _, item := range reportArray(page, "sent_to", "members", "emails") {
			if m, ok := item.(map[string]interface{}); ok {
				appendEvent(eventFromMap(c, "sent", m, "email_address", "email"))
			}
		}
	}
	if page := mapFromReport(c.Report, "open_details"); page != nil {
		for _, item := range reportArray(page, "members", "opens") {
			if m, ok := item.(map[string]interface{}); ok {
				appendEvent(eventFromMap(c, "opened", m, "email_address", "email"))
			}
		}
	}
	if page := mapFromReport(c.Report, "email_activity"); page != nil {
		for _, item := range reportArray(page, "emails", "email_activity") {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			email := sourceString(m, "email_address", "email")
			for _, act := range reportArray(m, "activity", "actions") {
				am, ok := act.(map[string]interface{})
				if !ok {
					continue
				}
				evType := mailchimpActionToEvent(sourceString(am, "action", "type"))
				ev := eventFromMap(c, evType, am, "email_address", "email")
				if ev.Email == "" {
					ev.Email = email
				}
				appendEvent(ev)
			}
		}
	}
	if clickMembers := mapFromReport(c.Report, "click_members"); clickMembers != nil {
		for linkID, raw := range clickMembers {
			page, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			for _, item := range reportArray(page, "members", "email_activity", "clicks") {
				if m, ok := item.(map[string]interface{}); ok {
					ev := eventFromMap(c, "clicked", m, "email_address", "email")
					ev.LinkURL = firstReportString(sourceMapForLink(c.Report, linkID), "url")
					ev.Metadata["link_id"] = linkID
					appendEvent(ev)
				}
			}
		}
	}
	if page := mapFromReport(c.Report, "unsubscribed"); page != nil {
		for _, item := range reportArray(page, "unsubscribes", "members") {
			if m, ok := item.(map[string]interface{}); ok {
				appendEvent(eventFromMap(c, "unsubscribed", m, "email_address", "email"))
			}
		}
	}
	if page := mapFromReport(c.Report, "abuse_reports"); page != nil {
		for _, item := range reportArray(page, "abuse_reports", "members") {
			if m, ok := item.(map[string]interface{}); ok {
				appendEvent(eventFromMap(c, "complained", m, "email_address", "email"))
			}
		}
	}
	return out
}

func eventFromMap(c canonical.CampaignArchive, typ string, m map[string]interface{}, emailKeys ...string) reportEvent {
	ev := reportEvent{
		Type:         typ,
		Email:        firstReportString(m, emailKeys...),
		LinkURL:      firstReportString(m, "url", "link_url"),
		UserAgent:    firstReportString(m, "user_agent"),
		IP:           firstReportString(m, "ip", "ip_address"),
		Country:      firstReportString(m, "country"),
		Region:       firstReportString(m, "region"),
		City:         firstReportString(m, "city"),
		Device:       firstReportString(m, "device"),
		Client:       firstReportString(m, "client", "email_client"),
		RevenueCents: centsFromAny(firstReportAny(m, "revenue", "revenue_cents", "order_total")),
		At:           reportTime(firstReportAny(m, "timestamp", "time", "at", "date")),
		MessageID:    firstReportString(m, "message_id", "email_id"),
		Metadata: map[string]interface{}{
			"campaign_source_id": c.SourceID,
			"raw":                m,
		},
	}
	return ev
}

func mailchimpActionToEvent(action string) string {
	switch strings.ToLower(action) {
	case "sent", "send":
		return "sent"
	case "open", "opened":
		return "opened"
	case "click", "clicked":
		return "clicked"
	case "bounce", "bounced":
		return "bounced"
	case "abuse", "complaint", "complained":
		return "complained"
	case "unsub", "unsubscribe", "unsubscribed":
		return "unsubscribed"
	default:
		return ""
	}
}

func stableReportEventID(campaignID string, ev reportEvent) string {
	parts := []string{campaignID, ev.Type, strings.ToLower(ev.Email), ev.LinkURL, ev.At.UTC().Format(time.RFC3339Nano), ev.MessageID}
	return "mailchimp-report:" + strings.Join(parts, ":")
}

func mapFromReport(report map[string]interface{}, key string) map[string]interface{} {
	if m, ok := report[key].(map[string]interface{}); ok {
		return m
	}
	return nil
}

func reportArray(m map[string]interface{}, keys ...string) []interface{} {
	for _, key := range keys {
		if arr, ok := m[key].([]interface{}); ok {
			return arr
		}
	}
	return nil
}

func sourceMapForLink(report map[string]interface{}, linkID string) map[string]interface{} {
	clicks := mapFromReport(report, "click_details")
	if clicks == nil {
		return nil
	}
	for _, item := range reportArray(clicks, "urls_clicked", "clicks", "links") {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if firstReportString(m, "id", "link_id") == linkID {
			return m
		}
	}
	return nil
}

func firstReportAny(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func firstReportString(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		switch v := m[key].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v
			}
		case float64:
			return fmt.Sprintf("%.0f", v)
		case int:
			return fmt.Sprintf("%d", v)
		case json.Number:
			return v.String()
		}
	}
	return ""
}

func sourceString(m map[string]interface{}, keys ...string) string {
	return firstReportString(m, keys...)
}

func reportTime(v interface{}) time.Time {
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, t); err == nil {
				return parsed
			}
		}
	}
	return time.Time{}
}
