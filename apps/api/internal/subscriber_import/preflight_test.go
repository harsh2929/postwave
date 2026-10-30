// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	migratecsv "github.com/postwave/migrate/csv"
)

func TestScanImportIdentitiesIsExhaustiveBeyondLegacyTenThousandCap(t *testing.T) {
	const rows = 10_517
	var body bytes.Buffer
	body.WriteString("email,name\n")
	for i := 0; i < rows; i++ {
		fmt.Fprintf(&body, "person-%05d@example.test,Person %d\n", i, i)
	}
	// Deterministic duplicate precedence: the later spelling is counted as a
	// file duplicate and never replaces the first unique identity.
	body.WriteString("PERSON-10000@EXAMPLE.TEST,Duplicate\n")
	mapping := migratecsv.Mapping{
		Headers: []string{"email", "name"},
		Columns: []migratecsv.ColumnMapping{
			{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
			{Index: 1, Name: "name", Kind: migratecsv.KindName},
		},
	}
	scan, err := scanImportIdentities(body.Bytes(), mapping)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if scan.RowsTotal != rows+1 || len(scan.Emails) != rows || scan.FileDupes != 1 {
		t.Fatalf("exhaustive counts = total %d unique %d dupes %d", scan.RowsTotal, len(scan.Emails), scan.FileDupes)
	}
	if scan.Emails[10_000] != "person-10000@example.test" {
		t.Fatalf("first duplicate precedence drifted: %q", scan.Emails[10_000])
	}
	if len(scan.Sample) != 10 {
		t.Fatalf("sample size = %d, want 10 while counts remain exhaustive", len(scan.Sample))
	}
}

func TestScanImportIdentitiesRejectsRawEmailControlsBeforeNormalization(t *testing.T) {
	mapping := migratecsv.Mapping{
		Headers: []string{"email"},
		Columns: []migratecsv.ColumnMapping{
			{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		},
	}
	for _, tc := range []struct {
		name, control string
	}{
		{"nul", "\x00"}, {"tab", "\t"}, {"newline", "\n"},
		{"vertical-tab", "\v"}, {"form-feed", "\f"}, {"carriage-return", "\r"},
		{"unicode-next-line", "\u0085"}, {"unicode-control", "\u009f"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte("email\n\"person@example.com" + tc.control + "\"\n")
			if _, err := scanImportIdentities(body, mapping); err == nil ||
				!strings.Contains(err.Error(), "email contains control characters") {
				t.Fatalf("scan control %q error = %v, want explicit rejection", tc.control, err)
			}
		})
	}
}

func TestImportResourceBudgetsExactBoundaryAndCapPlusOne(t *testing.T) {
	for name, test := range map[string]struct {
		rows     int64
		cells    int64
		rowWidth int
		wantErr  bool
	}{
		"rows exact":    {rows: MaxImportRows, cells: MaxImportRows, rowWidth: 1},
		"rows cap+1":    {rows: MaxImportRows + 1, cells: MaxImportRows + 1, rowWidth: 1, wantErr: true},
		"cells exact":   {rows: 1, cells: MaxImportDecodedCells, rowWidth: 1},
		"cells cap+1":   {rows: 1, cells: MaxImportDecodedCells + 1, rowWidth: 1, wantErr: true},
		"columns exact": {rows: 1, cells: MaxImportColumns, rowWidth: MaxImportColumns},
		"columns cap+1": {rows: 1, cells: MaxImportColumns + 1, rowWidth: MaxImportColumns + 1, wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			err := validateImportResourceBudget(test.rows, test.cells, test.rowWidth)
			if (err != nil) != test.wantErr {
				t.Fatalf("error=%v wantErr=%v", err, test.wantErr)
			}
		})
	}

	cellExact := []string{strings.Repeat("x", MaxImportCellBytes)}
	if err := validateDecodedImportRecord(cellExact, false); err != nil {
		t.Fatalf("exact cell byte cap rejected: %v", err)
	}
	if err := validateDecodedImportRecord([]string{strings.Repeat("x", MaxImportCellBytes+1)}, false); err == nil {
		t.Fatal("cell byte cap+1 accepted")
	}
	rowExact := make([]string, MaxImportRowDecodedBytes/MaxImportCellBytes)
	for i := range rowExact {
		rowExact[i] = strings.Repeat("x", MaxImportCellBytes)
	}
	if err := validateDecodedImportRecord(rowExact, false); err != nil {
		t.Fatalf("exact decoded row byte cap rejected: %v", err)
	}
	rowOver := append(append([]string(nil), rowExact...), "x")
	if err := validateDecodedImportRecord(rowOver, false); err == nil {
		t.Fatal("decoded row byte cap+1 accepted")
	}
}

func TestRawCSVEnvelopeRejectsDecoderAmplification(t *testing.T) {
	exactColumns := strings.Repeat("x,", MaxImportColumns-1) + "x\n"
	if err := validateRawCSVEnvelope([]byte(exactColumns)); err != nil {
		t.Fatalf("exact raw column cap rejected: %v", err)
	}
	tooManyColumns := strings.Repeat("x,", MaxImportColumns) + "x\n"
	if err := validateRawCSVEnvelope([]byte(tooManyColumns)); err == nil {
		t.Fatal("raw column cap+1 reached encoding/csv")
	}
	quoted := "email,note\na@example.test,\"" + strings.Repeat(",", MaxImportColumns+1) + "\ncontinued\"\n"
	if err := validateRawCSVEnvelope([]byte(quoted)); err != nil {
		t.Fatalf("quoted commas/newline were misclassified as columns/records: %v", err)
	}
	overRecord := append([]byte("email\n\""), bytes.Repeat([]byte{'x'}, MaxImportRawRecordBytes)...)
	if err := validateRawCSVEnvelope(overRecord); err == nil {
		t.Fatal("oversized raw record reached encoding/csv")
	}

	var exactRows bytes.Buffer
	exactRows.Grow(int(MaxImportRows*2) + 8)
	exactRows.WriteString("h\n")
	for i := int64(0); i < MaxImportRows; i++ {
		exactRows.WriteString("x\n")
	}
	if err := validateRawCSVEnvelope(exactRows.Bytes()); err != nil {
		t.Fatalf("exact raw row cap rejected: %v", err)
	}
	exactRows.WriteString("x\n")
	if err := validateRawCSVEnvelope(exactRows.Bytes()); err == nil {
		t.Fatal("raw row cap+1 reached encoding/csv")
	}

	const cellsPerRow = int64(12)
	if MaxImportDecodedCells%cellsPerRow != 0 {
		t.Fatal("test requires an integral exact cell boundary")
	}
	cellRows := MaxImportDecodedCells / cellsPerRow
	row12 := strings.Repeat(",", int(cellsPerRow-1)) + "\n"
	var exactCells bytes.Buffer
	exactCells.Grow(int(cellRows)*len(row12) + 8)
	exactCells.WriteString("h\n")
	for i := int64(0); i < cellRows; i++ {
		exactCells.WriteString(row12)
	}
	if err := validateRawCSVEnvelope(exactCells.Bytes()); err != nil {
		t.Fatalf("exact raw cell cap rejected: %v", err)
	}
	cellOver := append([]byte("h\n"+strings.Repeat(",", int(cellsPerRow))+"\n"), exactCells.Bytes()[2+len(row12):]...)
	if err := validateRawCSVEnvelope(cellOver); err == nil {
		t.Fatal("raw decoded-cell cap+1 reached encoding/csv")
	}
}

func TestSubscriberStateFingerprintAdvancesIncrementallyToFullSnapshot(t *testing.T) {
	emails := []string{"a@example.test", "b@example.test", "c@example.test"}
	positions := map[string]int{emails[0]: 0, emails[1]: 1, emails[2]: 2}
	before := map[string]existingSubscriberState{
		emails[0]: {Status: "enabled", Sendable: true, Tags: []string{"old"}, ContentFingerprint: sha256LengthPrefixed("content", `{"plan": "free"}`, "A", "A")},
		emails[2]: {Status: "disabled", Sendable: false, Tags: []string{"hold"}, ContentFingerprint: sha256LengthPrefixed("content", `{}`, "C", "C")},
	}
	after := map[string]existingSubscriberState{
		emails[0]: {Status: "enabled", Sendable: true, Tags: []string{"old", "new"}, ContentFingerprint: sha256LengthPrefixed("content", `{"plan": "pro"}`, "A One", "A One")},
		emails[1]: {Status: "enabled", Sendable: true, Tags: []string{"new"}, ContentFingerprint: sha256LengthPrefixed("content", `{}`, "B", "B")},
		emails[2]: before[emails[2]],
	}
	advanced, err := advanceSubscriberStateFingerprint(
		subscriberStateFingerprint(emails, before), positions, emails[:2], before, after,
	)
	if err != nil {
		t.Fatal(err)
	}
	if full := subscriberStateFingerprint(emails, after); advanced != full {
		t.Fatalf("incremental watermark=%s full=%s", advanced, full)
	}
	if _, err := advanceSubscriberStateFingerprint(advanced, positions, []string{emails[0], emails[0]}, after, after); err == nil {
		t.Fatal("duplicate incremental identity was accepted")
	}
	mutated := after[emails[0]]
	mutated.ContentFingerprint = sha256LengthPrefixed("content", `{"plan": "enterprise"}`, "A One", "A One")
	if sameExistingSubscriberState(after[emails[0]], true, mutated, true) {
		t.Fatal("external custom-field mutation was not detected")
	}
}

func TestScanImportSamplesAreBoundedAndMarked(t *testing.T) {
	large := strings.Repeat("é", MaxImportSampleValueBytes)
	body := []byte("email,note\na@example.test," + large + "\n")
	mapping := migratecsv.Mapping{
		Headers: []string{"email", "note"},
		Columns: []migratecsv.ColumnMapping{
			{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
			{Index: 1, Name: "note", Kind: migratecsv.KindIgnore},
		},
	}
	scan, err := scanImportIdentities(body, mapping)
	if err != nil {
		t.Fatal(err)
	}
	if !scan.SampleValuesTruncated {
		t.Fatal("truncated sample was not marked")
	}
	if got := len(scan.Sample[0]["note"]); got > MaxImportSampleValueBytes {
		t.Fatalf("sample value bytes=%d exceeds cap=%d", got, MaxImportSampleValueBytes)
	}
	raw, err := json.Marshal(scan.Sample)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > MaxImportSampleBytes+1024 {
		t.Fatalf("sample JSON bytes=%d is not bounded near %d", len(raw), MaxImportSampleBytes)
	}
}

func TestScanImportIdentitiesMemoryBoundTracksUploadCeiling(t *testing.T) {
	// The handler's MaxBytesReader is the hard byte bound; the exhaustive scan
	// keeps one normalized identity per row and never builds an SQL parameter
	// list. Exercise enough rows to exceed every old sample/cap path while
	// keeping the unit suite fast. The DB path COPY-streams this slice.
	if MaxUploadBytes != 50<<20 {
		t.Fatalf("upload ceiling drifted: %d", MaxUploadBytes)
	}
	const rows = 100_000
	var body bytes.Buffer
	body.Grow(rows * 30)
	body.WriteString("email\n")
	for i := 0; i < rows; i++ {
		fmt.Fprintf(&body, "p%06d@example.test\n", i)
	}
	mapping := migratecsv.Mapping{Headers: []string{"email"}, Columns: []migratecsv.ColumnMapping{{Index: 0, Name: "email", Kind: migratecsv.KindEmail}}}
	scan, err := scanImportIdentities(body.Bytes(), mapping)
	if err != nil {
		t.Fatal(err)
	}
	if scan.RowsTotal != rows || len(scan.Emails) != rows {
		t.Fatalf("large scan truncated: total=%d unique=%d", scan.RowsTotal, len(scan.Emails))
	}
}

func TestPreflightFingerprintBindsEveryExecutionInput(t *testing.T) {
	captured := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	opts := importOptions{
		ConsentSource: "signed_form", ConsentSourceURL: "https://example.test/form",
		ConsentCapturedAt: &captured, ConsentLegalBasis: "consent", ConsentJurisdiction: "GB",
		ConsentReason: "Signed form covered marketing email.", ConsentPolicyVersion: "privacy-v1",
		ConsentEvidenceReference: "receipt:CONSENT-1", ConsentScope: ImportConsentScope,
		ConsentScopeAcknowledged: true, ConsentContractVersion: ImportConsentContractVersion,
		Tags: []string{"reviewed"}, AutoCreateProps: true,
	}
	mapping := migratecsv.Mapping{Headers: []string{"email"}, Columns: []migratecsv.ColumnMapping{{Index: 0, Name: "email", Kind: migratecsv.KindEmail}}}
	base := computePreflightFingerprint(strings.Repeat("a", 64), mapping, "skip", opts)
	if len(base) != 64 {
		t.Fatalf("fingerprint = %q", base)
	}
	changed := opts
	changed.ConsentPolicyVersion = "privacy-v2"
	for name, got := range map[string]string{
		"source":   computePreflightFingerprint(strings.Repeat("b", 64), mapping, "skip", opts),
		"strategy": computePreflightFingerprint(strings.Repeat("a", 64), mapping, "update", opts),
		"consent":  computePreflightFingerprint(strings.Repeat("a", 64), mapping, "skip", changed),
	} {
		if got == base {
			t.Fatalf("%s mutation did not invalidate preflight", name)
		}
	}
}

func TestImportConsentContractRejectsPartialFutureAndSecrets(t *testing.T) {
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	partial := importOptions{ConsentSource: "signed_form"}
	if err := partial.validateForConfirm(now); err == nil {
		t.Fatal("partial evidence must fail confirm")
	}
	complete := importOptions{
		ConsentSource: "signed_form", ConsentSourceURL: "https://example.test/form",
		ConsentCapturedAt: func() *time.Time { value := now.Add(-time.Hour); return &value }(),
		ConsentLegalBasis: "consent", ConsentJurisdiction: "GB",
		ConsentReason: "Signed form covered marketing email.", ConsentPolicyVersion: "privacy-v1",
		ConsentEvidenceReference: "receipt:CONSENT-1", ConsentScope: ImportConsentScope,
		ConsentScopeAcknowledged: true, ConsentContractVersion: ImportConsentContractVersion,
	}
	if err := complete.validateForConfirm(now); err != nil {
		t.Fatalf("complete contract: %v", err)
	}
	future := complete
	futureTime := now.Add(time.Nanosecond)
	future.ConsentCapturedAt = &futureTime
	if err := future.validateForConfirm(now); err == nil {
		t.Fatal("future capture must fail")
	}
	secret := complete
	secret.ConsentSourceURL = "https://example.test/form?access_token=secret"
	if err := secret.validateForConfirm(now); err == nil {
		t.Fatal("secret-bearing evidence URL must fail")
	}
}

func TestSourceFingerprintTenantSeparationRotationAndVersionValidation(t *testing.T) {
	keyA := strings.Repeat("a", 32)
	keyB := strings.Repeat("b", 32)
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY_VERSION", "v2")
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY", keyB)
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEYS", `{"v1":"`+keyA+`"}`)
	body := []byte("email\none@example.test\n")
	a, err := sourceFileFingerprint("tenant-a", body)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := sourceFileFingerprint("tenant-b", body)
	changed, _ := sourceFileFingerprint("tenant-a", append(append([]byte(nil), body...), 'x'))
	if a == b || a == changed {
		t.Fatalf("source HMAC was not tenant/body separated: %q %q %q", a, b, changed)
	}
	if a == sourceSHA256(body) {
		t.Fatal("persisted source fingerprint regressed to enumerable raw SHA-256")
	}
	old, err := sourceFileFingerprintWithVersion("tenant-a", body, "v1")
	if err != nil || old == "" || old == a {
		t.Fatalf("rotated key verification failed: fp=%q err=%v", old, err)
	}
	for _, invalid := range []string{"", "bad version", "/v1", strings.Repeat("x", 65)} {
		if _, err := sourceFileFingerprintWithVersion("tenant-a", body, invalid); err == nil {
			t.Fatalf("unsafe key version %q accepted", invalid)
		}
	}
}

func TestClassificationAuthorityRequiresCompleteFreshPreview(t *testing.T) {
	now := time.Now().UTC()
	expires := now.Add(time.Minute)
	rows := int64(0)
	hash := strings.Repeat("a", 64)
	if !importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1",
		hash, hash, hash, hash, &rows, 0, &expires, now) {
		t.Fatal("complete fresh preview should be authoritative")
	}
	for name, authoritative := range map[string]bool{
		"queued":          importClassificationAuthoritative("queued", hash, sourceFingerprintScheme, "v1", hash, hash, hash, hash, &rows, 0, &expires, now),
		"missing source":  importClassificationAuthoritative("preview", "", sourceFingerprintScheme, "v1", hash, hash, hash, hash, &rows, 0, &expires, now),
		"bad scheme":      importClassificationAuthoritative("preview", hash, "sha256", "v1", hash, hash, hash, hash, &rows, 0, &expires, now),
		"bad key version": importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "bad version", hash, hash, hash, hash, &rows, 0, &expires, now),
		"binding drift":   importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, strings.Repeat("b", 64), hash, hash, &rows, 0, &expires, now),
		"missing state":   importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, hash, "", hash, &rows, 0, &expires, now),
		"missing catalog": importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, hash, hash, "", &rows, 0, &expires, now),
		"missing rows":    importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, hash, hash, hash, nil, 0, &expires, now),
		"row drift":       importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, hash, hash, hash, &rows, 1, &expires, now),
		"expired":         importClassificationAuthoritative("preview", hash, sourceFingerprintScheme, "v1", hash, hash, hash, hash, &rows, 0, &now, now),
	} {
		if authoritative {
			t.Fatalf("partial authority state %q was accepted", name)
		}
	}
}
