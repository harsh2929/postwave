// SPDX-License-Identifier: AGPL-3.0-only
//
// Delegation seams for the native write tools (1.3b). These narrow
// interfaces are the only slices of the campaigns and tags service layers
// the write tools touch. They are consumer-defined here (Go idiom) so the
// mcp package depends only on the method shapes it actually calls, and the
// real services — *campaigns.Repo, *campaigns.Deps, *tags.Repo,
// *tags.SubscriberTagsRepo — satisfy them structurally and are wired in
// main.go.
//
// Bare-handler delegation: a tool handler calls these service funcs
// DIRECTLY, never the HTTP handlers, so one tool invocation passes through
// the agenttools governance chokepoint exactly once (no double governance,
// no second trip through the router middleware) while still reusing all the
// domain validation/compliance/suppression/approval logic the REST path runs.
package mcp

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

// campaignCreator creates a draft/scheduled campaign. Satisfied by
// *campaigns.Repo (the create logic lives on the repo; the send logic lives
// on *campaigns.Deps, hence the two separate seams).
type campaignCreator interface {
	Create(ctx context.Context, tenantID string, in campaigns.CreateInput) (*campaigns.Campaign, error)
}

// campaignSender queues a campaign for sending via the full safety pipeline
// (approval stays enforced). Satisfied by *campaigns.Deps.
type campaignSender interface {
	QueueCampaignForAgent(ctx context.Context, tenantID, campaignID, actorLabel string) (campaigns.AgentQueueResult, error)
}

// tagCreator creates a tag. Satisfied by *tags.Repo.
type tagCreator interface {
	Create(ctx context.Context, tenantID string, in tags.CreateInput) (*tags.Tag, error)
}

// subscriberTagApplier attaches a tag (by name, creating the registry row if
// missing) to a subscriber. Satisfied by *tags.SubscriberTagsRepo.
type subscriberTagApplier interface {
	ApplyByName(ctx context.Context, tenantID, subscriberID, name, appliedBy, source string) (string, error)
}

// assetUploader validates + stores an image asset from raw bytes (the
// request-less core). Satisfied by *assets.Deps (UploadBytes).
type assetUploader interface {
	UploadBytes(ctx context.Context, tenantID, filename, declaredMime string, body []byte) (*assets.Asset, error)
}

// listCreator creates a subscriber list via the request-less Listmonk proxy
// core (single HTTP hop, LICENSE-BOUNDARY). Satisfied by *lists.Deps.
type listCreator interface {
	CreateForAgent(ctx context.Context, tenantID string, in lists.CreateListInput) (*lists.List, error)
}
