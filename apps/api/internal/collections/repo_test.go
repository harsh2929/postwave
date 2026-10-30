// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsValidCollectionType(t *testing.T) {
	for _, v := range []string{"coupons", "content", "schedule"} {
		if !isValidCollectionType(v) {
			t.Errorf("%q should be valid", v)
		}
	}
	for _, v := range []string{"", "COUPONS", "coupon", "calendar"} {
		if isValidCollectionType(v) {
			t.Errorf("%q should be invalid", v)
		}
	}
}

func TestIsValidSourceType(t *testing.T) {
	for _, v := range []string{"uploaded", "api", "manual"} {
		if !isValidSourceType(v) {
			t.Errorf("%q should be valid", v)
		}
	}
	for _, v := range []string{"", "UPLOADED", "import", "csv"} {
		if isValidSourceType(v) {
			t.Errorf("%q should be invalid", v)
		}
	}
}

func TestMarshalData(t *testing.T) {
	got, err := marshalData(nil)
	if err != nil || got != "[]" {
		t.Fatalf("nil data = %q err=%v, want []", got, err)
	}
	got, err = marshalData([]RowValue{{"code": "SAVE10"}})
	if err != nil {
		t.Fatalf("marshal err: %v", err)
	}
	if got != `[{"code":"SAVE10"}]` {
		t.Fatalf("data = %q", got)
	}
}

func TestValidateRows_CapsAtMax(t *testing.T) {
	rows := make([]RowValue, MaxRows)
	for index := range rows {
		rows[index] = RowValue{}
	}
	if err := validateRows(rows); err != nil {
		t.Fatalf("exactly MaxRows should pass: %v", err)
	}
	if err := validateRows(make([]RowValue, MaxRows+1)); err == nil {
		t.Fatal("over MaxRows should be rejected")
	}
}

func TestValidateRowsRejectsUnsafeOrPathologicalShapes(t *testing.T) {
	tooManyColumns := RowValue{}
	for index := 0; index <= MaxColumnsPerRow; index++ {
		tooManyColumns[string(rune('a'+index%26))+strings.Repeat("x", index/26)] = index
	}
	deep := any("leaf")
	for index := 0; index <= MaxNestedDepth; index++ {
		deep = []any{deep}
	}
	tooManyMembers := make([]any, MaxNestedMembers+1)
	largeData := make([]RowValue, 20)
	for index := range largeData {
		largeData[index] = RowValue{"value": strings.Repeat("x", 60<<10)}
	}

	tests := []struct {
		name string
		rows []RowValue
		want string
	}{
		{name: "null row", rows: []RowValue{nil}, want: "must be an object"},
		{name: "too many columns", rows: []RowValue{tooManyColumns}, want: "at most 100 fields"},
		{name: "blank key", rows: []RowValue{{" \t": true}}, want: "whitespace-only"},
		{name: "control key", rows: []RowValue{{"line\nbreak": true}}, want: "control or bidirectional"},
		{name: "bidi key", rows: []RowValue{{"safe\u202eevil": true}}, want: "control or bidirectional"},
		{name: "prototype key", rows: []RowValue{{"__proto__": true}}, want: "reserved"},
		{name: "nested prototype key", rows: []RowValue{{"safe": map[string]any{"constructor": true}}}, want: "reserved"},
		{name: "deep value", rows: []RowValue{{"deep": deep}}, want: "nested at most"},
		{name: "large array", rows: []RowValue{{"items": tooManyMembers}}, want: "at most 1000 items"},
		{name: "large string", rows: []RowValue{{"value": strings.Repeat("x", MaxStringValueBytes+1)}}, want: "UTF-8 bytes"},
		{name: "NUL cell", rows: []RowValue{{"value": "before\x00after"}}, want: "NUL"},
		{name: "nonfinite", rows: []RowValue{{"value": math.Inf(1)}}, want: "finite"},
		{name: "unrepresentable JSON number", rows: []RowValue{{"value": json.Number("1e10000")}}, want: "representable"},
		{name: "tiny JSON decimal", rows: []RowValue{{"value": json.Number("1e-301")}}, want: "absolute magnitude"},
		{name: "large JSON decimal", rows: []RowValue{{"value": json.Number("1.1e300")}}, want: "absolute magnitude"},
		{name: "unsafe JSON integer", rows: []RowValue{{"value": json.Number("9007199254740993")}}, want: "safe range"},
		{name: "unsafe exponent integer", rows: []RowValue{{"value": json.Number("9.007199254740992e15")}}, want: "safe range"},
		{name: "unsafe direct signed integer", rows: []RowValue{{"value": int64(-9007199254740992)}}, want: "safe range"},
		{name: "unsafe direct unsigned integer", rows: []RowValue{{"value": uint64(9007199254740992)}}, want: "safe range"},
		{name: "encoded data ceiling", rows: largeData, want: "collection data may encode"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRows(test.rows)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error=%v, want substring %q", err, test.want)
			}
		})
	}
}

func TestValidateRowsPreservesUnicodeLineSeparatorsInCellValues(t *testing.T) {
	rows := []RowValue{{"value": "line one\u2028line two\u2029line three"}}
	if err := validateRows(rows); err != nil {
		t.Fatalf("legitimate cell text rejected: %v", err)
	}
	encoded, err := marshalCollectionJSON(rows)
	if err != nil {
		t.Fatalf("encode rows: %v", err)
	}
	if !strings.Contains(string(encoded), `\u2028`) || !strings.Contains(string(encoded), `\u2029`) {
		t.Fatalf("Go JSON encoding must account for line-separator expansion: %s", encoded)
	}
}

func TestValidateRowsAcceptsInteroperableSafeIntegerBoundary(t *testing.T) {
	for _, value := range []any{
		json.Number("9007199254740991"),
		json.Number("-9007199254740991"),
		int64(MaxSafeJSONInteger),
		-MaxSafeJSONInteger,
		uint64(MaxSafeJSONInteger),
		json.Number("9007199254740991.5"),
	} {
		if err := validateRows([]RowValue{{"value": value}}); err != nil {
			t.Fatalf("safe integer %v (%T) rejected: %v", value, value, err)
		}
	}
}

func TestRepoCreateRejectsUnsafeIntegerBeforePersistence(t *testing.T) {
	_, err := (&Repo{}).Create(context.Background(), testCollectionTenantID, CreateInput{
		Name: "Unsafe identifier",
		Data: []RowValue{{"external_id": json.Number("9007199254740993")}},
	})
	if err == nil || !strings.Contains(err.Error(), "safe range") {
		t.Fatalf("Repo.Create error=%v, want safe-integer validation before pool access", err)
	}
}

func TestValidateNameRejectsSpoofingCharacters(t *testing.T) {
	for _, name := range []string{"line\nbreak", "safe\u202eevil", "safe\u2066evil", "safe\u200fevil", " leading", "trailing\u00a0"} {
		if err := validateName(name); err == nil {
			t.Fatalf("name %q should be rejected", name)
		}
	}
	if err := validateName("Campaign calendar"); err != nil {
		t.Fatalf("safe name rejected: %v", err)
	}
}

func TestRejectDuplicateJSONKeysAtAnyDepth(t *testing.T) {
	for _, raw := range []string{
		`{"name":"one","name":"two"}`,
		`{"data":[{"safe":{"code":"one","code":"two"}}]}`,
	} {
		if err := rejectDuplicateJSONKeys([]byte(raw)); !errors.Is(err, errDuplicateJSONKey) {
			t.Fatalf("duplicate input error=%v, want errDuplicateJSONKey", err)
		}
	}
	if err := rejectDuplicateJSONKeys([]byte(`{"data":[{"code":"one"}]}`)); err != nil {
		t.Fatalf("valid JSON rejected: %v", err)
	}
}

func TestRejectMalformedJSONSurrogatesInKeysAndValues(t *testing.T) {
	for _, raw := range []string{
		`{"data":[{"value":"\ud800"}]}`,
		`{"data":[{"value":{"\udfff":true}}]}`,
		`{"data":[{"value":{"nested":"\ud800x"}}]}`,
		`{"name":"\ud800\u0041"}`,
	} {
		if err := rejectDuplicateJSONKeys([]byte(raw)); !errors.Is(err, errInvalidJSONUnicode) {
			t.Fatalf("malformed surrogate input %s error=%v, want errInvalidJSONUnicode", raw, err)
		}
	}
	invalidValue := append([]byte(`{"data":[{"value":"`), 0xff)
	invalidValue = append(invalidValue, []byte(`"}]}`)...)
	invalidKey := append([]byte(`{"data":[{"nested":{"`), 0xff)
	invalidKey = append(invalidKey, []byte(`":true}}]}`)...)
	for _, raw := range [][]byte{invalidValue, invalidKey} {
		if err := rejectDuplicateJSONKeys(raw); !errors.Is(err, errInvalidJSONUnicode) {
			t.Fatalf("invalid UTF-8 JSON %q error=%v, want errInvalidJSONUnicode", raw, err)
		}
	}
	for _, raw := range []string{
		`{"data":[{"value":"\ud83d\ude80"}]}`,
		`{"data":[{"value":"literal \\ud800 text"}]}`,
	} {
		if err := rejectDuplicateJSONKeys([]byte(raw)); err != nil {
			t.Fatalf("valid surrogate/escaped text input %s rejected: %v", raw, err)
		}
	}
}

func TestDuplicateKeyWalkerRejectsPathologicalNesting(t *testing.T) {
	raw := strings.Repeat("[", maxRequestJSONNesting+2) + "0" + strings.Repeat("]", maxRequestJSONNesting+2)
	if err := rejectDuplicateJSONKeys([]byte(raw)); !errors.Is(err, errJSONNestingTooDeep) {
		t.Fatalf("nesting error=%v, want errJSONNestingTooDeep", err)
	}
}

func TestCollectionJSONEncodingMatchesPersistenceSizeContract(t *testing.T) {
	rows := []RowValue{{"html": "<strong>A&B</strong>"}}
	encoded, err := marshalCollectionJSON(rows)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), `\u003c`) || string(encoded) != `[{"html":"<strong>A&B</strong>"}]` {
		t.Fatalf("unexpected persistence encoding: %s", encoded)
	}
}

func TestCollectionWireShapeIncludesIdentityCountAndTimestamps(t *testing.T) {
	collection := Collection{
		ID: "11111111-1111-4111-8111-111111111111", TenantID: "22222222-2222-4222-8222-222222222222",
		Name: "Calendar", CollectionType: TypeSchedule, SourceType: SourceManual,
		Data: []RowValue{}, RowCount: 0,
		CreatedAt: time.Date(2026, 7, 22, 1, 2, 3, 0, time.UTC),
		UpdatedAt: time.Date(2026, 7, 22, 2, 3, 4, 0, time.UTC),
	}
	raw, err := marshalCollectionJSON(collection)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("decode wire: %v", err)
	}
	for _, key := range []string{"id", "tenant_id", "name", "collection_type", "source_type", "data", "row_count", "created_at", "updated_at"} {
		if _, present := wire[key]; !present {
			t.Fatalf("wire representation omitted required field %q: %s", key, raw)
		}
	}
}

func TestNormalizeCollectionIDDistinguishesMalformedFromAbsent(t *testing.T) {
	const canonical = "11111111-1111-4111-8111-111111111111"
	got, err := normalizeCollectionID(strings.ToUpper(canonical))
	if err != nil || got != canonical {
		t.Fatalf("normalized id=%q err=%v", got, err)
	}
	if _, err := normalizeCollectionID("not-a-uuid"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("malformed id error=%v, want ErrInvalidID", err)
	}
}

func TestEscapeLikeLiteralTreatsWildcardsAsText(t *testing.T) {
	if got, want := escapeLikeLiteral(`50%_off\today`), `50\%\_off\\today`; got != want {
		t.Fatalf("escapeLikeLiteral=%q, want %q", got, want)
	}
}

func TestIsNotFound(t *testing.T) {
	if !isNotFound(pgx.ErrNoRows) {
		t.Fatal("pgx.ErrNoRows should be not-found")
	}
	if isNotFound(errors.New("boom")) {
		t.Fatal("generic error should NOT be not-found")
	}
}

func TestMapWriteErrorOnlyMapsCollectionNameIdentity(t *testing.T) {
	conflict := &pgconn.PgError{Code: "23505", ConstraintName: "reference_collections_tenant_name_uidx"}
	if !errors.Is(mapWriteError(conflict), ErrNameConflict) {
		t.Fatal("collection name uniqueness should map to ErrNameConflict")
	}
	other := &pgconn.PgError{Code: "23505", ConstraintName: "some_other_unique_index"}
	if !errors.Is(mapWriteError(other), other) {
		t.Fatal("unrelated uniqueness error should remain unchanged")
	}
	dataConstraint := &pgconn.PgError{Code: "23514", ConstraintName: "reference_collections_data_shape_check"}
	if mapped := mapWriteError(dataConstraint); !isInputValidationError(mapped) || !strings.Contains(mapped.Error(), "compact encoded-size") {
		t.Fatalf("data constraint mapped to %T(%v), want stable input validation", mapped, mapped)
	}
}

func TestCoreInputNormalizationCannotBypassSemanticValidation(t *testing.T) {
	created, err := normalizeCreateInput(CreateInput{Name: "  Calendar  ", Data: []RowValue{}})
	if err != nil || created.Name != "Calendar" || created.CollectionType != "content" || created.SourceType != "manual" {
		t.Fatalf("normalized create=%+v err=%v", created, err)
	}
	if _, err := normalizeCreateInput(CreateInput{Name: "spoof\u202e", CollectionType: "content", SourceType: "manual"}); err == nil {
		t.Fatal("core create normalization accepted a bidi-spoofed name")
	}
	badType := "coupon_pool"
	if _, err := normalizeUpdateInput(UpdateInput{CollectionType: &badType}); err == nil {
		t.Fatal("core update normalization accepted an invalid type")
	}
}

type fakeRow struct{ vals []any }

const testCollectionID = "11111111-1111-4111-8111-111111111111"
const testCollectionTenantID = "22222222-2222-4222-8222-222222222222"

func (f fakeRow) Scan(dest ...any) error {
	for i := range dest {
		switch d := dest[i].(type) {
		case *string:
			*d = f.vals[i].(string)
		case *[]byte:
			*d = f.vals[i].([]byte)
		case *CollectionType:
			*d = CollectionType(f.vals[i].(string))
		case *SourceType:
			*d = SourceType(f.vals[i].(string))
		case *time.Time:
			*d = f.vals[i].(time.Time)
		case *int64:
			*d = f.vals[i].(int64)
		}
	}
	return nil
}

func TestScanCollection_DecodesData(t *testing.T) {
	createdAt := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	row := fakeRow{vals: []any{
		testCollectionID, testCollectionTenantID, "Coupons", "coupons", "uploaded",
		[]byte(`[{"code":"SAVE10"}]`),
		createdAt, createdAt.Add(time.Minute), int64(1),
	}}
	c, err := scanCollection(row)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if c.CollectionType != TypeCoupons || c.SourceType != SourceUploaded {
		t.Fatalf("types wrong: %+v", c)
	}
	if len(c.Data) != 1 || c.Data[0]["code"] != "SAVE10" {
		t.Fatalf("data = %v", c.Data)
	}
	if c.RowCount != 1 {
		t.Fatalf("row_count = %d, want 1", c.RowCount)
	}
}

func TestScanCollectionRejectsUnsafeStoredJSONInteger(t *testing.T) {
	createdAt := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	row := fakeRow{vals: []any{
		testCollectionID, testCollectionTenantID, "Numbers", "content", "api",
		[]byte(`[{"external_id":900719925474099312345}]`),
		createdAt, createdAt.Add(time.Minute), int64(1),
	}}
	if _, err := scanCollection(row); err == nil || !strings.Contains(err.Error(), "safe range") {
		t.Fatalf("scan error=%v, want stored unsafe-integer rejection", err)
	}
}

func TestScanCollectionRejectsNonCanonicalStoredName(t *testing.T) {
	createdAt := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	row := fakeRow{vals: []any{
		testCollectionID, testCollectionTenantID, " Leading space", "content", "api",
		[]byte(`[]`), createdAt, createdAt.Add(time.Minute), int64(1),
	}}
	if _, err := scanCollection(row); err == nil || !strings.Contains(err.Error(), "leading or trailing") {
		t.Fatalf("scan error=%v, want stored canonical-name rejection", err)
	}
}

func TestScanCollection_NullDataYieldsEmptySlice(t *testing.T) {
	createdAt := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	row := fakeRow{vals: []any{
		testCollectionID, testCollectionTenantID, "X", "content", "manual",
		[]byte(`null`),
		createdAt, createdAt.Add(time.Minute), int64(1),
	}}
	c, err := scanCollection(row)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if c.Data == nil || len(c.Data) != 0 {
		t.Fatalf("data should be empty non-nil slice, got %v", c.Data)
	}
	if c.RowCount != 0 {
		t.Fatalf("row_count = %d, want 0", c.RowCount)
	}
}

func TestValidateCollectionMetadataRejectsInvalidSummaryBounds(t *testing.T) {
	createdAt := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	base := Collection{
		ID: testCollectionID, TenantID: testCollectionTenantID, Name: "Summary",
		CollectionType: TypeContent, SourceType: SourceManual,
		RowCount: 1, CreatedAt: createdAt, UpdatedAt: createdAt.Add(time.Minute), Version: 1,
	}
	if err := validateCollectionMetadata(base); err != nil {
		t.Fatalf("valid metadata rejected: %v", err)
	}
	for name, mutate := range map[string]func(*Collection){
		"negative row count":   func(c *Collection) { c.RowCount = -1 },
		"oversized row count":  func(c *Collection) { c.RowCount = MaxRows + 1 },
		"missing created time": func(c *Collection) { c.CreatedAt = time.Time{} },
		"missing updated time": func(c *Collection) { c.UpdatedAt = time.Time{} },
		"reversed timestamps":  func(c *Collection) { c.UpdatedAt = c.CreatedAt.Add(-time.Second) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := base
			mutate(&candidate)
			if err := validateCollectionMetadata(candidate); err == nil {
				t.Fatalf("invalid metadata accepted: %+v", candidate)
			}
		})
	}
}
