// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"

	migratecsv "github.com/postwave/migrate/csv"
)

const sourceFingerprintScheme = "hmac-sha256-v1"

var sourceFingerprintKeyVersionRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func sourceFingerprintKeyVersion() string {
	return strings.TrimSpace(os.Getenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY_VERSION"))
}

func sourceFileFingerprint(tenantID string, body []byte) (string, error) {
	version := sourceFingerprintKeyVersion()
	return sourceFileFingerprintWithVersion(tenantID, body, version)
}

func sourceFileFingerprintWithVersion(tenantID string, body []byte, version string) (string, error) {
	if !sourceFingerprintKeyVersionRE.MatchString(version) {
		return "", errors.New("subscriber import fingerprint key/version is unavailable")
	}
	keys := map[string]string{}
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEYS")); raw != "" {
		if err := json.Unmarshal([]byte(raw), &keys); err != nil {
			return "", errors.New("subscriber import fingerprint keyring is invalid")
		}
	}
	if _, exists := keys[version]; !exists && version == sourceFingerprintKeyVersion() {
		keys[version] = os.Getenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY")
	}
	key := []byte(keys[version])
	if len(key) < 32 {
		return "", errors.New("subscriber import fingerprint key/version is unavailable")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("postwave/subscriber-import/source/v1\x00"))
	_, _ = mac.Write([]byte(tenantID))
	_, _ = mac.Write([]byte("\x00"))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

type importIdentityScan struct {
	RowsTotal             int64
	CellsTotal            int64
	FileDupes             int64
	Emails                []string
	Sample                []map[string]string
	SampleValuesTruncated bool
}

// scanImportIdentities walks the complete uploaded object. DetectMapping only
// samples 100 records for inference; it must never be reused as an exact row or
// collision count. A malformed record fails the preview instead of producing a
// deceptively authoritative classification.
func scanImportIdentities(body []byte, mapping migratecsv.Mapping) (importIdentityScan, error) {
	var out importIdentityScan
	if err := validateRawCSVEnvelope(body); err != nil {
		return out, err
	}
	emailCol := emailColumnIndex(mapping)
	if emailCol < 0 {
		return out, errorsNoEmailColumn
	}
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	header, err := cr.Read()
	if err != nil {
		return out, fmt.Errorf("read header: %w", err)
	}
	if err := validateSourceHeader(header, mapping); err != nil {
		return out, err
	}
	if err := validateDecodedImportRecord(header, true); err != nil {
		return out, err
	}
	seen := make(map[string]struct{})
	sampleBytes := 0
	for {
		row, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, fmt.Errorf("read row %d: %w", out.RowsTotal+1, err)
		}
		out.RowsTotal++
		out.CellsTotal += int64(len(row))
		if budgetErr := validateImportResourceBudget(out.RowsTotal, out.CellsTotal, len(row)); budgetErr != nil {
			return importIdentityScan{}, budgetErr
		}
		if recordErr := validateDecodedImportRecord(row, false); recordErr != nil {
			return importIdentityScan{}, fmt.Errorf("row %d: %w", out.RowsTotal, recordErr)
		}
		if emailCol < len(row) && emailidentity.ContainsControl(row[emailCol]) {
			return importIdentityScan{}, fmt.Errorf("row %d: email contains control characters", out.RowsTotal)
		}
		if len(out.Sample) < 10 {
			obj := make(map[string]string, len(mapping.Headers))
			for i, header := range mapping.Headers {
				if i < len(row) {
					value, truncated := truncateImportSampleValue(row[i], MaxImportSampleValueBytes)
					cost := len(header) + len(value)
					if sampleBytes+cost > MaxImportSampleBytes {
						out.SampleValuesTruncated = true
						continue
					}
					obj[header] = value
					sampleBytes += cost
					out.SampleValuesTruncated = out.SampleValuesTruncated || truncated
				}
			}
			out.Sample = append(out.Sample, obj)
		}
		email := extractEmail(row, emailCol)
		if email == "" {
			continue
		}
		if _, duplicate := seen[email]; duplicate {
			out.FileDupes++
			continue
		}
		seen[email] = struct{}{}
		out.Emails = append(out.Emails, email)
	}
	return out, nil
}

// validateRawCSVEnvelope performs a zero-allocation structural pass before
// encoding/csv creates []string and field-index slices. It follows the same
// quote/escaped-quote/CRLF rules (including LazyQuotes) closely enough to
// reject only records that cannot fit the decoded production budgets. Exact
// validation still happens after decoding in scanImportIdentities.
func validateRawCSVEnvelope(body []byte) error {
	fields := 1
	var rawRecordBytes int
	var logicalRecords, dataRows, dataCells int64
	inQuotes := false
	fieldStart := true
	recordMeaningful := false

	finishRecord := func() error {
		// encoding/csv ignores empty physical lines. Treat a CRLF-only line as
		// empty too; any allocation-relevant row still has meaningful content.
		if recordMeaningful {
			logicalRecords++
			if logicalRecords > 1 {
				dataRows++
				dataCells += int64(fields)
				if err := validateImportResourceBudget(dataRows, dataCells, fields); err != nil {
					return err
				}
			}
		}
		fields = 1
		rawRecordBytes = 0
		fieldStart = true
		recordMeaningful = false
		return nil
	}

	for i := 0; i < len(body); i++ {
		b := body[i]
		rawRecordBytes++
		if rawRecordBytes > MaxImportRawRecordBytes {
			return fmt.Errorf("CSV record exceeds the %d-byte encoded safety limit", MaxImportRawRecordBytes)
		}
		if inQuotes {
			recordMeaningful = true
			if b != '"' {
				continue
			}
			if i+1 < len(body) && body[i+1] == '"' {
				// RFC 4180 escaped quote. Consume the pair without letting the
				// second quote look like a close delimiter.
				i++
				rawRecordBytes++
				if rawRecordBytes > MaxImportRawRecordBytes {
					return fmt.Errorf("CSV record exceeds the %d-byte encoded safety limit", MaxImportRawRecordBytes)
				}
				continue
			}
			// With LazyQuotes, a quote followed by ordinary text is literal.
			// It closes the field only at comma/newline/CRLF/EOF.
			if i+1 == len(body) || body[i+1] == ',' || body[i+1] == '\n' ||
				(body[i+1] == '\r' && i+2 < len(body) && body[i+2] == '\n') {
				inQuotes = false
			}
			continue
		}

		if fieldStart && b == '"' {
			inQuotes = true
			fieldStart = false
			recordMeaningful = true
			continue
		}
		switch b {
		case ',':
			fields++
			if fields > MaxImportColumns {
				return fmt.Errorf("CSV record exceeds the %d-column import limit", MaxImportColumns)
			}
			fieldStart = true
			recordMeaningful = true
		case '\n':
			if err := finishRecord(); err != nil {
				return err
			}
		case '\r':
			// A CR immediately before LF is transport syntax, not content.
			if i+1 >= len(body) || body[i+1] != '\n' {
				recordMeaningful = true
				fieldStart = false
			}
		default:
			recordMeaningful = true
			fieldStart = false
		}
	}
	if rawRecordBytes > 0 && recordMeaningful {
		return finishRecord()
	}
	return nil
}

func validateDecodedImportRecord(record []string, header bool) error {
	if len(record) > MaxImportColumns {
		return fmt.Errorf("CSV record exceeds the %d-column import limit", MaxImportColumns)
	}
	rowBytes := 0
	for _, cell := range record {
		if !utf8.ValidString(cell) {
			return errors.New("CSV contains invalid UTF-8")
		}
		cellLimit := MaxImportCellBytes
		if header {
			cellLimit = MaxImportHeaderBytes
			if utf8.RuneCountInString(cell) > MaxImportHeaderRunes {
				return fmt.Errorf("CSV header exceeds the %d-character limit", MaxImportHeaderRunes)
			}
		}
		if len(cell) > cellLimit {
			return fmt.Errorf("CSV cell exceeds the %d-byte decoded limit", cellLimit)
		}
		rowBytes += len(cell)
		if rowBytes > MaxImportRowDecodedBytes {
			return fmt.Errorf("CSV record exceeds the %d-byte decoded limit", MaxImportRowDecodedBytes)
		}
	}
	return nil
}

func truncateImportSampleValue(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}
	ellipsis := "…"
	if maxBytes <= len(ellipsis) {
		return value[:maxBytes], true
	}
	cut := maxBytes - len(ellipsis)
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	return value[:cut] + ellipsis, true
}

func validateImportResourceBudget(rows, cells int64, rowWidth int) error {
	if rows > MaxImportRows {
		return fmt.Errorf("CSV exceeds the %d-row import limit", MaxImportRows)
	}
	if rowWidth > MaxImportColumns {
		return fmt.Errorf("CSV row exceeds the %d-column import limit", MaxImportColumns)
	}
	if cells > MaxImportDecodedCells {
		return fmt.Errorf("CSV exceeds the %d-cell decoded import limit", MaxImportDecodedCells)
	}
	return nil
}

var errorsNoEmailColumn = fmt.Errorf("mapping has no email column")

func sourceSHA256(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

type preflightBinding struct {
	Version                     string             `json:"version"`
	SourceFingerprint           string             `json:"source_fingerprint"`
	SourceFingerprintScheme     string             `json:"source_fingerprint_scheme"`
	SourceFingerprintKeyVersion string             `json:"source_fingerprint_key_version"`
	Mapping                     migratecsv.Mapping `json:"mapping"`
	OnExisting                  string             `json:"on_existing"`
	Tags                        []string           `json:"tags"`
	AutoCreateProps             bool               `json:"auto_create_properties"`
	ConsentFingerprint          string             `json:"consent_fingerprint"`
	ScheduleType                string             `json:"schedule_type"`
	ScheduledAt                 string             `json:"scheduled_at"`
	StateFingerprint            string             `json:"state_fingerprint"`
	CatalogFingerprint          string             `json:"catalog_fingerprint"`
	VerificationMode            string             `json:"verification_mode"`
}

type confirmationState struct {
	ConfigurationRevision       int64
	Mapping                     migratecsv.Mapping
	OnExisting                  string
	Options                     importOptions
	PreflightFingerprint        string
	PreflightRowsTotal          *int64
	PreflightRowsFailed         int64
	PreflightRowsExisting       int64
	PreflightStateFingerprint   string
	PreflightCatalogFingerprint string
	PreflightVerificationMode   string
	PreflightAt                 *time.Time
	PreflightExpiresAt          *time.Time
	ObjectKey                   string
	// TargetListID is the list imported contacts join, or "" for no list. It is
	// re-resolved at the confirm boundary: the choice is only as good as the
	// list still existing.
	TargetListID string
}

// preflightStillBinds reports whether the reviewed preflight still describes
// exactly what a confirm is about to execute: the same file, the same predicted
// row count, the same subscriber state and the same custom-field catalog. A
// missing fingerprint never binds — an unreviewed import is not a matching one.
func (c confirmationState) preflightStillBinds(
	expectedFingerprint string,
	sourceRowsTotal int64,
	stateFingerprint, catalogFingerprint string,
) bool {
	return c.PreflightFingerprint != "" &&
		c.PreflightFingerprint == expectedFingerprint &&
		c.PreflightRowsTotal != nil && *c.PreflightRowsTotal == sourceRowsTotal &&
		c.PreflightStateFingerprint != "" &&
		c.PreflightStateFingerprint == stateFingerprint &&
		c.PreflightCatalogFingerprint != "" &&
		c.PreflightCatalogFingerprint == catalogFingerprint
}

func (d *Deps) loadConfirmationState(ctx context.Context, tenantID, importID string) (confirmationState, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return confirmationState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state, err := loadConfirmationStateTx(ctx, tx, tenantID, importID)
	if err != nil {
		return state, err
	}
	if err := tx.Commit(ctx); err != nil {
		return state, err
	}
	return state, nil
}

func loadConfirmationStateTx(ctx context.Context, tx pgx.Tx, tenantID, importID string) (confirmationState, error) {
	var state confirmationState
	var mappingRaw []byte
	err := tx.QueryRow(ctx, `
SELECT object_key, mapping, COALESCE(on_existing, 'skip'),
       COALESCE(consent_source, ''), COALESCE(consent_source_url, ''), consent_captured_at,
       COALESCE(consent_legal_basis, ''), COALESCE(consent_jurisdiction, ''),
       COALESCE(consent_reason, ''), COALESCE(consent_policy_version, ''),
       COALESCE(consent_evidence_reference, ''), COALESCE(consent_scope, ''),
       consent_scope_acknowledged, COALESCE(consent_contract_version, ''),
	   COALESCE(source_fingerprint, ''), COALESCE(source_fingerprint_scheme, ''),
	   COALESCE(source_fingerprint_key_version, ''), COALESCE(tags, '{}'::text[]), auto_create_properties,
	   COALESCE(schedule_type, 'immediate'), COALESCE(schedule_cron, ''), scheduled_at,
	   COALESCE(drip_hours_interval, 0), COALESCE(drip_hours_total, 0),
	   COALESCE(preflight_fingerprint, ''), preflight_rows_total,
	   COALESCE(preflight_rows_failed, 0), COALESCE(preflight_rows_existing, 0),
	   COALESCE(preflight_state_fingerprint, ''), COALESCE(preflight_catalog_fingerprint, ''),
	   COALESCE(preflight_verification_mode, 'off'),
	   preflight_at, preflight_expires_at,
	   COALESCE(configuration_revision, 0),
	   COALESCE(target_list_id::text, '')
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'`, tenantID, importID).Scan(
		&state.ObjectKey, &mappingRaw, &state.OnExisting,
		&state.Options.ConsentSource, &state.Options.ConsentSourceURL,
		&state.Options.ConsentCapturedAt, &state.Options.ConsentLegalBasis,
		&state.Options.ConsentJurisdiction, &state.Options.ConsentReason,
		&state.Options.ConsentPolicyVersion, &state.Options.ConsentEvidenceReference,
		&state.Options.ConsentScope, &state.Options.ConsentScopeAcknowledged,
		&state.Options.ConsentContractVersion, &state.Options.SourceFingerprint,
		&state.Options.SourceFingerprintScheme, &state.Options.SourceFingerprintKeyVersion,
		&state.Options.Tags, &state.Options.AutoCreateProps,
		&state.Options.ScheduleType, &state.Options.ScheduleCron, &state.Options.ScheduledAt,
		&state.Options.DripHoursInterval, &state.Options.DripHoursTotal,
		&state.PreflightFingerprint, &state.PreflightRowsTotal,
		&state.PreflightRowsFailed, &state.PreflightRowsExisting,
		&state.PreflightStateFingerprint, &state.PreflightCatalogFingerprint,
		&state.PreflightVerificationMode,
		&state.PreflightAt, &state.PreflightExpiresAt, &state.ConfigurationRevision,
		&state.TargetListID,
	)
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(mappingRaw, &state.Mapping); err != nil {
		return state, fmt.Errorf("decode subscriber import mapping: %w", err)
	}
	return state, nil
}

func computePreflightFingerprint(sourceHash string, mapping migratecsv.Mapping, onExisting string, opts importOptions, manifests ...string) string {
	stateFingerprint, catalogFingerprint := "", ""
	verificationMode := ImportVerificationModeOff
	if len(manifests) > 0 {
		stateFingerprint = manifests[0]
	}
	if len(manifests) > 1 {
		catalogFingerprint = manifests[1]
	}
	if len(manifests) > 2 {
		if normalized, err := normalizeImportVerificationMode(manifests[2]); err == nil {
			verificationMode = normalized
		}
	}
	scheduledAt := ""
	if opts.ScheduledAt != nil {
		scheduledAt = opts.ScheduledAt.UTC().Format(time.RFC3339Nano)
	}
	payload, _ := json.Marshal(preflightBinding{
		Version:                     "subscriber-import-preflight/v2",
		SourceFingerprint:           sourceHash,
		SourceFingerprintScheme:     opts.SourceFingerprintScheme,
		SourceFingerprintKeyVersion: opts.SourceFingerprintKeyVersion,
		Mapping:                     mapping,
		OnExisting:                  onExisting,
		Tags:                        opts.Tags,
		AutoCreateProps:             opts.AutoCreateProps,
		ConsentFingerprint:          opts.consentFingerprint(),
		ScheduleType:                strings.ToLower(strings.TrimSpace(opts.ScheduleType)),
		ScheduledAt:                 scheduledAt,
		StateFingerprint:            stateFingerprint,
		CatalogFingerprint:          catalogFingerprint,
		VerificationMode:            verificationMode,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func prospectiveStringKeys(mapping migratecsv.Mapping, autoCreate bool) map[string]struct{} {
	out := map[string]struct{}{}
	if !autoCreate {
		return out
	}
	for _, candidate := range propertyCandidatesFromMapping(mapping) {
		out[candidate.Key] = struct{}{}
	}
	return out
}

// customFieldCatalogFingerprint binds the preflight to the custom-field
// schema its rows were judged against: every mapped key's declared type and
// constraints (or the text field the import will create), under the policy
// that decided how undeclared keys and values are treated.
func customFieldCatalogFingerprint(ctx context.Context, pool *db.Pool, tenantID string, mapping migratecsv.Mapping, policy customFieldImportPolicy) (string, error) {
	autoCreate := policy.AutoCreate
	type fieldBinding struct {
		Key            string                    `json:"key"`
		Exists         bool                      `json:"exists"`
		Type           customfields.FieldType    `json:"type"`
		Config         *customfields.FieldConfig `json:"config,omitempty"`
		ValidationRule string                    `json:"validation_rule,omitempty"`
	}
	relevant := make(map[string]struct{})
	for _, column := range mapping.Columns {
		if column.Kind == migratecsv.KindCustom {
			if key := canonicalCustomKey(column); key != "" {
				relevant[key] = struct{}{}
			}
		}
	}
	if len(relevant) == 0 {
		raw, _ := json.Marshal([]fieldBinding{})
		return sourceSHA256(raw), nil
	}
	fields, err := (&customfields.Repo{Pool: pool}).List(ctx, tenantID)
	if err != nil {
		return "", err
	}
	byKey := make(map[string]fieldBinding, len(relevant))
	for _, field := range fields {
		if _, wanted := relevant[field.Key]; wanted {
			byKey[field.Key] = fieldBinding{field.Key, true, field.Type, field.Config, field.ValidationRule}
		}
	}
	for key := range relevant {
		if _, exists := byKey[key]; !exists {
			binding := fieldBinding{Key: key}
			if autoCreate {
				// Bind the projected schema so creation between confirm and recovery
				// does not self-invalidate the import.
				binding.Exists = true
				binding.Type = customfields.TypeString
			}
			byKey[key] = binding
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ordered := make([]fieldBinding, 0, len(keys))
	for _, key := range keys {
		ordered = append(ordered, byKey[key])
	}
	raw, _ := json.Marshal(ordered)
	return sourceSHA256(bindCustomFieldPolicy(raw, policy)), nil
}

func sourceRowFingerprint(importID, sourceHash string, rowNumber int64) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		"subscriber-import-row/v1", importID, sourceHash,
		strconv.FormatInt(rowNumber, 10),
	}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func importEvidenceFingerprint(consentFingerprint, rowFingerprint string) string {
	return sha256LengthPrefixed("subscriber-import-evidence/v1", consentFingerprint, rowFingerprint)
}

func sha256LengthPrefixed(parts ...string) string {
	h := sha256.New()
	var length [4]byte
	for _, part := range parts {
		binary.BigEndian.PutUint32(length[:], uint32(len(part)))
		_, _ = h.Write(length[:])
		_, _ = h.Write([]byte(part))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func subscriberStateFingerprint(emails []string, states map[string]existingSubscriberState) string {
	base, _ := hex.DecodeString(sha256LengthPrefixed("subscriber-import-state/v2"))
	for index, email := range emails {
		state, exists := states[email]
		token, _ := hex.DecodeString(subscriberStateToken(index, state, exists))
		for i := range base {
			base[i] ^= token[i]
		}
	}
	return hex.EncodeToString(base)
}

func subscriberStateToken(index int, state existingSubscriberState, exists bool) string {
	parts := []string{"subscriber-import-state-row/v2", strconv.Itoa(index)}
	if !exists {
		return sha256LengthPrefixed(append(parts, "absent")...)
	}
	parts = append(parts, "existing", state.Status, strconv.FormatBool(state.Sendable),
		state.ContentFingerprint)
	parts = append(parts, state.Tags...)
	return sha256LengthPrefixed(parts...)
}

func advanceSubscriberStateFingerprint(current string, positions map[string]int, emails []string, before, after map[string]existingSubscriberState) (string, error) {
	value, err := hex.DecodeString(current)
	if err != nil || len(value) != sha256.Size {
		return "", errors.New("execution state fingerprint is invalid")
	}
	seen := make(map[string]struct{}, len(emails))
	for _, email := range emails {
		if _, duplicate := seen[email]; duplicate {
			return "", errors.New("execution state email was repeated")
		}
		seen[email] = struct{}{}
		position, ok := positions[email]
		if !ok {
			return "", errors.New("execution state email is absent from the frozen source")
		}
		beforeState, beforeExists := before[email]
		afterState, afterExists := after[email]
		for _, tokenHex := range []string{
			subscriberStateToken(position, beforeState, beforeExists),
			subscriberStateToken(position, afterState, afterExists),
		} {
			token, _ := hex.DecodeString(tokenHex)
			for i := range value {
				value[i] ^= token[i]
			}
		}
	}
	return hex.EncodeToString(value), nil
}

func sameExistingSubscriberState(left existingSubscriberState, leftExists bool, right existingSubscriberState, rightExists bool) bool {
	if leftExists != rightExists {
		return false
	}
	if !leftExists {
		return true
	}
	if left.Status != right.Status || left.Sendable != right.Sendable ||
		left.ContentFingerprint != right.ContentFingerprint || len(left.Tags) != len(right.Tags) {
		return false
	}
	for i := range left.Tags {
		if left.Tags[i] != right.Tags[i] {
			return false
		}
	}
	return true
}

// countDedupeExhaustive stages every unique file identity and joins under the
// tenant's RLS. No sampling cap is allowed: these counts are shown as exact
// and become part of the confirmation preflight.
func (d *Deps) countDedupeExhaustive(ctx context.Context, tenantID string, emails []string) (int64, int64, error) {
	if len(emails) == 0 {
		return 0, 0, nil
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
CREATE TEMP TABLE subscriber_import_preflight_emails (
    email citext PRIMARY KEY
) ON COMMIT DROP`); err != nil {
		return 0, 0, err
	}
	if _, err := tx.CopyFrom(ctx,
		pgx.Identifier{"subscriber_import_preflight_emails"},
		[]string{"email"}, pgx.CopyFromSlice(len(emails), func(i int) ([]any, error) {
			return []any{emails[i]}, nil
		})); err != nil {
		return 0, 0, err
	}
	var existing, fresh int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE s.id IS NOT NULL)::bigint,
       count(*) FILTER (WHERE s.id IS NULL)::bigint
  FROM subscriber_import_preflight_emails p
  LEFT JOIN subscribers s
    ON s.tenant_id = $1::uuid AND s.email = p.email`, tenantID).
		Scan(&existing, &fresh); err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return existing, fresh, nil
}
