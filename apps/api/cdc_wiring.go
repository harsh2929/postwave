package main

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/cdclake"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

// startCDCConsumer activates the CDC→Iceberg lakehouse consumer (G-18) when a
// deployment opts in via POSTWAVE_CDC_ENABLED. It reads the deploy settings
// from the environment, builds the consumer over the app's pgx pool + S3
// client, and runs the consume loop on a ticker under safego; ctx cancellation
// stops it. Absent the enable flag (or its required config) it is a no-op, so
// the pipeline ships dark until explicitly turned on.
//
// Required env when enabled: POSTWAVE_CDC_BUCKET, POSTWAVE_CDC_SLOT,
// POSTWAVE_CDC_PUBLICATION (the logical replication slot + publication must
// already exist on the database). Optional: POSTWAVE_CDC_PREFIX,
// POSTWAVE_CDC_INTERVAL (Go duration, default 30s), POSTWAVE_CDC_MAX_BATCH
// (default 10000), POSTWAVE_CDC_UUID_NAMESPACE (a UUID; defaults to a fixed
// Moosewave namespace so table identities are stable).
func startCDCConsumer(ctx context.Context, logger *slog.Logger, pool *db.Pool, s3Client *s3.Client, kmsKeyID string) {
	if strings.TrimSpace(os.Getenv("POSTWAVE_CDC_ENABLED")) == "" {
		return
	}
	bucket := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_BUCKET"))
	slot := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_SLOT"))
	publication := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_PUBLICATION"))
	if bucket == "" || slot == "" || publication == "" {
		logger.Warn("cdc: POSTWAVE_CDC_ENABLED set but POSTWAVE_CDC_{BUCKET,SLOT,PUBLICATION} missing; not starting")
		return
	}
	if s3Client == nil {
		logger.Warn("cdc: enabled but no S3 client (AWS not configured); not starting")
		return
	}

	ns := uuid.NewSHA1(uuid.NameSpaceURL, []byte("postwave.cdc"))
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_UUID_NAMESPACE")); raw != "" {
		if parsed, err := uuid.Parse(raw); err == nil {
			ns = parsed
		} else {
			logger.Warn("cdc: POSTWAVE_CDC_UUID_NAMESPACE is not a valid UUID; using the default namespace", "err", err)
		}
	}

	cfg := cdclake.CDCConfig{
		SlotName:           slot,
		Publication:        publication,
		Bucket:             bucket,
		Prefix:             strings.TrimSpace(os.Getenv("POSTWAVE_CDC_PREFIX")),
		TableUUIDNamespace: ns,
		// Seed snapshot ids from wall-clock ms so they stay unique + increasing
		// across restarts even though the in-memory appender resets (durable
		// resume via iceberg.RecoverTableAppender is a follow-up).
		StartSnapshotID: time.Now().UnixMilli(),
	}

	interval := 30 * time.Second
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_INTERVAL")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			interval = d
		}
	}
	maxBatch := 10000
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_CDC_MAX_BATCH")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			maxBatch = n
		}
	}

	consumer := cdclake.BuildConsumer(cfg, pool, s3Client, kmsKeyID, time.Now)
	logger.Info("cdc: lakehouse consumer active",
		"bucket", bucket, "slot", slot, "publication", publication, "interval", interval.String())
	safego.Go(logger, "cdc-lakehouse-consumer", func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		cdclake.RunConsumer(ctx, consumer, ticker.C, maxBatch, func(err error) {
			logger.Warn("cdc: consume batch error", "err", err)
		})
	})
}
