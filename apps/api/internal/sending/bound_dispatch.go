// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

const (
	boundReasonRuntimeUnconfigured    = "BOUND_RUNTIME_UNCONFIGURED"
	boundReasonUnsubscribeUnavailable = "BOUND_UNSUBSCRIBE_UNAVAILABLE"
	boundReasonAssuranceRequired      = "BOUND_ASSURANCE_REQUIRED"
	boundReasonInvalidResult          = "BOUND_RUNTIME_INVALID_RESULT"
)

type preparedDispatchResult struct {
	status                 string
	errMsg                 string
	attempted              bool
	externalEffectPossible bool
	revert                 bool
	replayed               bool
	err                    error
}

// dispatchPrepared is the single convergence point after suppression,
// consent, quiet-hour, warmup and rate-limit policy have all passed. The first
// branch is intentionally based on Binding.Any(), not Binding validity: a
// malformed partial binding must fail closed instead of becoming a legacy row.
func (g *Guard) dispatchPrepared(
	ctx context.Context,
	tenantID string,
	pr pendingRow,
	body campaignBody,
	renderedBody string,
	headers map[string]string,
	messenger string,
	unsubscribeReady bool,
) preparedDispatchResult {
	if pr.binding.Any() {
		if !unsubscribeReady {
			return withheldBound(boundReasonUnsubscribeUnavailable, nil)
		}
		if g == nil || g.AssuranceBound == nil {
			return withheldBound(boundReasonRuntimeUnconfigured, nil)
		}
		outcome, err := g.AssuranceBound.DispatchBound(ctx, BoundDispatchInput{
			TenantID: tenantID, CampaignID: pr.cid, CampaignRecipientID: pr.id,
			SubscriberID: pr.subscriberID,
			Recipient:    pr.email, VariantID: pr.vid, Binding: cloneAssuranceBinding(pr.binding),
			FromName: body.fromName, FromEmail: body.fromEmail, ReplyTo: body.replyTo,
			Headers: cloneDispatchHeaders(headers), Messenger: messenger,
		})
		reason := normalizeBoundReason(outcome.Reason)
		switch outcome.Status {
		case BoundDispatchAccepted:
			if err != nil || reason != "" {
				return withheldBound(boundReasonInvalidResult, err)
			}
			return preparedDispatchResult{status: RecipientSent, attempted: true, externalEffectPossible: true, replayed: outcome.Replayed}
		case BoundDispatchRetryable:
			if reason == "" {
				reason = boundReasonInvalidResult
			}
			return preparedDispatchResult{revert: true, errMsg: reason, err: err}
		case BoundDispatchRejected, BoundDispatchIndeterminate, BoundDispatchWithheld:
			if reason == "" {
				reason = boundReasonInvalidResult
			}
			return preparedDispatchResult{
				status: RecipientFailed, errMsg: reason, attempted: true,
				externalEffectPossible: outcome.Status == BoundDispatchIndeterminate, err: err,
			}
		default:
			return withheldBound(boundReasonInvalidResult, err)
		}
	}
	if g != nil && g.RequireAssuranceBinding {
		return withheldBound(boundReasonAssuranceRequired, nil)
	}

	if g == nil || g.Listmonk == nil {
		return preparedDispatchResult{
			status: RecipientFailed, errMsg: "legacy_listmonk_unconfigured", attempted: true,
			err: fmt.Errorf("sendloop: Listmonk sender is required for an unbound recipient"),
		}
	}
	var err error
	if headers != nil {
		err = g.Listmonk.SendWithHeaders(
			ctx, tenantID, pr.email, body.subject, renderedBody,
			fmt.Sprintf("cr-%d", pr.id), messenger, headers,
		)
	} else {
		err = g.Listmonk.SendWithRouting(
			ctx, tenantID, pr.email, body.subject, renderedBody,
			fmt.Sprintf("cr-%d", pr.id), messenger,
		)
	}
	if err != nil {
		message := err.Error()
		if len(message) > 500 {
			message = message[:500]
		}
		// The legacy Listmonk edge cannot prove whether a transport error happened
		// before or after upstream acceptance, so retain the committed allowance.
		return preparedDispatchResult{
			status: RecipientFailed, errMsg: message, attempted: true,
			externalEffectPossible: !listmonk.DefinitelyRejected(err), err: err,
		}
	}
	return preparedDispatchResult{status: RecipientSent, attempted: true, externalEffectPossible: true}
}

func withheldBound(reason string, err error) preparedDispatchResult {
	reason = normalizeBoundReason(reason)
	observeAssuranceDispatchBlock(reason)
	return preparedDispatchResult{
		status: RecipientFailed, errMsg: reason, attempted: true, err: err,
	}
}

func normalizeBoundReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 96 {
		return ""
	}
	for index, current := range reason {
		if index == 0 {
			if current < 'A' || current > 'Z' {
				return ""
			}
			continue
		}
		if (current < 'A' || current > 'Z') && (current < '0' || current > '9') && current != '_' {
			return ""
		}
		if unicode.IsControl(current) {
			return ""
		}
	}
	return reason
}

func cloneAssuranceBinding(input AssuranceBinding) AssuranceBinding {
	input.OverrideIDs = append([]string(nil), input.OverrideIDs...)
	if input.BoundAt != nil {
		value := *input.BoundAt
		input.BoundAt = &value
	}
	return input
}

func cloneDispatchHeaders(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
