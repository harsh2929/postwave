// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

// audience_label.go — a campaign's audience in the words people use for it.
//
// The send review and the pre-send checklist used to identify the audience by
// its storage id ("Segment 00a94619-… selected.", "List 16 selected.") because
// the only name lookup was an optional send-preview hook that nothing ever
// wired. The name is resolved here, next to the data, so every surface that
// describes an audience — checklist, send-preview, and the desktop and mobile
// clients rendering them verbatim — gets it without composition wiring that
// can be forgotten.

import (
	"context"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ListNamer reads the display name of a list audience. List names are not
// stored on this side — the engine (Listmonk) owns them — so the composition
// root supplies an adapter that resolves the tenant-owned list and asks the
// engine for its name.
type ListNamer interface {
	// ListName returns the name of the list stored on a campaign as
	// audience_list_id (the engine id) for this tenant. An error means the
	// name could not be read; callers degrade to a generic phrase.
	ListName(ctx context.Context, tenantID, listID string) (string, error)
}

// audienceLabelTimeout bounds the name lookup. A label is a courtesy on a
// review screen: a slow engine must not hold the checklist or the send review.
const audienceLabelTimeout = 2 * time.Second

// audienceLabel is the audience source a campaign names and, when it can be
// read, that source's name. Name is empty for a workspace audience and when a
// list or segment name could not be read.
type audienceLabel struct {
	Kind CampaignAudienceKind
	Name string
}

// campaignAudienceLabel describes the audience the campaign NAMES — its list,
// its segment, or the whole workspace. It does not resolve membership, so it
// is cheap enough for every checklist render.
func (r *Repo) campaignAudienceLabel(ctx context.Context, tenantID string, c *Campaign) audienceLabel {
	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)
	switch {
	case listID != "":
		return audienceLabel{Kind: CampaignAudienceList, Name: r.listName(ctx, tenantID, listID)}
	case segmentID != "":
		return audienceLabel{Kind: CampaignAudienceSegment, Name: r.segmentName(ctx, tenantID, segmentID)}
	default:
		return audienceLabel{Kind: CampaignAudienceWorkspace}
	}
}

func (r *Repo) listName(ctx context.Context, tenantID, listID string) string {
	if r == nil || r.ListNamer == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, audienceLabelTimeout)
	defer cancel()
	name, err := r.ListNamer.ListName(ctx, tenantID, listID)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(name)
}

// segmentName reads the segment's name under the tenant's RLS scope — the same
// table and predicate validateSegment uses, so a segment another tenant owns
// has no name here.
func (r *Repo) segmentName(ctx context.Context, tenantID, segmentID string) string {
	if r == nil || r.Pool == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, audienceLabelTimeout)
	defer cancel()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ""
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// A missing row and a failed read both degrade to "no name": the
	// recipients check beside this one is what reports a missing segment.
	var name string
	if err := tx.QueryRow(ctx, `
SELECT name
  FROM segments
 WHERE tenant_id = $1::uuid
   AND id::text = $2`, tenantID, segmentID).Scan(&name); err != nil {
		return ""
	}
	return strings.TrimSpace(name)
}

// audienceSelectedDetail is the checklist sentence for the audience a
// campaign names. It never prints a storage id: when a name cannot be read the
// sentence says so instead of falling back to one.
func audienceSelectedDetail(label audienceLabel) string {
	switch label.Kind {
	case CampaignAudienceList:
		if label.Name == "" {
			return "A list is selected, but its name couldn't be loaded right now."
		}
		return "Sending to the list “" + label.Name + "”."
	case CampaignAudienceSegment:
		if label.Name == "" {
			return "A segment is selected, but its name couldn't be loaded right now."
		}
		return "Sending to the segment “" + label.Name + "”."
	default:
		return "No list or segment chosen — this campaign goes to every eligible contact in the workspace."
	}
}
