// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/holdout"
)

// holdoutPoweredLiftAdapter keeps the analytics HTTP package dependent on a
// read-only interface while the holdout package remains the authority for
// immutable experiment evidence. It refuses an incomplete powered row instead
// of silently projecting missing estimates as zeroes.
type holdoutPoweredLiftAdapter struct {
	store *holdout.LiftResultStore
}

func (a holdoutPoweredLiftAdapter) PoweredIncrementalLiftFor(
	ctx context.Context,
	query engagementclassification.PoweredIncrementalLiftQuery,
) (*engagementclassification.PoweredIncrementalLift, error) {
	if a.store == nil {
		return nil, nil
	}
	result, err := a.store.PoweredResultFor(ctx, holdout.PoweredLiftQuery{
		TenantID:   query.TenantID,
		CampaignID: query.CampaignID,
		Since:      query.Since,
		Until:      query.Until,
	})
	if err != nil || result == nil {
		return nil, err
	}
	if !result.Powered() || result.AbsoluteLift == nil ||
		result.IncrementalConversions == nil || result.CILow == nil ||
		result.CIHigh == nil {
		return nil, fmt.Errorf("project powered holdout result %s: incomplete powered evidence", result.ID)
	}

	return &engagementclassification.PoweredIncrementalLift{
		EvidencePointer: engagementclassification.IncrementalLiftEvidencePointer{
			ResultID:       result.ID,
			EvidenceSHA256: result.EvidenceSHA256,
		},
		Powered:                 true,
		ResultVersion:           result.ResultVersion,
		Metric:                  result.Metric,
		WindowStart:             result.WindowStart,
		WindowEnd:               result.WindowEnd,
		NTreatment:              result.NTreatment,
		NControl:                result.NControl,
		ConversionsTreatment:    result.ConversionsTreatment,
		ConversionsControl:      result.ConversionsControl,
		RateTreatment:           result.RateTreatment,
		RateControl:             result.RateControl,
		AbsoluteLift:            *result.AbsoluteLift,
		RelativeLift:            result.RelativeLift,
		IncrementalConversions:  *result.IncrementalConversions,
		PValue:                  result.PValue,
		CILow:                   *result.CILow,
		CIHigh:                  *result.CIHigh,
		MinimumDetectableEffect: result.MinimumDetectableEffect,
		MethodologyVersion:      result.MethodologyVersion,
		MethodologyStatement:    result.MethodologyStatement,
		GeneratedAt:             result.GeneratedAt,
	}, nil
}
