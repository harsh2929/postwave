// SPDX-License-Identifier: AGPL-3.0-only
//
// assemble.go — BuildConsumer wires the whole CDC→Iceberg consumer from a
// config value plus the app's real dependencies (a pgx querier and an S3
// client). It is the seam between the tested library and the app's boot: the
// only thing left for main.go is to read the config from the environment, get
// the pool + S3 client it already builds, call BuildConsumer, and start
// RunConsumer on a ticker.
//
// The one piece here with real correctness content — and so exported + tested
// on its own — is TableIdentity: a relation's Iceberg table UUID must be
// STABLE across process restarts and batches (it identifies the table a
// reader loads), so it is derived deterministically from the config namespace
// + the relation's qualified name rather than randomly generated.
package cdclake

import (
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// CDCConfig is the deployment configuration for a CDC→Iceberg consumer: which
// slot/publication to read, where the lakehouse lives, and the namespace that
// makes per-relation table UUIDs stable.
type CDCConfig struct {
	// SlotName / Publication identify the logical replication slot and its
	// publication (must already exist on the source database).
	SlotName    string
	Publication string
	// Bucket / Prefix place tables at s3://Bucket/Prefix/<relation>.
	Bucket string
	Prefix string
	// TableUUIDNamespace seeds deterministic per-relation table UUIDs; use a
	// fixed per-deployment namespace so a table keeps its identity forever.
	TableUUIDNamespace uuid.UUID
	// StartSnapshotID seeds the snapshot-id counter (each append takes the
	// next value). Set it above any snapshot id already committed so ids stay
	// unique after a restart.
	StartSnapshotID int64
}

// TableIdentity returns the stable Iceberg table UUID and s3:// base location
// for a relation. Deterministic: the same (namespace, schema.table) always
// yields the same UUID, so appends across batches and restarts land on the
// same table.
func TableIdentity(cfg CDCConfig, rel pgcdc.RelationMessage) (tableUUID, location string) {
	qualified := rel.Namespace + "." + rel.RelationName
	tableUUID = uuid.NewSHA1(cfg.TableUUIDNamespace, []byte(qualified)).String()
	location = "s3://" + cfg.Bucket + "/" + strings.Trim(cfg.Prefix, "/") + "/" + rel.RelationName
	return tableUUID, location
}

// BuildConsumer assembles a Consumer from cfg and the app's real dependencies:
// querier is the pgx pool/conn the slot is read over, s3 the client tables are
// PUT through (kmsKey optional), and now the clock for snapshot timestamps.
func BuildConsumer(cfg CDCConfig, querier Querier, s3 S3PutObjectAPI, kmsKey string, now func() time.Time) *Consumer {
	counter := cfg.StartSnapshotID
	return NewConsumer(ConsumerConfig{
		Fetcher:  PgSlotFetcher{Querier: querier, SlotName: cfg.SlotName, Publication: cfg.Publication},
		Uploader: S3TableUploader{S3: s3, SSEKMSKeyID: kmsKey},
		TableOf: func(rel pgcdc.RelationMessage) (string, string) {
			return TableIdentity(cfg, rel)
		},
		NextSnapshotID: func() int64 { counter++; return counter },
		Now:            now,
	})
}
