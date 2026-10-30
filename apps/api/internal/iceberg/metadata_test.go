// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"encoding/json"
	"testing"
)

func sampleMetadata() TableMetadataV2 {
	schema := Schema{Fields: []Field{
		{Name: "event_id", Type: TypeLong, Required: true},
		{Name: "tenant_id", Type: TypeString, Required: true},
	}}
	lastCol := schema.AssignFieldIDs()
	return TableMetadataV2{
		FormatVersion:      2,
		TableUUID:          "b55d9dda-6561-423a-8bfc-787980ce421f",
		Location:           "s3://bucket/warehouse/events",
		LastSequenceNumber: 1,
		LastUpdatedMs:      1752000000000,
		LastColumnID:       lastCol,
		Schemas:            []schemaJSON{schema.toJSON()},
		CurrentSchemaID:    0,
		PartitionSpecs:     []PartitionSpec{{SpecID: 0, Fields: []PartitionSpecField{}}},
		DefaultSpecID:      0,
		LastPartitionID:    999,
		Properties:         map[string]string{},
		CurrentSnapshotID:  9001,
		Snapshots: []Snapshot{{
			SnapshotID:     9001,
			SequenceNumber: 1,
			TimestampMs:    1752000000000,
			Summary:        map[string]string{"operation": "append"},
			ManifestList:   "s3://bucket/warehouse/events/metadata/snap-9001-1.avro",
			SchemaID:       0,
		}},
		SnapshotLog:        []SnapshotLogEntry{{SnapshotID: 9001, TimestampMs: 1752000000000}},
		SortOrders:         []SortOrder{{OrderID: 0, Fields: []SortOrderField{}}},
		DefaultSortOrderID: 0,
		Refs:               map[string]SnapshotRef{"main": {SnapshotID: 9001, Type: "branch"}},
	}
}

func TestTableMetadataRoundTripsThroughJSON(t *testing.T) {
	meta := sampleMetadata()
	body, err := EncodeTableMetadataJSON(meta)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var generic map[string]any
	if err := json.Unmarshal(body, &generic); err != nil {
		t.Fatalf("unmarshal to generic map: %v", err)
	}

	fv, ok := generic["format-version"].(float64)
	if !ok || fv != 2 {
		t.Fatalf(`generic["format-version"] = %v want 2`, generic["format-version"])
	}
	if generic["table-uuid"] != meta.TableUUID {
		t.Fatalf("table-uuid = %v want %v", generic["table-uuid"], meta.TableUUID)
	}
	curSnap, ok := generic["current-snapshot-id"].(float64)
	if !ok || int64(curSnap) != meta.CurrentSnapshotID {
		t.Fatalf("current-snapshot-id = %v want %d", generic["current-snapshot-id"], meta.CurrentSnapshotID)
	}

	snapshots, ok := generic["snapshots"].([]any)
	if !ok || len(snapshots) != 1 {
		t.Fatalf("snapshots = %v", generic["snapshots"])
	}
	snap0 := snapshots[0].(map[string]any)
	if snap0["manifest-list"] != meta.Snapshots[0].ManifestList {
		t.Fatalf("snapshots[0][manifest-list] = %v want %v", snap0["manifest-list"], meta.Snapshots[0].ManifestList)
	}
	seqNum, ok := snap0["sequence-number"].(float64)
	if !ok || int64(seqNum) != 1 {
		t.Fatalf("snapshots[0][sequence-number] = %v want 1", snap0["sequence-number"])
	}

	refs, ok := generic["refs"].(map[string]any)
	if !ok {
		t.Fatalf("refs = %v", generic["refs"])
	}
	main, ok := refs["main"].(map[string]any)
	if !ok {
		t.Fatalf("refs[main] = %v", refs["main"])
	}
	mainSnap, ok := main["snapshot-id"].(float64)
	if !ok || int64(mainSnap) != meta.CurrentSnapshotID {
		t.Fatalf("refs[main][snapshot-id] = %v want %d", main["snapshot-id"], meta.CurrentSnapshotID)
	}
	if main["type"] != "branch" {
		t.Fatalf("refs[main][type] = %v want branch", main["type"])
	}

	// Round-trip into the typed struct too.
	var back TableMetadataV2
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatalf("unmarshal to typed struct: %v", err)
	}
	if back.FormatVersion != 2 || back.CurrentSnapshotID != meta.CurrentSnapshotID {
		t.Fatalf("typed round-trip mismatch: %+v", back)
	}
	if len(back.Schemas) != 1 || len(back.Schemas[0].Fields) != 2 {
		t.Fatalf("typed schemas mismatch: %+v", back.Schemas)
	}
	if back.Schemas[0].Fields[0].ID != 1 || back.Schemas[0].Fields[1].ID != 2 {
		t.Fatalf("typed schema field ids not preserved: %+v", back.Schemas[0].Fields)
	}
}

func TestTableMetadataIsPrettyPrinted(t *testing.T) {
	body, err := EncodeTableMetadataJSON(sampleMetadata())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if body[0] != '{' {
		t.Fatalf("expected JSON object, got %q", body[:1])
	}
	// EncodeTableMetadataJSON promises 2-space indentation.
	if !jsonHasIndent(body) {
		t.Fatal("expected indented JSON output")
	}
}

func jsonHasIndent(body []byte) bool {
	for i := 0; i+2 < len(body); i++ {
		if body[i] == '\n' && body[i+1] == ' ' && body[i+2] == ' ' {
			return true
		}
	}
	return false
}
