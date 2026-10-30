// SPDX-License-Identifier: MIT

// Package substack implements the Substack source adapter.
//
// Substack does not expose a supported public migration API. This path relies
// on the user-owned publication export:
//
//  1. email_list.*.csv (or a standalone subscriber CSV).
//  2. posts.csv plus posts/<post_id>.*.html and optional aggregate evidence.
//
// The CSV layout is documented from observed exports as of 2024-Q4. Substack
// has been known to rename columns; the parsers accept documented/observed
// aliases, namespace extra columns, and fail closed on ambiguous identity.
package substack

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"net/mail"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// subsCSVRow models a row from Substack's "Subscribers" CSV export.
//
// Observed columns: email, created_at, state, source, name. Extra columns
// (paid_subscription_status, billing_provider, etc.) are tolerated and dropped.
type subsCSVRow struct {
	SourceID      string
	Email         string
	CreatedAt     string
	State         string
	EmailDisabled string
	Source        string
	Name          string
	FirstName     string
	LastName      string
	Tier          string
	Extras        map[string]string
}

// postCSVRow models a row from Substack's "Posts" CSV export.
type postCSVRow struct {
	Title       string
	Subtitle    string
	PublishedAt string
	BodyHTML    string
	Audience    string
	Extras      map[string]string
}

type postStatsRow struct {
	SourceID        string
	Title           string
	Subject         string
	PublishedAt     string
	Slug            string
	URL             string
	RecipientsCount int
	Opens           int
	Clicks          int
	Report          map[string]interface{}
}

// parseSubscribersCSV walks the whole Substack subscribers export. Production
// pagination uses streamSubscribersCSV below so large exports don't have to be
// materialized for every page.
func parseSubscribersCSV(r io.Reader) ([]canonical.Subscriber, error) {
	out, _, err := streamSubscribersCSV(r, 0, 0)
	return out, err
}

// parsePostsCSV walks Substack's posts export.
func parsePostsCSV(r io.Reader) ([]canonical.CampaignArchive, error) {
	out, _, err := streamPostsCSV(r, 0, 0)
	return out, err
}

// streamSubscribersCSV decodes a deterministic, de-duplicated subscriber
// snapshot. Materializing the normalized index ensures a later duplicate row
// carrying an unsubscribe, complaint, or bounce can never be lost merely
// because an earlier active row landed on a previous page.
func streamSubscribersCSV(r io.Reader, start, limit int) ([]canonical.Subscriber, int, error) {
	if start < 0 {
		return nil, 0, fmt.Errorf("substack: subscriber cursor cannot be negative")
	}
	all, err := readSubscribersCSV(r)
	if err != nil {
		return nil, 0, err
	}
	if start >= len(all) {
		return nil, 0, nil
	}
	end := len(all)
	if limit > 0 && start+limit < end {
		end = start + limit
	}
	out := append([]canonical.Subscriber(nil), all[start:end]...)
	if end < len(all) {
		return out, end, nil
	}
	return out, 0, nil
}

func countSubscribersCSV(r io.Reader) (int, error) {
	subs, err := readSubscribersCSV(r)
	return len(subs), err
}

func countPaidMembershipsCSV(r io.Reader) (int, error) {
	subs, err := readSubscribersCSV(r)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, sub := range subs {
		for _, tag := range sub.Tags {
			switch tag {
			case "substack:tier:paid", "substack:tier:founding", "substack:tier:gift", "substack:tier:comp":
				total++
				goto nextSubscriber
			}
		}
	nextSubscriber:
	}
	return total, nil
}

func readSubscribersCSV(r io.Reader) ([]canonical.Subscriber, error) {
	reader := newSubstackCSVReader(r)
	idx, ok, err := readCSVHeader(reader)
	if err != nil || !ok {
		return nil, err
	}
	if !headerHasAny(idx, "email", "email_address", "subscriber_email") {
		return nil, fmt.Errorf("substack: subscriber CSV is missing an email column")
	}
	out := make([]canonical.Subscriber, 0)
	byEmail := map[string]int{}
	bySourceID := map[string]string{}
	dataRow := 0
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read subscriber row: %w", err)
		}
		dataRow++
		sub, ok := subscriberFromRecord(rec, idx)
		if !ok {
			if recordHasData(rec) {
				return nil, fmt.Errorf("substack: subscriber data row %d is missing an email address", dataRow)
			}
			continue
		}
		if !validSubstackEmail(sub.Email) {
			return nil, fmt.Errorf("substack: subscriber data row %d contains an invalid email address", dataRow)
		}
		key := strings.ToLower(strings.TrimSpace(sub.Email))
		if existing, duplicate := byEmail[key]; duplicate {
			currentSourceID := subscriberIdentityKey(out[existing].SourceID, key)
			nextSourceID := subscriberIdentityKey(sub.SourceID, key)
			if strings.HasPrefix(currentSourceID, "id:") && strings.HasPrefix(nextSourceID, "id:") && currentSourceID != nextSourceID {
				return nil, fmt.Errorf("substack: duplicate email rows carry conflicting subscriber identities")
			}
			out[existing] = mergeDuplicateSubscriber(out[existing], sub)
			continue
		}
		sourceIDKey := subscriberIdentityKey(sub.SourceID, key)
		if previousEmail, exists := bySourceID[sourceIDKey]; exists && previousEmail != key {
			return nil, fmt.Errorf("substack: one subscriber identity maps to multiple email addresses")
		}
		bySourceID[sourceIDKey] = key
		byEmail[key] = len(out)
		out = append(out, sub)
	}
}

func subscriberIdentityKey(sourceID, normalizedEmail string) string {
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" || strings.EqualFold(sourceID, normalizedEmail) {
		return "email:" + normalizedEmail
	}
	return "id:" + sourceID
}

// streamPostsCSV decodes post archive rows using the same row-index cursor
// model. Substack CSV exports don't expose send stats, so archive rows remain
// content-only snapshots.
func streamPostsCSV(r io.Reader, start, limit int) ([]canonical.CampaignArchive, int, error) {
	return streamPostsCSVWithArchive(r, start, limit, "")
}

func streamPostsCSVWithArchive(r io.Reader, start, limit int, archiveDir string) ([]canonical.CampaignArchive, int, error) {
	if start < 0 {
		return nil, 0, fmt.Errorf("substack: archive cursor cannot be negative")
	}
	reader := newSubstackCSVReader(r)
	idx, ok, err := readCSVHeader(reader)
	if err != nil || !ok {
		return nil, 0, err
	}
	if !headerHasAny(idx, "post_id", "source_id", "id", "title", "subject") {
		return nil, 0, fmt.Errorf("substack: posts CSV is missing post identity/title columns")
	}
	if !headerHasAny(idx, "email_sent_at", "inbox_sent_at", "sent_at") {
		return nil, 0, fmt.Errorf("substack: posts CSV is missing email-send evidence (email_sent_at, inbox_sent_at, or sent_at)")
	}
	content, stats, err := indexPostExportFiles(archiveDir)
	if err != nil {
		return nil, 0, err
	}

	out := make([]canonical.CampaignArchive, 0, pageCapacity(limit))
	row := 0
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			return out, 0, nil
		}
		if err != nil {
			return nil, 0, fmt.Errorf("read row: %w", err)
		}
		archive, include := postFromRecord(rec, idx)
		if !include {
			continue
		}
		if archive.HTML == "" {
			if htmlPath := content[archive.SourceID]; htmlPath != "" {
				raw, readErr := os.ReadFile(htmlPath)
				if readErr != nil {
					return nil, 0, fmt.Errorf("substack: read post HTML %q: %w", filepath.Base(htmlPath), readErr)
				}
				archive.HTML = string(raw)
			} else if archiveDir != "" {
				archive.Warnings = append(archive.Warnings, "Substack export metadata had no matching HTML fragment; post content requires manual recovery.")
			}
		}
		if stat, exists := stats[archive.SourceID]; exists {
			mergeStats(&archive, stat)
		}
		if row < start {
			row++
			continue
		}
		if limit > 0 && len(out) >= limit {
			return out, row, nil
		}
		out = append(out, archive)
		row++
	}
}

func countPostsCSV(r io.Reader) (int, error) {
	reader := newSubstackCSVReader(r)
	idx, ok, err := readCSVHeader(reader)
	if err != nil || !ok {
		return 0, err
	}
	if !headerHasAny(idx, "post_id", "source_id", "id", "title", "subject") {
		return 0, fmt.Errorf("substack: posts CSV is missing post identity/title columns")
	}
	if !headerHasAny(idx, "email_sent_at", "inbox_sent_at", "sent_at") {
		return 0, fmt.Errorf("substack: posts CSV is missing email-send evidence (email_sent_at, inbox_sent_at, or sent_at)")
	}
	count := 0
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			return count, nil
		}
		if err != nil {
			return 0, fmt.Errorf("read row: %w", err)
		}
		if _, include := postFromRecord(rec, idx); include {
			count++
		}
	}
}

func loadPostStatsCSV(path string) ([]postStatsRow, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open archive stats csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	return parsePostStatsCSV(f)
}

func parsePostStatsCSV(r io.Reader) ([]postStatsRow, error) {
	reader := newSubstackCSVReader(r)
	idx, ok, err := readCSVHeader(reader)
	if err != nil || !ok {
		return nil, err
	}
	out := []postStatsRow{}
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read stats row: %w", err)
		}
		row := postStatsFromRecord(rec, idx)
		if len(statsKeys(row)) == 0 {
			continue
		}
		out = append(out, row)
	}
}

func newSubstackCSVReader(r io.Reader) *csv.Reader {
	reader := csv.NewReader(r)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	return reader
}

func readCSVHeader(reader *csv.Reader) (map[string]int, bool, error) {
	header, err := reader.Read()
	if err == io.EOF {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read header: %w", err)
	}
	idx, err := indexHeader(header)
	if err != nil {
		return nil, false, err
	}
	return idx, true, nil
}

func pageCapacity(limit int) int {
	if limit <= 0 {
		return 0
	}
	return limit
}

// indexHeader builds a normalized name → column-index map. Duplicate columns
// are rejected instead of silently allowing the last one to shadow evidence.
func indexHeader(h []string) (map[string]int, error) {
	m := map[string]int{}
	for i, name := range h {
		normalized := normalizeHeader(name)
		if normalized == "" {
			continue
		}
		if _, exists := m[normalized]; exists {
			return nil, fmt.Errorf("substack: duplicate CSV header %q", normalized)
		}
		m[normalized] = i
	}
	return m, nil
}

func normalizeHeader(raw string) string {
	raw = strings.TrimPrefix(raw, "\ufeff")
	raw = strings.ToLower(strings.TrimSpace(raw))
	var normalized strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			normalized.WriteRune(r)
		default:
			normalized.WriteByte('_')
		}
	}
	raw = normalized.String()
	for strings.Contains(raw, "__") {
		raw = strings.ReplaceAll(raw, "__", "_")
	}
	return strings.Trim(raw, "_")
}

func getCol(rec []string, idx map[string]int, name string) string {
	i, ok := idx[normalizeHeader(name)]
	if !ok || i >= len(rec) {
		return ""
	}
	return rec[i]
}

func firstCol(rec []string, idx map[string]int, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(getCol(rec, idx, name)); value != "" {
			return value
		}
	}
	return ""
}

func headerHasAny(idx map[string]int, names ...string) bool {
	for _, name := range names {
		if _, ok := idx[normalizeHeader(name)]; ok {
			return true
		}
	}
	return false
}

func csvHeaderFromPath(filePath string) (map[string]int, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	reader := newSubstackCSVReader(f)
	idx, ok, err := readCSVHeader(reader)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("empty CSV")
	}
	return idx, nil
}

func validateSubscribersCSVPath(filePath string) error {
	idx, err := csvHeaderFromPath(filePath)
	if err != nil {
		return fmt.Errorf("substack: invalid subscriber CSV: %w", err)
	}
	if !headerHasAny(idx, "email", "email_address", "subscriber_email") {
		return fmt.Errorf("substack: subscriber CSV is missing an email column")
	}
	return nil
}

func slug(parts ...string) string {
	return strings.Join(parts, "|")
}

func subscriberFromRecord(rec []string, idx map[string]int) (canonical.Subscriber, bool) {
	row := subsCSVRow{Extras: map[string]string{}}
	row.SourceID = firstCol(rec, idx, "subscriber_id", "user_id", "subscription_id", "id")
	row.Email = strings.ToLower(firstCol(rec, idx, "email", "email_address", "subscriber_email"))
	row.CreatedAt = firstCol(rec, idx, "created_at", "subscription_date", "subscribed_at", "date_subscribed", "signup_date")
	row.State = strings.ToLower(firstCol(rec, idx, "state", "status", "subscription_status", "email_status"))
	row.EmailDisabled = strings.ToLower(firstCol(rec, idx, "email_disabled", "email_disabled_at", "disabled"))
	row.Source = firstCol(rec, idx, "source", "subscription_source", "signup_source")
	row.Name = firstCol(rec, idx, "name", "full_name")
	row.FirstName = firstCol(rec, idx, "first_name", "firstname")
	row.LastName = firstCol(rec, idx, "last_name", "lastname")
	row.Tier = strings.ToLower(firstCol(rec, idx, "subscription_type", "plan_type", "tier", "subscription_plan", "type"))
	// Stash any non-canonical columns as custom fields.
	for col, ci := range idx {
		switch col {
		case "email", "email_address", "subscriber_email",
			"subscriber_id", "user_id", "subscription_id", "id",
			"created_at", "subscription_date", "subscribed_at", "date_subscribed", "signup_date",
			"state", "status", "subscription_status", "email_status",
			"email_disabled", "email_disabled_at", "disabled",
			"source", "subscription_source", "signup_source",
			"name", "full_name", "first_name", "firstname", "last_name", "lastname",
			"subscription_type", "plan_type", "tier", "subscription_plan", "type":
			continue
		}
		if ci < len(rec) {
			row.Extras[col] = rec[ci]
		}
	}
	if row.Email == "" {
		return canonical.Subscriber{}, false
	}
	return mapSubscriber(row), true
}

func recordHasData(record []string) bool {
	for _, value := range record {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func validSubstackEmail(value string) bool {
	value = strings.TrimSpace(value)
	parsed, err := mail.ParseAddress(value)
	return err == nil && strings.EqualFold(parsed.Address, value)
}

func postFromRecord(rec []string, idx map[string]int) (canonical.CampaignArchive, bool) {
	title := firstCol(rec, idx, "title", "subject", "post_title")
	subtitle := firstCol(rec, idx, "subtitle", "description")
	emailSentAt := firstCol(rec, idx, "email_sent_at", "inbox_sent_at", "sent_at")
	published := firstCol(rec, idx, "published_at", "post_date", "publication_date", "date")
	body := firstCol(rec, idx, "body_html", "html", "content_html")
	audience := firstCol(rec, idx, "audience", "recipient_type")
	if emailSentAt == "" {
		// The destination archive is materialized as sent campaign history.
		// Drafts, pages, and web-only posts are retained by source-archive
		// evidence instead of being misrepresented as delivered email.
		return canonical.CampaignArchive{}, false
	}
	if title == "" && body == "" {
		return canonical.CampaignArchive{}, false
	}
	sourceID := firstNonEmpty(
		firstCol(rec, idx, "source_id", "post_id", "id"),
		firstCol(rec, idx, "slug"),
		firstCol(rec, idx, "url", "canonical_url", "post_url"),
		slug(title, firstNonEmpty(emailSentAt, published)),
	)
	if sourceID == "" {
		return canonical.CampaignArchive{}, false
	}
	recipients := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "recipients_count"),
		getCol(rec, idx, "recipient_count"),
		getCol(rec, idx, "recipients"),
		getCol(rec, idx, "sent_to"),
	))
	opens := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "opens"),
		getCol(rec, idx, "unique_opens"),
		getCol(rec, idx, "open_count"),
	))
	clicks := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "clicks"),
		getCol(rec, idx, "unique_clicks"),
		getCol(rec, idx, "click_count"),
	))

	sentAt := parseSubstackTime(firstNonEmpty(emailSentAt, published))
	subject := title
	if subtitle != "" {
		subject = title + " — " + subtitle
	}

	report := map[string]interface{}{}
	for _, key := range []string{"audience", "slug", "url", "canonical_url", "post_url", "type", "podcast_url", "is_published", "post_date", "email_sent_at", "inbox_sent_at"} {
		value := strings.TrimSpace(getCol(rec, idx, key))
		if value != "" {
			report[key] = value
		}
	}
	if audience != "" {
		report["audience"] = audience
	}
	if len(report) == 0 {
		report = nil
	}
	archive := canonical.CampaignArchive{
		SourceID:       sourceID,
		Subject:        subject,
		HTML:           body,
		Text:           "",
		SentAt:         sentAt,
		SourcePlatform: canonical.SourceSubstack,
		// Standard Substack CSV exports do not expose campaign analytics.
		// Enriched exports/scraped CSVs can include the optional columns above;
		// when absent, these remain zero and the parity report flags reports as
		// unavailable for review.
		RecipientsCount: recipients,
		Opens:           opens,
		Clicks:          clicks,
		Report:          report,
	}
	if sentAt.IsZero() {
		archive.Warnings = append(archive.Warnings, "Substack export did not provide a parseable send timestamp.")
	}
	return archive, true
}

func parseSubstackTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}

// indexPostExportFiles joins posts.csv metadata to official export fragments
// such as posts/<post_id>.<slug>.html, <post_id>.delivers.csv, and
// <post_id>.opens.csv. Recipient identities are counted and discarded.
func indexPostExportFiles(root string) (map[string]string, map[string]postStatsRow, error) {
	content := map[string]string{}
	stats := map[string]postStatsRow{}
	statsSeen := map[string]struct{}{}
	if strings.TrimSpace(root) == "" {
		return content, stats, nil
	}
	err := filepath.WalkDir(root, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		base := entry.Name()
		lower := strings.ToLower(base)
		switch {
		case strings.HasSuffix(lower, ".html") || strings.HasSuffix(lower, ".htm"):
			postID := strings.TrimSpace(strings.SplitN(base, ".", 2)[0])
			if postID == "" {
				return nil
			}
			if previous := content[postID]; previous != "" && previous != filePath {
				return fmt.Errorf("substack: multiple HTML fragments match post %q", postID)
			}
			content[postID] = filePath
		case strings.HasSuffix(lower, ".delivers.csv"), strings.HasSuffix(lower, ".opens.csv"):
			postID := strings.TrimSpace(strings.SplitN(base, ".", 2)[0])
			if postID == "" {
				return nil
			}
			kind := "opens"
			if strings.HasSuffix(lower, ".delivers.csv") {
				kind = "deliveries"
			}
			statKey := strings.ToLower(postID) + "\x00" + kind
			if _, duplicate := statsSeen[statKey]; duplicate {
				return fmt.Errorf("substack: multiple %s files match post %q", kind, postID)
			}
			statsSeen[statKey] = struct{}{}
			count, err := countCSVDataRows(filePath)
			if err != nil {
				return fmt.Errorf("substack: count %s: %w", base, err)
			}
			row := stats[postID]
			row.SourceID = postID
			if row.Report == nil {
				row.Report = map[string]interface{}{"source": "substack_export_recipient_statistics"}
			}
			if strings.HasSuffix(lower, ".delivers.csv") {
				row.RecipientsCount = count
				row.Report["deliveries_counted"] = count
			} else {
				row.Opens = count
				row.Report["opens_counted"] = count
			}
			stats[postID] = row
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return content, stats, nil
}

func countCSVDataRows(filePath string) (int, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	reader := newSubstackCSVReader(f)
	if _, err := reader.Read(); err == io.EOF {
		return 0, nil
	} else if err != nil {
		return 0, err
	}
	count := 0
	for {
		record, err := reader.Read()
		if err == io.EOF {
			return count, nil
		}
		if err != nil {
			return 0, err
		}
		for _, value := range record {
			if strings.TrimSpace(value) != "" {
				count++
				break
			}
		}
	}
}

func postStatsFromRecord(rec []string, idx map[string]int) postStatsRow {
	title := firstNonEmpty(getCol(rec, idx, "title"), getCol(rec, idx, "post_title"))
	subject := firstNonEmpty(getCol(rec, idx, "subject"), getCol(rec, idx, "email_subject"))
	published := firstNonEmpty(getCol(rec, idx, "published_at"), getCol(rec, idx, "sent_at"), getCol(rec, idx, "date"))
	recipients := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "recipients_count"),
		getCol(rec, idx, "recipient_count"),
		getCol(rec, idx, "recipients"),
		getCol(rec, idx, "sent_to"),
		getCol(rec, idx, "emails_sent"),
	))
	opens := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "opens"),
		getCol(rec, idx, "unique_opens"),
		getCol(rec, idx, "open_count"),
		getCol(rec, idx, "opened"),
	))
	clicks := parseOptionalCount(firstNonEmpty(
		getCol(rec, idx, "clicks"),
		getCol(rec, idx, "unique_clicks"),
		getCol(rec, idx, "click_count"),
		getCol(rec, idx, "clicked"),
	))
	openRate := parseOptionalRate(firstNonEmpty(getCol(rec, idx, "open_rate"), getCol(rec, idx, "opens_rate")))
	clickRate := parseOptionalRate(firstNonEmpty(getCol(rec, idx, "click_rate"), getCol(rec, idx, "clicks_rate")))
	if recipients > 0 && opens == 0 && openRate > 0 {
		opens = int(math.Round(float64(recipients) * openRate))
	}
	if recipients > 0 && clicks == 0 && clickRate > 0 {
		clicks = int(math.Round(float64(recipients) * clickRate))
	}

	report := map[string]interface{}{
		"source": firstNonEmpty(getCol(rec, idx, "statistics_source"), "archive_stats_csv"),
	}
	for _, key := range []string{
		"views", "reads", "likes", "comments", "shares", "restacks",
		"pledges", "paid_conversions", "free_signups", "web_views",
	} {
		if n := parseOptionalCount(getCol(rec, idx, key)); n > 0 {
			report[key] = n
		}
	}
	if openRate > 0 {
		report["open_rate"] = openRate
	}
	if clickRate > 0 {
		report["click_rate"] = clickRate
	}
	if raw := strings.TrimSpace(getCol(rec, idx, "url")); raw != "" {
		report["url"] = raw
	}
	if raw := strings.TrimSpace(getCol(rec, idx, "slug")); raw != "" {
		report["slug"] = raw
	}

	return postStatsRow{
		SourceID: firstNonEmpty(
			getCol(rec, idx, "source_id"),
			getCol(rec, idx, "post_id"),
			getCol(rec, idx, "id"),
		),
		Title:           title,
		Subject:         subject,
		PublishedAt:     published,
		Slug:            firstNonEmpty(getCol(rec, idx, "slug"), getCol(rec, idx, "post_slug")),
		URL:             firstNonEmpty(getCol(rec, idx, "url"), getCol(rec, idx, "canonical_url"), getCol(rec, idx, "post_url")),
		RecipientsCount: recipients,
		Opens:           opens,
		Clicks:          clicks,
		Report:          report,
	}
}

func applyPostStats(posts []canonical.CampaignArchive, stats []postStatsRow) {
	if len(posts) == 0 || len(stats) == 0 {
		return
	}
	byKey := map[string]postStatsRow{}
	for _, row := range stats {
		for _, key := range statsKeys(row) {
			if key != "" {
				byKey[key] = row
			}
		}
	}
	for i := range posts {
		for _, key := range archiveKeys(posts[i]) {
			row, ok := byKey[key]
			if !ok {
				continue
			}
			mergeStats(&posts[i], row)
			break
		}
	}
}

func mergeStats(post *canonical.CampaignArchive, stats postStatsRow) {
	if stats.RecipientsCount > 0 {
		post.RecipientsCount = stats.RecipientsCount
	}
	if stats.Opens > 0 {
		post.Opens = stats.Opens
	}
	if stats.Clicks > 0 {
		post.Clicks = stats.Clicks
	}
	if post.Report == nil {
		post.Report = map[string]interface{}{}
	}
	for key, value := range stats.Report {
		post.Report[key] = value
	}
}

func statsKeys(row postStatsRow) []string {
	var keys []string
	addKey := func(prefix, value string) {
		if value = normalizeArchiveKey(value); value != "" {
			keys = append(keys, prefix+":"+value)
		}
	}
	addKey("source", row.SourceID)
	addKey("slug", row.Slug)
	addKey("url", row.URL)
	addKey("subject", firstNonEmpty(row.Subject, row.Title))
	if row.Title != "" && row.PublishedAt != "" {
		addKey("source", slug(row.Title, row.PublishedAt))
	}
	return keys
}

func archiveKeys(post canonical.CampaignArchive) []string {
	var keys []string
	addKey := func(prefix, value string) {
		if value = normalizeArchiveKey(value); value != "" {
			keys = append(keys, prefix+":"+value)
		}
	}
	addKey("source", post.SourceID)
	addKey("subject", post.Subject)
	if !post.SentAt.IsZero() && post.Subject != "" {
		title := strings.TrimSpace(strings.Split(post.Subject, " — ")[0])
		addKey("source", slug(title, post.SentAt.Format(time.RFC3339)))
	}
	if post.Report != nil {
		for _, key := range []string{"slug", "url", "canonical_url", "post_url"} {
			if raw, ok := post.Report[key].(string); ok {
				addKey(keyAlias(key), raw)
			}
		}
	}
	return keys
}

func keyAlias(key string) string {
	switch key {
	case "canonical_url", "post_url":
		return "url"
	default:
		return key
	}
}

func normalizeArchiveKey(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	raw = strings.TrimSuffix(raw, "/")
	raw = strings.TrimPrefix(raw, "https://")
	raw = strings.TrimPrefix(raw, "http://")
	raw = strings.TrimPrefix(raw, "www.")
	return raw
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return ""
}

func parseOptionalCount(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	raw = strings.TrimSuffix(raw, "%")
	raw = strings.ReplaceAll(raw, ",", "")
	raw = strings.ReplaceAll(raw, "_", "")
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func parseOptionalRate(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	hadPercent := strings.HasSuffix(raw, "%")
	raw = strings.TrimSuffix(raw, "%")
	raw = strings.ReplaceAll(raw, ",", "")
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n < 0 {
		return 0
	}
	if hadPercent || n > 1 {
		n /= 100
	}
	if n > 1 {
		return 0
	}
	return n
}

// mapSubscriber translates a Substack CSV row into a canonical Subscriber.
func mapSubscriber(r subsCSVRow) canonical.Subscriber {
	// A missing or unfamiliar state is not proof that an address is sendable.
	// Current Substack exports can be column-filtered, so absence of a status
	// column must fail closed even when every row came from the subscriber UI.
	status := canonical.StatusUnconfirmed
	switch r.State {
	case "active", "subscribed", "enabled", "email enabled":
		// Preserve the source status below, but do not translate list
		// membership into permission to send from a different platform.
		status = canonical.StatusUnconfirmed
	case "canceled", "cancelled", "expired", "unsubscribed", "deleted", "disabled", "email disabled":
		status = canonical.StatusDisabled
	case "complained", "complaint", "bounced", "hard bounced", "spam", "junk":
		status = canonical.StatusBlocklisted
	case "pending", "unconfirmed":
		status = canonical.StatusUnconfirmed
	}
	if raw := strings.TrimSpace(r.EmailDisabled); raw != "" && raw != "false" && raw != "0" && raw != "no" {
		status = canonical.StatusDisabled
	}

	custom := map[string]interface{}{}
	if r.Name != "" {
		custom["name"] = r.Name
	}
	if r.FirstName != "" {
		custom["first_name"] = r.FirstName
	}
	if r.LastName != "" {
		custom["last_name"] = r.LastName
	}
	if r.Source != "" {
		custom["substack_source"] = r.Source
	}
	if r.CreatedAt != "" {
		// This is signup/import provenance, not portable opt-in evidence.
		custom["substack_created_at"] = r.CreatedAt
	}
	if r.State != "" {
		custom["substack_status"] = r.State
	}
	if r.Tier != "" {
		custom["substack_subscription_type"] = r.Tier
	}
	for k, v := range r.Extras {
		if v != "" {
			custom["substack_"+normalizeHeader(k)] = v
		}
	}
	tags := []string{}
	if tier := normalizeTagPart(r.Tier); tier != "" {
		tags = append(tags, "substack:tier:"+tier)
	}
	sourceID := strings.TrimSpace(r.SourceID)
	if sourceID == "" {
		sourceID = strings.ToLower(strings.TrimSpace(r.Email))
	}

	return canonical.Subscriber{
		Email:            r.Email,
		Status:           status,
		ConsentTimestamp: nil,
		ConsentSource:    canonical.ConsentUnknown,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         sourceID,
		SourcePlatform:   canonical.SourceSubstack,
	}
}

func normalizeTagPart(raw string) string {
	raw = normalizeHeader(raw)
	raw = strings.ReplaceAll(raw, "_", "-")
	return strings.Trim(raw, "-")
}

func mergeDuplicateSubscriber(existing, next canonical.Subscriber) canonical.Subscriber {
	if subscriberStatusSeverity(next.Status) > subscriberStatusSeverity(existing.Status) {
		existing.Status = next.Status
	}
	if existing.SourceID == "" || existing.SourceID == existing.Email {
		if next.SourceID != "" {
			existing.SourceID = next.SourceID
		}
	}
	if existing.CustomFields == nil {
		existing.CustomFields = map[string]interface{}{}
	}
	for key, value := range next.CustomFields {
		if current, present := existing.CustomFields[key]; !present || fmt.Sprint(current) == "" {
			existing.CustomFields[key] = value
		}
	}
	tagSet := make(map[string]struct{}, len(existing.Tags)+len(next.Tags))
	for _, tag := range append(append([]string(nil), existing.Tags...), next.Tags...) {
		if tag = strings.TrimSpace(tag); tag != "" {
			tagSet[tag] = struct{}{}
		}
	}
	existing.Tags = existing.Tags[:0]
	for tag := range tagSet {
		existing.Tags = append(existing.Tags, tag)
	}
	sort.Strings(existing.Tags)
	return existing
}

func subscriberStatusSeverity(status canonical.SubscriberStatus) int {
	switch status {
	case canonical.StatusBlocklisted:
		return 4
	case canonical.StatusDisabled:
		return 3
	case canonical.StatusUnconfirmed:
		return 2
	case canonical.StatusEnabled:
		return 1
	default:
		return 2
	}
}
