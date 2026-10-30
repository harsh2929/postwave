package main

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// trackRevenueRecorder adapts the conversion store to track's narrow
// RevenueRecorder seam (G-49d) so an order-shaped /api/v1/track event is
// bridged into the revenue store — where conversions.Insert applies last-touch
// campaign attribution — without the track package importing conversions.
type trackRevenueRecorder struct{ repo *conversions.Repo }

func (a trackRevenueRecorder) RecordOrder(ctx context.Context, tenantID string, o track.OrderConversion) error {
	amount := o.AmountCents
	_, err := a.repo.Insert(ctx, tenantID, conversions.IngestInput{
		Email:       o.Email,
		EventName:   o.EventName,
		AmountCents: &amount,
		Currency:    o.Currency,
		Properties:  o.Properties,
	})
	return err
}

// newTrackRevenueRecorder builds the bridge over an existing conversions repo.
func newTrackRevenueRecorder(repo *conversions.Repo) track.RevenueRecorder {
	return trackRevenueRecorder{repo: repo}
}
