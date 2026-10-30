// SPDX-License-Identifier: MIT

// Package csv implements the universal CSV importer.
//
// Heuristics-based: at Authenticate-time we sniff up to 100 rows of the file
// to infer which canonical fields each column corresponds to. The detected
// mapping is persisted on the Session.AccessToken (JSON-encoded) so streaming
// in ListSubscribers stays stateless across resumes.
package csv

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/mail"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/postwave/migrate/canonical"
)

// FieldKind enumerates the canonical roles a CSV column can play.
type FieldKind string

const (
	KindEmail            FieldKind = "email"
	KindStatus           FieldKind = "status"
	KindConsentTimestamp FieldKind = "consent_timestamp"
	KindName             FieldKind = "name"
	KindFirstName        FieldKind = "first_name"
	KindLastName         FieldKind = "last_name"
	KindTags             FieldKind = "tags"
	KindCustom           FieldKind = "custom"
	KindIgnore           FieldKind = "ignore"
)

// ColumnMapping is one column's detected role.
type ColumnMapping struct {
	Index int       `json:"index"`
	Name  string    `json:"name"`
	Kind  FieldKind `json:"kind"`
	// CustomKey is the key used in canonical.Subscriber.CustomFields when
	// Kind == KindCustom (defaults to lowercased Name).
	CustomKey string `json:"custom_key,omitempty"`
}

// Mapping is the full per-file detection result.
type Mapping struct {
	Profile canonical.SourcePlatform `json:"profile,omitempty"`
	Path    string                   `json:"path"`
	Headers []string                 `json:"headers"`
	Columns []ColumnMapping          `json:"columns"`
	Rows    int                      `json:"rows"`
}

var (
	emailHeaderRE = regexp.MustCompile(`(?i)^(e[-_ ]?mail|email[-_ ]?address|emailaddress)$`)
	emailValueRE  = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

	statusHeaders = []string{"status", "subscribed", "active", "is_subscribed", "is_active", "state"}
	// The name families are matched against the SEPARATOR-NORMALISED header
	// (normalizeHeader), so "First Name", "first-name" and "FIRSTNAME" all
	// reach the same entry and none of them has to be listed twice.
	nameHeaders      = []string{"name", "full_name", "fullname", "contact_name", "subscriber_name"}
	firstNameHeaders = []string{"first_name", "firstname", "first", "given_name", "givenname", "fname"}
	lastNameHeaders  = []string{"last_name", "lastname", "last", "surname", "family_name", "familyname", "lname"}
	tagHeaders       = []string{"tags", "groups", "labels"}
	// Only explicit permission evidence is eligible. Account creation, signup,
	// and arbitrary date-shaped values do not establish consent.
	consentHeaders    = []string{"opt_in_at", "opted_in_at", "consent_at", "consent_timestamp"}
	booleanTrueValues = map[string]struct{}{"true": {}, "yes": {}, "1": {}, "y": {}, "active": {}, "subscribed": {}, "enabled": {}}
	booleanFalseVals  = map[string]struct{}{"false": {}, "no": {}, "0": {}, "n": {}, "inactive": {}, "unsubscribed": {}, "disabled": {}}
)

// DetectMapping reads up to 100 rows of `r` and returns the inferred mapping.
func DetectMapping(r io.Reader) (*Mapping, [][]string, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	header, err := readCSVRecord(cr)
	if err != nil {
		return nil, nil, fmt.Errorf("read header: %w", err)
	}
	seenHeaders := map[string]bool{}
	for i, h := range header {
		header[i] = strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))
		normalized := normalizeHeader(header[i])
		if normalized == "" || seenHeaders[normalized] {
			return nil, nil, fmt.Errorf("csv: empty or duplicate column header; give each column a unique name")
		}
		seenHeaders[normalized] = true
	}

	// Read up to 100 sample rows for value-based inference.
	const sampleLimit = 100
	var samples [][]string
	for len(samples) < sampleLimit {
		rec, err := readCSVRecord(cr)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, fmt.Errorf("read sample: %w", err)
		}
		samples = append(samples, rec)
	}

	mp := &Mapping{
		Headers: header,
		Rows:    len(samples),
		Columns: make([]ColumnMapping, len(header)),
	}

	state := &detectState{assigned: map[FieldKind]bool{}}
	for i, name := range header {
		col := ColumnMapping{Index: i, Name: name}
		col.Kind = inferKind(name, sampleColumn(samples, i), state)
		if col.Kind == KindCustom {
			col.CustomKey = sanitizeKey(name)
		}
		mp.Columns[i] = col
	}

	if !state.assigned[KindEmail] {
		// Promote the column with the most email-shaped values, if any.
		bestIdx, bestHits := -1, 0
		for i := range header {
			hits := 0
			for _, v := range sampleColumn(samples, i) {
				if emailValueRE.MatchString(strings.TrimSpace(v)) {
					hits++
				}
			}
			if hits > bestHits {
				bestHits, bestIdx = hits, i
			}
		}
		if bestIdx >= 0 && bestHits > 0 {
			mp.Columns[bestIdx].Kind = KindEmail
			mp.Columns[bestIdx].CustomKey = ""
		}
	}

	return mp, samples, nil
}

func sampleColumn(rows [][]string, i int) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if i < len(r) {
			out = append(out, r[i])
		}
	}
	return out
}

// detectState carries what DetectMapping has already handed out. Every
// destination except KindCustom / KindIgnore holds exactly one source column:
// a second column that would claim a taken destination becomes a custom field
// instead, because two sources writing one destination is a mapping the
// importer refuses to execute (it would silently overwrite the first value).
type detectState struct {
	assigned map[FieldKind]bool
}

// claim reports whether kind is still free, and takes it when it is.
func (s *detectState) claim(kind FieldKind) bool {
	if s.assigned[kind] {
		return false
	}
	s.assigned[kind] = true
	return true
}

// normalizeHeader folds a CSV header to the form the synonym sets are written
// in: lower case, every run of non-alphanumerics collapsed to one underscore,
// no leading or trailing underscore. "First Name", "first-name" and
// " FIRSTNAME " all become first_name / firstname.
func normalizeHeader(header string) string {
	var b strings.Builder
	b.Grow(len(header))
	pendingSeparator := false
	for _, r := range strings.ToLower(strings.TrimSpace(header)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingSeparator && b.Len() > 0 {
				b.WriteByte('_')
			}
			pendingSeparator = false
			b.WriteRune(r)
		default:
			pendingSeparator = true
		}
	}
	return b.String()
}

func inferKind(header string, samples []string, state *detectState) FieldKind {
	low := strings.ToLower(strings.TrimSpace(header))
	if !state.assigned[KindEmail] && emailHeaderRE.MatchString(low) {
		state.assigned[KindEmail] = true
		return KindEmail
	}
	// The name family is matched on the normalised header so a spreadsheet's
	// "First Name" is the given-name column and not a brand-new custom field.
	// First/last are separate destinations: a contact export almost always
	// carries both, and folding either into the single full-name destination
	// loses the other.
	normalized := normalizeHeader(header)
	switch {
	case containsString(consentHeaders, normalized):
		if state.claim(KindConsentTimestamp) {
			return KindConsentTimestamp
		}
	case containsString(statusHeaders, normalized):
		if state.claim(KindStatus) {
			return KindStatus
		}
	case containsString(nameHeaders, normalized):
		if state.claim(KindName) {
			return KindName
		}
	case containsString(firstNameHeaders, normalized):
		if state.claim(KindFirstName) {
			return KindFirstName
		}
	case containsString(lastNameHeaders, normalized):
		if state.claim(KindLastName) {
			return KindLastName
		}
	case containsString(tagHeaders, normalized):
		if state.claim(KindTags) {
			return KindTags
		}
	}

	// Values can identify an email address, but cannot establish the meaning
	// of a date or boolean column (for example birthday or VIP status).
	emailHits, total := 0, 0
	for _, v := range samples {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		total++
		if emailValueRE.MatchString(v) {
			emailHits++
		}
	}
	if total == 0 {
		return KindCustom
	}
	if !state.assigned[KindEmail] && float64(emailHits)/float64(total) > 0.5 {
		state.assigned[KindEmail] = true
		return KindEmail
	}
	return KindCustom
}

func containsString(haystack []string, s string) bool {
	for _, h := range haystack {
		if h == s {
			return true
		}
	}
	return false
}

func sanitizeKey(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, " ", "_")
	name = strings.ToLower(name)
	return name
}

// applyRow turns one CSV record into a canonical.Subscriber using the mapping.
func applyRow(rec []string, m *Mapping) (canonical.Subscriber, bool) {
	sub := canonical.Subscriber{
		Status:         canonical.StatusUnconfirmed,
		ConsentSource:  canonical.ConsentImport,
		CustomFields:   map[string]interface{}{},
		SourcePlatform: canonical.SourceCSV,
	}
	for _, col := range m.Columns {
		if col.Index < 0 || col.Index >= len(rec) {
			continue
		}
		val := strings.TrimSpace(rec[col.Index])
		if val == "" {
			continue
		}
		switch col.Kind {
		case KindEmail:
			sub.Email = strings.ToLower(val)
			sub.SourceID = strings.ToLower(val)
		case KindStatus:
			sub.Status = subscriptionStatus(val)
			sub.CustomFields["status_raw"] = val
		case KindConsentTimestamp:
			sub.ConsentTimestamp = parseConsentDate(val)

		case KindName:
			sub.CustomFields["name"] = val
		case KindFirstName:
			// The canonical subscriber carries names in CustomFields; these are
			// the keys migration 0413 promotes into subscribers.first_name /
			// .last_name, so a migrated contact lands in the same columns a CSV
			// import fills.
			sub.CustomFields["first_name"] = val
		case KindLastName:
			sub.CustomFields["last_name"] = val
		case KindTags:
			for _, t := range strings.Split(val, ",") {
				if t = strings.TrimSpace(t); t != "" {
					sub.Tags = append(sub.Tags, t)
				}
			}
		case KindCustom:
			key := col.CustomKey
			if key == "" {
				key = sanitizeKey(col.Name)
			}
			sub.CustomFields[key] = val
		}
	}
	applyProfileEvidence(&sub, rec, m)
	parsed, err := mail.ParseAddress(sub.Email)
	if err != nil || parsed.Address != sub.Email {
		return canonical.Subscriber{}, false
	}
	return sub, true
}

// subscriptionStatus never promotes an unfamiliar state to sendable. Bounce
// and complaint suppressions must survive imports even when a provider uses
// different punctuation or capitalization.
func subscriptionStatus(value string) canonical.SubscriberStatus {
	value = normalizeHeader(value)
	if _, ok := booleanTrueValues[value]; ok {
		return canonical.StatusEnabled
	}
	if _, ok := booleanFalseVals[value]; ok {
		return canonical.StatusDisabled
	}
	switch value {
	case "bounced", "bounce", "hard_bounce", "hard_bounced", "soft_bounce", "soft_bounced", "spam", "complaint", "complained", "spam_complaint", "marked_as_spam", "junk", "blocklisted", "blacklisted", "suppressed", "cleaned":
		return canonical.StatusBlocklisted
	case "cancelled", "canceled", "removed", "archived", "deleted", "opted_out", "opt_out", "non_subscribed", "not_subscribed":
		return canonical.StatusDisabled
	default:
		return canonical.StatusUnconfirmed
	}
}

// EncodeMapping serialises a Mapping to JSON for transit on the Session.
func EncodeMapping(m *Mapping) (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// DecodeMapping reverses EncodeMapping.
func DecodeMapping(s string) (*Mapping, error) {
	var m Mapping
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	if err := validateMapping(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

func validateMapping(m *Mapping) error {
	if len(m.Columns) == 0 || len(m.Columns) > 10000 {
		return fmt.Errorf("csv: invalid mapping columns")
	}
	seen := map[int]bool{}
	emails := 0
	for _, c := range m.Columns {
		if c.Index < 0 || c.Index >= len(m.Headers) || seen[c.Index] || c.Name != m.Headers[c.Index] {
			return fmt.Errorf("csv: mapping does not match file headers")
		}
		seen[c.Index] = true
		switch c.Kind {
		case KindEmail:
			emails++
		case KindStatus, KindConsentTimestamp, KindName, KindFirstName, KindLastName, KindTags, KindCustom, KindIgnore:
		default:
			return fmt.Errorf("csv: unknown mapping field")
		}
	}
	if emails != 1 || len(seen) != len(m.Headers) {
		return fmt.Errorf("csv: mapping must cover every column and exactly one email field")
	}
	return nil
}

func readCSVRecord(r *csv.Reader) ([]string, error) {
	row, err := r.Read()
	if err != nil {
		return row, err
	}
	for _, v := range row {
		if !utf8.ValidString(v) || strings.ContainsRune(v, 0) {
			return nil, fmt.Errorf("csv: save the export as UTF-8 CSV before uploading")
		}
	}
	return row, nil
}
