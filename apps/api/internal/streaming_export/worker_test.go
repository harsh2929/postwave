package streaming_export

import (
	"bytes"
	"testing"
)

func TestEncodeBatchSelectsFormat(t *testing.T) {
	rows := sampleRows()

	pBody, pCT, pExt, err := encodeBatch(FormatParquet, rows)
	if err != nil {
		t.Fatalf("parquet: %v", err)
	}
	if pExt != "parquet" || pCT != ParquetContentType {
		t.Fatalf("parquet meta = %q/%q", pExt, pCT)
	}
	if !bytes.HasPrefix(pBody, []byte("PAR1")) {
		t.Fatalf("parquet body missing magic")
	}

	aBody, aCT, aExt, err := encodeBatch(FormatAvro, rows)
	if err != nil {
		t.Fatalf("avro: %v", err)
	}
	if aExt != "avro" || aCT != AvroContentType {
		t.Fatalf("avro meta = %q/%q", aExt, aCT)
	}
	if !bytes.HasPrefix(aBody, []byte{'O', 'b', 'j', 1}) {
		t.Fatalf("avro body missing magic")
	}

	// Unknown format defaults to parquet.
	_, ct, ext, err := encodeBatch("xml", rows)
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if ext != "parquet" || ct != ParquetContentType {
		t.Fatalf("default fmt = %q/%q", ext, ct)
	}
}

func TestParseConfigDefaultsAndOverrides(t *testing.T) {
	def := ParseConfig(nil)
	if def.Format != FormatParquet || def.Compression != CompressionSnappy {
		t.Fatalf("defaults = %#v", def)
	}
	if def.BatchSize != DefaultBatchSize {
		t.Fatalf("default batch = %d", def.BatchSize)
	}
	if def.Prefix != "streaming-export" {
		t.Fatalf("default prefix = %q", def.Prefix)
	}

	got := ParseConfig(map[string]any{
		"format":      "avro",
		"compression": "gzip",
		"batch_size":  float64(500),
		"prefix":      "/feeds/events/",
	})
	if got.Format != FormatAvro || got.Compression != CompressionGzip {
		t.Fatalf("override = %#v", got)
	}
	if got.BatchSize != 500 || got.Prefix != "feeds/events" {
		t.Fatalf("override fields = %#v", got)
	}
}

func TestParseConfigClampsAndFallsBack(t *testing.T) {
	// Bad format + compression + tiny batch fall back to defaults.
	got := ParseConfig(map[string]any{
		"format":      "csv",
		"compression": "lz4",
		"batch_size":  float64(5),
	})
	if got.Format != FormatParquet {
		t.Fatalf("bad format not defaulted: %q", got.Format)
	}
	if got.Compression != CompressionSnappy {
		t.Fatalf("bad compression not defaulted: %q", got.Compression)
	}
	if got.BatchSize != DefaultBatchSize {
		t.Fatalf("tiny batch not defaulted: %d", got.BatchSize)
	}

	// Oversized batch clamps to max.
	big := ParseConfig(map[string]any{"batch_size": float64(MaxBatchSize + 10)})
	if big.BatchSize != MaxBatchSize {
		t.Fatalf("oversized batch = %d want %d", big.BatchSize, MaxBatchSize)
	}
}

func TestParseConfigEventTypeFilters(t *testing.T) {
	// JSON-array shape (the UI's config.field_filters after jsonb decode).
	got := ParseConfig(map[string]any{
		"field_filters": []any{"opened", "clicked", "opened", "  ", "bounced"},
	})
	want := []string{"opened", "clicked", "bounced"} // deduped, blanks dropped, order kept
	if len(got.EventTypes) != len(want) {
		t.Fatalf("event types = %v, want %v", got.EventTypes, want)
	}
	for i := range want {
		if got.EventTypes[i] != want[i] {
			t.Fatalf("event types = %v, want %v", got.EventTypes, want)
		}
	}

	// Comma/newline string shape also accepted.
	str := ParseConfig(map[string]any{"field_filters": "opened, clicked\nbounced"})
	if len(str.EventTypes) != 3 {
		t.Fatalf("string-form event types = %v, want 3", str.EventTypes)
	}

	// Absent / empty → nil (worker treats nil as "ship every type").
	if ParseConfig(nil).EventTypes != nil {
		t.Fatalf("nil config should yield nil event types")
	}
	if ParseConfig(map[string]any{"field_filters": []any{"  ", ""}}).EventTypes != nil {
		t.Fatalf("blanks-only filters should yield nil event types")
	}
}

func TestEventTypeFilterArg(t *testing.T) {
	// Empty/nil → nil so the SQL "$5::text[] IS NULL" branch ships all.
	if eventTypeFilterArg(nil) != nil {
		t.Fatalf("nil filters must bind nil")
	}
	if eventTypeFilterArg([]string{}) != nil {
		t.Fatalf("empty filters must bind nil")
	}
	// Non-empty → the slice itself for event_type = ANY($5).
	arg := eventTypeFilterArg([]string{"opened"})
	got, ok := arg.([]string)
	if !ok || len(got) != 1 || got[0] != "opened" {
		t.Fatalf("filter arg = %#v, want []string{opened}", arg)
	}
}

func TestValidateConfig(t *testing.T) {
	ok := ValidateConfig(map[string]any{
		"format":      "parquet",
		"compression": "snappy",
		"batch_size":  float64(1000),
		"prefix":      "events",
	})
	if !ok.Valid {
		t.Fatalf("expected valid, got %#v", ok)
	}
	if len(ok.Warnings) == 0 {
		t.Fatalf("expected workspace-storage disclosure, got %#v", ok.Warnings)
	}

	// Workspace storage is always disclosed and remains valid.
	noBucket := ValidateConfig(map[string]any{"format": "avro"})
	if !noBucket.Valid || len(noBucket.Warnings) == 0 {
		t.Fatalf("expected valid-with-warning, got %#v", noBucket)
	}

	override := ValidateConfig(map[string]any{"bucket": "operator-controlled"})
	if override.Valid || len(override.Errors) == 0 {
		t.Fatalf("per-connection bucket override must fail closed, got %#v", override)
	}
}
