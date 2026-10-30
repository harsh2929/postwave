// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// PopulationPurpose names the product question a segment evaluation answers.
// Keeping this typed prevents analytics/definition counts from being reused as
// send eligibility without the required status and consent gates.
type PopulationPurpose uint8

const (
	PopulationPurposeDefinition PopulationPurpose = iota + 1
	PopulationPurposeActivation
)

// ActivationChannel is the consent vector required for an activation
// population. It intentionally has no empty/unknown production value.
type ActivationChannel string

const (
	ActivationChannelEmail ActivationChannel = "email"
	ActivationChannelSMS   ActivationChannel = "sms"
	ActivationChannelPush  ActivationChannel = "push"
)

// PopulationScope is the explicit population contract applied around a
// canonical segment AST.
//
// Definition membership describes who currently satisfies the definition.
// Archived profiles are excluded unless IncludeArchived is deliberately set.
//
// Activation eligibility describes who may be activated on Channel right now.
// It always excludes archived and non-enabled profiles and applies the
// canonical channel-consent gate. IncludeArchived is invalid for activation.
type PopulationScope struct {
	Purpose         PopulationPurpose
	IncludeArchived bool
	Channel         ActivationChannel
}

// DefinitionPopulation returns the default analytics/library membership
// scope. includeArchived must only be true for an explicit historical preview.
func DefinitionPopulation(includeArchived bool) PopulationScope {
	return PopulationScope{
		Purpose:         PopulationPurposeDefinition,
		IncludeArchived: includeArchived,
	}
}

// ActivationPopulation returns the send/materialisation eligibility scope for
// one channel.
func ActivationPopulation(channel ActivationChannel) PopulationScope {
	return PopulationScope{Purpose: PopulationPurposeActivation, Channel: channel}
}

// PopulationPredicate is the only SQL fragment production segment evaluators
// should execute. SQL is parameterised and written for a FROM subscribers
// relation whose canonical table name remains visible (no alias replacement).
type PopulationPredicate struct {
	SQL  string
	Args []any
}

// CompilePopulation compiles a segment AST with tenant-scoped composable
// resolution and applies its explicit population scope. A resolver is required
// even when the current AST has no segment_id predicate: this invariant means a
// persisted definition cannot compile at save time and later fail merely
// because a downstream consumer forgot to wire composable resolution.
func CompilePopulation(
	ctx context.Context,
	raw json.RawMessage,
	tenantID string,
	resolver SegmentResolver,
	scope PopulationScope,
) (PopulationPredicate, error) {
	if strings.TrimSpace(tenantID) == "" {
		return PopulationPredicate{}, errors.New("segments: population tenant id is required")
	}
	if resolver == nil {
		return PopulationPredicate{}, errors.New("segments: population resolver is required")
	}

	fragment, args, err := CompileASTWithResolver(ctx, raw, tenantID, resolver)
	if err != nil {
		return PopulationPredicate{}, err
	}
	if strings.TrimSpace(fragment) == "" {
		return PopulationPredicate{}, errors.New("segments: compiler returned an empty population predicate")
	}

	switch scope.Purpose {
	case PopulationPurposeDefinition:
		if scope.Channel != "" {
			return PopulationPredicate{}, errors.New("segments: definition population cannot specify an activation channel")
		}
		if !scope.IncludeArchived {
			fragment = andPopulationPredicates(fragment, "subscribers.archived_at IS NULL")
		}
	case PopulationPurposeActivation:
		if scope.IncludeArchived {
			return PopulationPredicate{}, errors.New("segments: activation population cannot include archived subscribers")
		}
		channel, err := validatedActivationChannel(scope.Channel)
		if err != nil {
			return PopulationPredicate{}, err
		}
		gate, err := ChannelConsentGate(string(channel))
		if err != nil {
			return PopulationPredicate{}, fmt.Errorf("segments: activation consent gate: %w", err)
		}
		fragment = andPopulationPredicates(
			fragment,
			"subscribers.archived_at IS NULL",
			"subscribers.status = 'enabled'",
			gate,
		)
	default:
		return PopulationPredicate{}, fmt.Errorf("segments: unknown population purpose %d", scope.Purpose)
	}

	return PopulationPredicate{SQL: fragment, Args: args}, nil
}

func validatedActivationChannel(channel ActivationChannel) (ActivationChannel, error) {
	switch ActivationChannel(strings.ToLower(strings.TrimSpace(string(channel)))) {
	case ActivationChannelEmail:
		return ActivationChannelEmail, nil
	case ActivationChannelSMS:
		return ActivationChannelSMS, nil
	case ActivationChannelPush:
		return ActivationChannelPush, nil
	default:
		return "", fmt.Errorf("segments: unsupported activation channel %q", channel)
	}
}

func andPopulationPredicates(parts ...string) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			nonEmpty = append(nonEmpty, "("+trimmed+")")
		}
	}
	if len(nonEmpty) == 0 {
		return "TRUE"
	}
	return strings.Join(nonEmpty, " AND ")
}

// SegmentResolverFunc adapts a tenant-scoped loader function to
// SegmentResolver. It is useful for callers that must resolve every nested AST
// through their existing transaction snapshot.
type SegmentResolverFunc func(context.Context, string, string) (json.RawMessage, error)

func (fn SegmentResolverFunc) ASTForSegment(ctx context.Context, tenantID, segmentID string) (json.RawMessage, error) {
	if fn == nil {
		return nil, errors.New("segments: nil resolver function")
	}
	return fn(ctx, tenantID, segmentID)
}

// SegmentASTQueryer is the pgx subset needed by TransactionSegmentResolver.
// pgx.Tx and pgxpool.Pool both satisfy it.
type SegmentASTQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// TransactionSegmentResolver resolves composed definitions through the
// caller's transaction, preserving its RLS scope and statement snapshot.
type TransactionSegmentResolver struct {
	Queryer SegmentASTQueryer
}

func (r TransactionSegmentResolver) ASTForSegment(ctx context.Context, tenantID, segmentID string) (json.RawMessage, error) {
	if r.Queryer == nil {
		return nil, errors.New("segments: nil transaction resolver")
	}
	var raw json.RawMessage
	err := r.Queryer.QueryRow(ctx, `
SELECT query_ast
  FROM segments
 WHERE tenant_id = $1::uuid
   AND id::text = $2`, tenantID, segmentID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return raw, nil
}
