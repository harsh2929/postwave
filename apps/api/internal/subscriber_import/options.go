// SPDX-License-Identifier: AGPL-3.0-only
//
// options.go — A11 (2026-06-10 desktop audit): job-level import
// options beyond the column mapping. The wizard's consent-proof,
// tagging and property-creation steps PATCH these onto the preview
// row; both execution paths (inline Confirm + background worker)
// apply them per imported row:
//
//   * tags                 → appended (deduped) to every imported /
//                            updated subscriber, on top of any
//                            per-row tags column.
//   * consent_*            → one consent_records proof row per
//                            imported subscriber via
//                            consent.RecordProof (the 0248 ledger the
//                            consent page reads), plus
//                            subscribers.consent_source /
//                            consent_timestamp on the row itself.
//   * auto_create_properties → mapped custom-field keys missing from
//                            the tenant_custom_fields registry are
//                            registered (type 'string') before the
//                            rows are walked.

package subscriber_import

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"

	migratecsv "github.com/postwave/migrate/csv"
)

// Caps for the PATCH payload. Tags flow into subscribers.tags and the
// segment builder's tag filters; consent_source flows into
// consent_records evidence — both want sane bounds, not open mics.
const (
	MaxImportTags                = 20
	MaxSubscriberTags            = 50
	MaxTagLength                 = 100 // Unicode code points, not bytes.
	MaxTagBytes                  = 400
	MaxSubscriberTagBytes        = 4096
	MaxImportColumns             = 512
	MaxImportHeaderRunes         = 256
	MaxImportedNameRunes         = 512
	MaxImportedCustomValueBytes  = 64 << 10
	MaxConsentSourceLen          = 64
	MaxConsentURLLen             = 2048
	MaxConsentJurisdictionLen    = 32
	MaxConsentReasonLen          = 500
	MaxConsentPolicyVersionLen   = 100
	MaxConsentEvidenceReference  = 288
	ImportConsentScope           = "email_marketing"
	ImportConsentContractVersion = "subscriber-import-consent/v1"
)

var (
	consentEvidenceReferenceRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$`)
	consentJurisdictionRE      = regexp.MustCompile(`^[A-Z][A-Z0-9-]{1,31}$`)
	unsafeSecretShapeRE        = regexp.MustCompile(`(?i)(?:bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret=|signature=|x-amz-signature|sk-[a-z0-9_-]{8,})`)
	unsafeURLQueryKeyRE        = regexp.MustCompile(`(?i)(?:^|_)(?:key|token|secret|password|passwd|signature|sig|code|credential)(?:$|_)`)
	unsafePIIShapeRE           = regexp.MustCompile(`(?i)([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}|\b[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}\b|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b([0-9][ -]?){12,18}[0-9]\b)`)
)

// importOptions is the job-level option set persisted on
// subscriber_imports (migration 0363) and applied to every row during
// execution.
type importOptions struct {
	ConsentSource               string
	ConsentSourceURL            string
	ConsentCapturedAt           *time.Time
	ConsentLegalBasis           string
	ConsentJurisdiction         string
	ConsentReason               string
	ConsentPolicyVersion        string
	ConsentEvidenceReference    string
	ConsentScope                string
	ConsentScopeAcknowledged    bool
	ConsentContractVersion      string
	SourceFingerprint           string
	SourceFingerprintScheme     string
	SourceFingerprintKeyVersion string
	Tags                        []string
	AutoCreateProps             bool
	ScheduleType                string
	ScheduleCron                string
	ScheduledAt                 *time.Time
	DripHoursInterval           int
	DripHoursTotal              int
}

// hasConsent reports whether the import carries a complete, reviewable proof
// tuple. A source label, URL, or timestamp on its own is provenance metadata,
// not permission to send; partial tuples remain unconfirmed and never produce
// a granted proof row.
func (o importOptions) hasConsent() bool {
	source := strings.ToLower(strings.TrimSpace(o.ConsentSource))
	return o.ConsentScopeAcknowledged &&
		isReviewedImportConsentSource(source) &&
		strings.TrimSpace(o.ConsentSourceURL) != "" && o.ConsentCapturedAt != nil &&
		strings.ToLower(strings.TrimSpace(o.ConsentLegalBasis)) == "consent" &&
		strings.TrimSpace(o.ConsentJurisdiction) != "" &&
		strings.TrimSpace(o.ConsentReason) != "" &&
		strings.TrimSpace(o.ConsentPolicyVersion) != "" &&
		strings.TrimSpace(o.ConsentEvidenceReference) != "" &&
		strings.TrimSpace(o.ConsentScope) == ImportConsentScope &&
		strings.TrimSpace(o.ConsentContractVersion) == ImportConsentContractVersion
}

func (o importOptions) hasAnyConsentMetadata() bool {
	return strings.TrimSpace(o.ConsentSource) != "" ||
		strings.TrimSpace(o.ConsentSourceURL) != "" || o.ConsentCapturedAt != nil ||
		strings.TrimSpace(o.ConsentLegalBasis) != "" ||
		strings.TrimSpace(o.ConsentJurisdiction) != "" ||
		strings.TrimSpace(o.ConsentReason) != "" ||
		strings.TrimSpace(o.ConsentPolicyVersion) != "" ||
		strings.TrimSpace(o.ConsentEvidenceReference) != "" ||
		strings.TrimSpace(o.ConsentScope) != "" || o.ConsentScopeAcknowledged
}

func (o importOptions) validateForConfirm(now time.Time) error {
	if !o.hasAnyConsentMetadata() {
		return nil
	}
	if !o.hasConsent() {
		return errors.New("consent evidence is partial or unacknowledged; clear it or provide the complete email_marketing contract")
	}
	if o.ConsentCapturedAt.After(now.UTC()) {
		return errors.New("consent_captured_at cannot be in the future")
	}
	if err := validateConsentURL(strings.TrimSpace(o.ConsentSourceURL)); err != nil {
		return err
	}
	if err := validateEvidenceReference(strings.TrimSpace(o.ConsentEvidenceReference)); err != nil {
		return err
	}
	if err := validateConsentReason(strings.TrimSpace(o.ConsentReason)); err != nil {
		return err
	}
	if !consentJurisdictionRE.MatchString(strings.ToUpper(strings.TrimSpace(o.ConsentJurisdiction))) {
		return errors.New("consent_jurisdiction is invalid")
	}
	if len(strings.TrimSpace(o.ConsentPolicyVersion)) > MaxConsentPolicyVersionLen ||
		unsafeSecretShapeRE.MatchString(o.ConsentPolicyVersion) {
		return errors.New("consent_policy_version is invalid or contains a secret")
	}
	return nil
}

func (o importOptions) subscriberStatusAndConsent() (string, string, *time.Time) {
	if !o.hasConsent() {
		return "unconfirmed", "unknown", nil
	}
	return "enabled", subscriberConsentSource(o.ConsentSource), o.ConsentCapturedAt
}

// proofInput builds the consent_records row appended for one imported
// subscriber. Source is mapped onto the consent_records.source CHECK
// enum; the operator's raw value always survives in evidence so the
// auditor sees exactly what the wizard captured.
func (o importOptions) proofInput(tenantID, importID, approvalID, subscriberID, email, rowFingerprint, evidenceFingerprint string) consent.ProofInput {
	var captured time.Time
	if o.ConsentCapturedAt != nil {
		captured = *o.ConsentCapturedAt
	}
	return consent.ProofInput{
		TenantID:      tenantID,
		SubscriberID:  subscriberID,
		Email:         email,
		Channel:       "email",
		ConsentStatus: "granted",
		Source:        proofSource(o.ConsentSource),
		// The normalized approval owns the reviewed URL/reason/policy tuple.
		// Per-subscriber ledger rows retain only compact linkage.
		SourceURL:  "",
		CapturedAt: captured,
		Evidence: map[string]any{
			"via":                    "subscriber_import",
			"import_id":              importID,
			"approval_id":            approvalID,
			"source_row_fingerprint": rowFingerprint,
			"evidence_fingerprint":   evidenceFingerprint,
		},
	}
}

func isReviewedImportConsentSource(source string) bool {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "double_optin", "single_optin", "signed_form", "preference_center", "direct_request":
		return true
	default:
		return false
	}
}

// consentFingerprint binds an approval to the exact normalized evidence
// tuple. It deliberately excludes email/subscriber identity so the same
// reviewed job contract can be combined with each row fingerprint.
func (o importOptions) consentFingerprint() string {
	if !o.hasConsent() {
		return ""
	}
	return sha256LengthPrefixed(
		"subscriber-import-consent-fingerprint/v1",
		ImportConsentContractVersion,
		strings.ToLower(strings.TrimSpace(o.ConsentSource)),
		strings.TrimSpace(o.ConsentSourceURL),
		strconv.FormatInt(o.ConsentCapturedAt.UTC().UnixMicro(), 10),
		"consent",
		strings.ToUpper(strings.TrimSpace(o.ConsentJurisdiction)),
		strings.TrimSpace(o.ConsentReason),
		strings.TrimSpace(o.ConsentPolicyVersion),
		strings.TrimSpace(o.ConsentEvidenceReference),
		ImportConsentScope,
	)
}

// proofSource maps the operator-supplied consent_source onto the
// consent_records.source CHECK enum (0248). Values already in the
// enum pass through; the wizard's free-form bucket values get their
// closest structured equivalent; anything else lands on 'import'
// (this IS an import) with the raw value preserved in evidence.
func proofSource(s string) string {
	switch s {
	case "form", "double_optin", "single_optin", "api", "import",
		"admin", "preference_center", "one_click", "webhook", "unknown":
		return s
	case "signup_form":
		return "form"
	case "signed_form":
		return "form"
	case "direct_request":
		return "admin"
	case "manual":
		return "admin"
	default: // "", "csv_import", free text
		return "import"
	}
}

// subscriberConsentSource maps the job consent_source onto the
// narrower subscribers.consent_source CHECK set (0003:
// double_optin|single_optin|import|api|unknown). Everything that
// doesn't name a stronger provenance stays 'import'. This mapping is used
// only after hasConsent has verified the complete proof tuple.
func subscriberConsentSource(s string) string {
	switch s {
	case "double_optin", "single_optin", "api":
		return s
	default:
		return "import"
	}
}

// normalizeTags trims, rejects empties, caps length + count, and
// dedupes (exact match — the SQL-side merge uses DISTINCT on the raw
// values too) while preserving order.
func normalizeTags(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" {
			return nil, errors.New("tags must be non-empty strings")
		}
		if utf8.RuneCountInString(t) > MaxTagLength || len(t) > MaxTagBytes {
			return nil, fmt.Errorf("tags must be %d characters or fewer", MaxTagLength)
		}
		key := strings.ToLower(t)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, t)
	}
	if len(out) > MaxImportTags {
		return nil, fmt.Errorf("at most %d tags per import", MaxImportTags)
	}
	return out, nil
}

// validateConsentURL accepts only absolute http(s) URLs — the value
// is rendered as a link on the consent page, so javascript: and
// relative junk must never land.
func validateConsentURL(raw string) error {
	if len(raw) > MaxConsentURLLen {
		return fmt.Errorf("consent_source_url must be %d characters or fewer", MaxConsentURLLen)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("consent_source_url is not a valid URL")
	}
	if u.Scheme != "https" || u.Host == "" {
		return errors.New("consent_source_url must be an absolute https URL")
	}
	if u.User != nil {
		return errors.New("consent_source_url must not contain embedded credentials")
	}
	for key := range u.Query() {
		if unsafeURLQueryKeyRE.MatchString(key) {
			return errors.New("consent_source_url must not contain secret-bearing query parameters")
		}
	}
	if unsafeSecretShapeRE.MatchString(raw) {
		return errors.New("consent_source_url must not contain credentials or secrets")
	}
	return nil
}

func validateEvidenceReference(raw string) error {
	if utf8.RuneCountInString(raw) < 3 || utf8.RuneCountInString(raw) > MaxConsentEvidenceReference ||
		!consentEvidenceReferenceRE.MatchString(raw) {
		return errors.New("consent_evidence_reference must be a safe typed reference such as receipt:CONSENT-123")
	}
	if unsafeSecretShapeRE.MatchString(raw) {
		return errors.New("consent_evidence_reference must not contain credentials or secrets")
	}
	return nil
}

func validateConsentReason(raw string) error {
	if utf8.RuneCountInString(raw) < 1 || utf8.RuneCountInString(raw) > MaxConsentReasonLen {
		return fmt.Errorf("consent_reason is required and must be %d characters or fewer", MaxConsentReasonLen)
	}
	if unsafeSecretShapeRE.MatchString(raw) {
		return errors.New("consent_reason must not contain credentials or secrets; cite the evidence reference")
	}
	if unsafePIIShapeRE.MatchString(raw) {
		return errors.New("consent_reason must not contain personal data; use the typed evidence reference")
	}
	return nil
}

// mergeTags appends the job-level tags after the row's own tags,
// deduping exact matches while preserving order.
func mergeTags(rowTags, jobTags []string) ([]string, error) {
	out := make([]string, 0, len(rowTags)+len(jobTags))
	seen := map[string]struct{}{}
	totalBytes := 0
	for _, set := range [][]string{rowTags, jobTags} {
		for _, t := range set {
			t = strings.TrimSpace(t)
			if t == "" {
				continue
			}
			if utf8.RuneCountInString(t) > MaxTagLength || len(t) > MaxTagBytes {
				return nil, fmt.Errorf("tag exceeds %d characters or %d bytes", MaxTagLength, MaxTagBytes)
			}
			key := strings.ToLower(t)
			if _, dup := seen[key]; dup {
				continue
			}
			if len(out) >= MaxSubscriberTags {
				return nil, fmt.Errorf("subscriber tags exceed the %d-item limit", MaxSubscriberTags)
			}
			if totalBytes+len(t) > MaxSubscriberTagBytes {
				return nil, fmt.Errorf("subscriber tags exceed the %d-byte limit", MaxSubscriberTagBytes)
			}
			seen[key] = struct{}{}
			out = append(out, t)
			totalBytes += len(t)
		}
	}
	return out, nil
}

// propertyCandidate is one registry row auto_create_properties may
// need to create: the jsonb key the import will write plus a human
// label derived from the CSV header.
type propertyCandidate struct {
	Key   string
	Label string
}

// validPropertyKey mirrors customfields.validateKey (unexported
// there): lowercase alphanumeric + underscore, starting with a
// letter, ≤64 chars. Keys that don't fit are skipped — their values
// still land in subscribers.custom_fields jsonb exactly as before,
// they just stay unregistered.
func validPropertyKey(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i, c := range s {
		first := i == 0
		ok := (c >= 'a' && c <= 'z') || (!first && ((c >= '0' && c <= '9') || c == '_'))
		if !ok {
			return false
		}
	}
	return true
}

// propertyCandidatesFromMapping returns the registry keys the mapping
// will write into subscribers.custom_fields: every KindCustom
// column's CustomKey (same fallback as buildRowFields: the raw column
// Name) plus "name" when a KindName column is mapped. Invalid keys
// are filtered here so ensureCustomProperties only attempts creatable
// rows.
func propertyCandidatesFromMapping(m migratecsv.Mapping) []propertyCandidate {
	out := []propertyCandidate{}
	seen := map[string]struct{}{}
	add := func(key, label string) {
		if !validPropertyKey(key) {
			return
		}
		if _, dup := seen[key]; dup {
			return
		}
		seen[key] = struct{}{}
		if label == "" {
			label = key
		}
		out = append(out, propertyCandidate{Key: key, Label: label})
	}
	for _, c := range m.Columns {
		switch c.Kind {
		case migratecsv.KindCustom:
			key := canonicalCustomKey(c)
			add(key, c.Name)
		}
	}
	return out
}

func hasMappedCustomFields(m migratecsv.Mapping) bool {
	for _, column := range m.Columns {
		if column.Kind == migratecsv.KindCustom {
			return true
		}
	}
	return false
}

// mappingOverrideError carries the HTTP error code alongside the
// operator-facing message for a rejected per-column mapping override.
type mappingOverrideError struct {
	code string
	msg  string
}

func (e *mappingOverrideError) Error() string { return e.msg }

// validRemapKind reports whether k is a FieldKind the import pipeline
// understands as a remap target. These mirror canonicalMergeFields.
func validRemapKind(k migratecsv.FieldKind) bool {
	switch k {
	case migratecsv.KindEmail, migratecsv.KindName,
		migratecsv.KindFirstName, migratecsv.KindLastName, migratecsv.KindTags,
		migratecsv.KindCustom, migratecsv.KindIgnore:
		return true
	default:
		return false
	}
}

// validateMappingOverride validates a per-column mapping override
// submitted via PATCH (SUB-102). Rules:
//
//   - every column's Kind must be a recognised remap target;
//   - exactly one column must remain mapped to email (the import refuses
//     to proceed without one, matching Preview);
//   - every non-ignored destination receives at most one source column;
//   - a KindCustom column's effective key (CustomKey, or lowercased Name
//     as fallback — same as buildRowFields) must be a syntactically valid
//     property key. Keys already in the tenant registry pass; unregistered
//     keys are allowed (the worker's auto_create_properties path registers
//     them) but must still be syntactically valid so they can't poison the
//     custom_fields jsonb with garbage keys.
//
// known is the set of registered custom-field keys for the tenant.
func validateMappingOverride(m migratecsv.Mapping, known map[string]struct{}) *mappingOverrideError {
	_ = known // Syntax and frozen geometry, not registry history, are authoritative.
	if _, verr := canonicalizeMapping(m, m.Headers); verr != nil {
		return verr
	}
	for _, c := range m.Columns {
		if !validRemapKind(c.Kind) {
			return &mappingOverrideError{"invalid_mapping_kind",
				fmt.Sprintf("column %q: unknown kind %q", c.Name, c.Kind)}
		}
		if c.Kind == migratecsv.KindCustom {
			key := strings.ToLower(strings.TrimSpace(c.CustomKey))
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(c.Name))
			}
			if !validPropertyKey(key) {
				return &mappingOverrideError{"invalid_custom_key",
					fmt.Sprintf("column %q: custom_key %q is not a valid property key", c.Name, key)}
			}
		}
	}
	return validateMappingTargets(m)
}

func canonicalCustomKey(c migratecsv.ColumnMapping) string {
	key := strings.ToLower(strings.TrimSpace(c.CustomKey))
	if key == "" {
		key = strings.ToLower(strings.TrimSpace(c.Name))
	}
	return key
}

// canonicalizeMapping freezes all source geometry and normalizes every custom
// destination exactly once. frozenHeaders is the header vector detected from
// the uploaded bytes; callers must never accept client-supplied replacement
// headers, paths, or row counts as source truth.
func canonicalizeMapping(m migratecsv.Mapping, frozenHeaders []string) (migratecsv.Mapping, *mappingOverrideError) {
	if len(frozenHeaders) == 0 || len(frozenHeaders) > MaxImportColumns || len(m.Columns) != len(frozenHeaders) {
		return m, &mappingOverrideError{"invalid_mapping_geometry",
			fmt.Sprintf("mapping must contain exactly %d bounded source columns", len(frozenHeaders))}
	}
	seen := make(map[int]struct{}, len(m.Columns))
	for i, h := range frozenHeaders {
		h = strings.TrimSpace(h)
		if utf8.RuneCountInString(h) > MaxImportHeaderRunes {
			return m, &mappingOverrideError{"invalid_mapping_header", "CSV header exceeds the supported length"}
		}
		frozenHeaders[i] = h
	}
	for i := range m.Columns {
		c := &m.Columns[i]
		if c.Index < 0 || c.Index >= len(frozenHeaders) {
			return m, &mappingOverrideError{"invalid_mapping_index",
				fmt.Sprintf("column index %d is outside the uploaded header", c.Index)}
		}
		if _, duplicate := seen[c.Index]; duplicate {
			return m, &mappingOverrideError{"duplicate_mapping_index",
				fmt.Sprintf("column index %d is mapped more than once", c.Index)}
		}
		seen[c.Index] = struct{}{}
		c.Name = frozenHeaders[c.Index]
		if c.Kind == migratecsv.KindCustom {
			c.CustomKey = canonicalCustomKey(*c)
		} else {
			c.CustomKey = ""
		}
	}
	m.Headers = append([]string(nil), frozenHeaders...)
	return m, nil
}

func validateSourceHeader(header []string, mapping migratecsv.Mapping) error {
	if len(header) != len(mapping.Headers) {
		return errors.New("CSV header geometry changed after preview")
	}
	for i := range header {
		if strings.TrimSpace(header[i]) != strings.TrimSpace(mapping.Headers[i]) {
			return fmt.Errorf("CSV header %d changed after preview", i+1)
		}
	}
	return nil
}

// validateMappingTargets is the execution-boundary invariant shared by PATCH,
// dry-run, and confirm. It rejects ambiguity before row shaping can overwrite a
// previously assigned map key. Ignore may repeat because it has no destination.
func validateMappingTargets(m migratecsv.Mapping) *mappingOverrideError {
	emailCols := 0
	targetSources := make(map[string][]string)
	targetOrder := make([]string, 0, len(m.Columns))
	targetLabels := make(map[string]string)
	for _, c := range m.Columns {
		var target, label string
		switch c.Kind {
		case migratecsv.KindEmail:
			emailCols++
			target, label = "email", "email"
		case migratecsv.KindName:
			target, label = "name", "full name"
		case migratecsv.KindFirstName:
			target, label = "first_name", "first name"
		case migratecsv.KindLastName:
			target, label = "last_name", "last name"
		case migratecsv.KindTags:
			target, label = "tags", "tags"
		case migratecsv.KindStatus:
			return &mappingOverrideError{"unsupported_mapping_target",
				"row-level status is not supported; import eligibility is determined by the reviewed job-level consent contract"}
		case migratecsv.KindConsentTimestamp:
			return &mappingOverrideError{"unsupported_mapping_target",
				"row-level consent timestamps are not supported; use the reviewed job-level consent contract"}
		case migratecsv.KindCustom:
			key := strings.ToLower(strings.TrimSpace(c.CustomKey))
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(c.Name))
			}
			target, label = "custom:"+key, fmt.Sprintf("custom field %q", key)
		default:
			continue
		}
		if _, exists := targetSources[target]; !exists {
			targetOrder = append(targetOrder, target)
			targetLabels[target] = label
		}
		targetSources[target] = append(targetSources[target], c.Name)
	}
	if emailCols == 0 {
		return &mappingOverrideError{"no_email_column",
			"mapping must keep exactly one column mapped to email"}
	}
	if emailCols > 1 {
		return &mappingOverrideError{"multiple_email_columns",
			"mapping must keep exactly one column mapped to email"}
	}
	conflicts := make([]string, 0)
	for _, target := range targetOrder {
		if target == "email" || len(targetSources[target]) < 2 {
			continue
		}
		conflicts = append(conflicts,
			fmt.Sprintf("%s receives %q", targetLabels[target], targetSources[target]))
	}
	if len(conflicts) > 0 {
		return &mappingOverrideError{"duplicate_mapping_targets",
			"each mapping target must receive exactly one source column: " + strings.Join(conflicts, "; ")}
	}
	return nil
}

// ensureCustomProperties registers any mapped custom-field keys
// missing from the tenant_custom_fields registry as type 'string'.
// Only called when the operator opted in via auto_create_properties.
// A key that already exists (any type) is success; per-key failures
// don't abort the import — the data still lands in jsonb — but the
// first error is returned so callers can log it.
func ensureCustomProperties(ctx context.Context, pool *db.Pool, tenantID string, m migratecsv.Mapping) error {
	candidates := propertyCandidatesFromMapping(m)
	if len(candidates) == 0 || pool == nil {
		return nil
	}
	repo := &customfields.Repo{Pool: pool}
	existing, err := repo.List(ctx, tenantID)
	if err != nil {
		return err
	}
	have := map[string]struct{}{}
	for _, f := range existing {
		have[f.Key] = struct{}{}
	}
	var firstErr error
	for _, c := range candidates {
		if _, ok := have[c.Key]; ok {
			continue
		}
		if _, err := repo.Create(ctx, tenantID, c.Key, c.Label, customfields.TypeString); err != nil {
			if errors.Is(err, customfields.ErrKeyConflict) {
				continue // raced another creator — fine
			}
			if firstErr == nil {
				firstErr = fmt.Errorf("auto-create property %q: %w", c.Key, err)
			}
		}
	}
	return firstErr
}
