package streaming_export

import (
	"bytes"
	"testing"
	"time"

	"github.com/parquet-go/parquet-go"
)

func sampleRows() []EventRow {
	return []EventRow{
		{
			EventID:          1,
			TenantID:         "t1",
			SubscriberEmail:  "a@example.com",
			EventType:        "open",
			CampaignID:       "c-1",
			LinkURL:          "",
			AtUnixMs:         1700000000000,
			SubscriberStatus: "enabled",
			Tags:             `["vip","beta"]`,
			CustomFields:     `{"plan":"pro"}`,
		},
		{
			EventID:          2,
			TenantID:         "t1",
			SubscriberEmail:  "b@example.com",
			EventType:        "click",
			CampaignID:       "c-2",
			LinkURL:          "https://example.com/x",
			AtUnixMs:         1700000005000,
			SubscriberStatus: "disabled",
			Tags:             `[]`,
			CustomFields:     `{}`,
		},
	}
}

func TestEncodeParquetRoundTrips(t *testing.T) {
	rows := sampleRows()
	body, err := EncodeParquet(rows)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("empty parquet body")
	}
	// Parquet magic header + footer.
	if !bytes.HasPrefix(body, []byte("PAR1")) || !bytes.HasSuffix(body, []byte("PAR1")) {
		t.Fatalf("missing PAR1 magic markers")
	}

	got, err := parquet.Read[EventRow](bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got) != len(rows) {
		t.Fatalf("row count = %d want %d", len(got), len(rows))
	}
	if got[0].SubscriberEmail != "a@example.com" || got[0].EventType != "open" {
		t.Fatalf("row0 = %#v", got[0])
	}
	if got[1].LinkURL != "https://example.com/x" {
		t.Fatalf("row1 link = %q", got[1].LinkURL)
	}
	if got[0].CustomFields != `{"plan":"pro"}` {
		t.Fatalf("row0 custom_fields = %q", got[0].CustomFields)
	}
}

func TestEncodeParquetEmpty(t *testing.T) {
	body, err := EncodeParquet(nil)
	if err != nil {
		t.Fatalf("encode empty: %v", err)
	}
	if !bytes.HasPrefix(body, []byte("PAR1")) {
		t.Fatalf("empty parquet missing magic")
	}
}

func TestObjectKeyHivePartitioned(t *testing.T) {
	w := time.Date(2026, 6, 15, 13, 0, 0, 0, time.UTC)
	got := ObjectKey("streaming-export", "tenant-1", w, "run-abc", "parquet")
	want := "streaming-export/tenant=tenant-1/year=2026/month=06/day=15/hour=13/run-abc.parquet"
	if got != want {
		t.Fatalf("ObjectKey = %q want %q", got, want)
	}
	// default prefix + ext.
	got2 := ObjectKey("", "t", w, "r", "")
	if got2 != "streaming-export/tenant=t/year=2026/month=06/day=15/hour=13/r.parquet" {
		t.Fatalf("default ObjectKey = %q", got2)
	}
}
