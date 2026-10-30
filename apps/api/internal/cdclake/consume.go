// SPDX-License-Identifier: AGPL-3.0-only
//
// consume.go — the CDC consume loop that ties the whole G-18 path together:
// pull a batch of pgoutput messages off a logical slot, decode them, group
// the appended rows (Insert + Update new-tuples) per relation, and append each
// group to that relation's Iceberg table (a persistent iceberg.TableAppender
// per relation, so successive batches accumulate snapshots on ONE table
// rather than overwriting), handing the resulting files to an uploader.
//
// The loop is written against two small interfaces — ChangeFetcher (where the
// raw messages come from) and TableUploader (where the table files go) — so
// the whole decode→group→encode pipeline unit-tests with fakes, and the same
// Consumer runs in production over a real slot (PgSlotFetcher) and a real S3
// uploader. The pgoutput read itself uses pg_logical_slot_get_binary_changes,
// which consumes (advances) the slot over an ordinary SQL connection, so no
// streaming replication protocol / pglogrepl is required.
//
// Scope: this is the append path — Insert and Update carry the row's new
// state and are appended as data rows. Delete requires Iceberg v2 equality
// deletes (a separate mechanism) and is counted but not yet materialized; see
// ConsumeBatch's return.
package cdclake

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// ChangeFetcher returns the next batch of raw pgoutput message bytes,
// consuming them from the underlying slot so a later call does not see them
// again. An empty slice with a nil error means "no changes right now".
type ChangeFetcher interface {
	FetchAndConsume(ctx context.Context, maxMessages int) ([][]byte, error)
}

// TableUploader persists one relation's Iceberg table files (data + manifest
// + manifest list + metadata) to wherever the lakehouse lives.
type TableUploader interface {
	Upload(ctx context.Context, relation string, tf *iceberg.TableFiles) error
}

// ConsumerConfig wires a Consumer.
type ConsumerConfig struct {
	Fetcher  ChangeFetcher
	Uploader TableUploader
	// TableOf returns the stable Iceberg table identity for a relation: a
	// permanent table UUID (must be the SAME across batches for a relation so
	// snapshots accumulate on one table, not a new table each batch) and its
	// s3:// base location.
	TableOf func(rel pgcdc.RelationMessage) (tableUUID, location string)
	// NextSnapshotID returns a unique, increasing snapshot id for each append.
	NextSnapshotID func() int64
	// Now supplies each snapshot's timestamp.
	Now func() time.Time
}

// Consumer decodes CDC batches and appends them to per-relation Iceberg
// tables. Construct it with NewConsumer. Not safe for concurrent use.
type Consumer struct {
	cfg       ConsumerConfig
	cache     *pgcdc.RelationCache
	appenders map[uint32]*iceberg.TableAppender
}

// NewConsumer wires a Consumer from cfg.
func NewConsumer(cfg ConsumerConfig) *Consumer {
	return &Consumer{
		cfg:       cfg,
		cache:     pgcdc.NewRelationCache(),
		appenders: map[uint32]*iceberg.TableAppender{},
	}
}

// BatchResult reports what one ConsumeBatch did.
type BatchResult struct {
	Messages      int // raw pgoutput messages decoded
	TablesWritten int // relations written+uploaded this batch
	Appended      int // Insert/Update rows appended across all relations
	DeletesSeen   int // Delete messages (not yet materialized — see package doc)
}

// ConsumeBatch fetches up to maxMessages, decodes them, groups Insert/Update
// rows per relation, writes one Iceberg append per relation, and uploads it.
// The RelationCache persists across batches, so a relation's shape learned in
// an earlier batch still resolves later inserts. Returns a summary; a decode,
// encode, or upload error stops the batch (the slot data for a failed batch
// is already consumed, so a caller that needs at-least-once semantics should
// checkpoint the uploader before advancing — noted for the real slot fetcher).
func (c *Consumer) ConsumeBatch(ctx context.Context, maxMessages int) (BatchResult, error) {
	raw, err := c.cfg.Fetcher.FetchAndConsume(ctx, maxMessages)
	if err != nil {
		return BatchResult{}, fmt.Errorf("cdclake: fetch changes: %w", err)
	}
	res := BatchResult{Messages: len(raw)}

	type relAcc struct {
		rel  pgcdc.RelationMessage
		rows [][]pgcdc.NamedColumn
	}
	acc := map[uint32]*relAcc{}
	var order []uint32 // deterministic write order (first-seen)

	appendRow := func(relID uint32, tup pgcdc.TupleData) error {
		rel, ok := c.cache.Relation(relID)
		if !ok {
			return fmt.Errorf("cdclake: change for relation %d with no cached shape", relID)
		}
		cols, err := c.cache.NamedColumns(relID, tup)
		if err != nil {
			return err
		}
		a := acc[relID]
		if a == nil {
			a = &relAcc{rel: rel}
			acc[relID] = a
			order = append(order, relID)
		}
		a.rows = append(a.rows, cols)
		res.Appended++
		return nil
	}

	for i, b := range raw {
		msg, err := pgcdc.Decode(b)
		if err != nil {
			return res, fmt.Errorf("cdclake: decode message %d: %w", i, err)
		}
		c.cache.Observe(msg)
		switch m := msg.(type) {
		case pgcdc.InsertMessage:
			if err := appendRow(m.RelationID, m.New); err != nil {
				return res, err
			}
		case pgcdc.UpdateMessage:
			if err := appendRow(m.RelationID, m.New); err != nil {
				return res, err
			}
		case pgcdc.DeleteMessage:
			res.DeletesSeen++
		}
	}

	for _, relID := range order {
		a := acc[relID]
		if len(a.rows) == 0 {
			continue
		}
		parquetBytes, schema, err := EncodeParquet(a.rel, a.rows)
		if err != nil {
			return res, fmt.Errorf("cdclake: encode %s: %w", a.rel.RelationName, err)
		}
		app := c.appenders[relID]
		if app == nil {
			tableUUID, location := c.cfg.TableOf(a.rel)
			app, err = iceberg.NewTableAppender(tableUUID, location, schema)
			if err != nil {
				return res, fmt.Errorf("cdclake: new appender for %s: %w", a.rel.RelationName, err)
			}
			c.appenders[relID] = app
		}
		tf, err := app.Append(parquetBytes, iceberg.AppendOptions{
			SnapshotID:  c.cfg.NextSnapshotID(),
			TimestampMs: c.cfg.Now().UnixMilli(),
		})
		if err != nil {
			return res, fmt.Errorf("cdclake: append %s: %w", a.rel.RelationName, err)
		}
		if err := c.cfg.Uploader.Upload(ctx, a.rel.RelationName, tf); err != nil {
			return res, fmt.Errorf("cdclake: upload %s: %w", a.rel.RelationName, err)
		}
		res.TablesWritten++
	}
	return res, nil
}

// PgSlotFetcher is the production ChangeFetcher: it reads (and consumes)
// pgoutput bytes from a logical slot via pg_logical_slot_get_binary_changes.
// The querier is anything with pgx's Query (a *pgx.Conn or *pgxpool.Pool).
type PgSlotFetcher struct {
	Querier     Querier
	SlotName    string
	Publication string
}

// Querier is the narrow slice of pgx used to read changes.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// FetchAndConsume returns up to maxMessages raw pgoutput messages and advances
// the slot past them. maxMessages<=0 means "no limit".
func (f PgSlotFetcher) FetchAndConsume(ctx context.Context, maxMessages int) ([][]byte, error) {
	var limit any = nil
	if maxMessages > 0 {
		limit = maxMessages
	}
	rows, err := f.Querier.Query(ctx,
		`SELECT data FROM pg_logical_slot_get_binary_changes($1, NULL, $2,
		   'proto_version', '1', 'publication_names', $3)`,
		f.SlotName, limit, f.Publication)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		cp := make([]byte, len(b))
		copy(cp, b)
		out = append(out, cp)
	}
	return out, rows.Err()
}

// RunConsumer drives ConsumeBatch once per tick until ctx is cancelled or the
// ticks channel closes. Production passes time.NewTicker(interval).C; tests
// pass a channel they drive deterministically. A ConsumeBatch error is handed
// to onError (if non-nil) and the loop continues — a transient DB/upload hiccup
// should not kill a long-lived CDC worker — so the caller decides whether to
// alert, back off, or (via ctx) stop.
func RunConsumer(ctx context.Context, c *Consumer, ticks <-chan time.Time, maxBatch int, onError func(error)) {
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-ticks:
			if !ok {
				return
			}
			if _, err := c.ConsumeBatch(ctx, maxBatch); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}
