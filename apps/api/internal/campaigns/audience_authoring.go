// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

// audience_authoring.go — who a campaign is addressed to, as an authoring
// field. Every reader (ResolveCampaignAudience, send-preview, the checklist,
// queue-fill, the audience fingerprint) already understood a list audience;
// what was missing was a way to set, change and clear one after create. This
// file holds the write-side rules those readers rely on: the stored list id is
// always the tenant-owned engine id, and a frozen (static) audience cannot be
// re-pointed behind its snapshot's back.

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ErrAudienceFrozen means the request would change the list or segment of a
// campaign whose audience is a frozen snapshot.
//
// A static campaign sends to the membership captured when it was frozen, not
// to its list or segment, so accepting the change would leave the campaign
// naming one audience while delivering to another. The caller either switches
// the campaign back to a dynamic audience in the same request
// (audience_mode:"dynamic") or duplicates it.
var ErrAudienceFrozen = errors.New("campaign: audience is frozen to a snapshot")

// campaignAudienceSnapshot is the audience half of a campaign row, captured
// before a patch is applied so the write can tell what the patch changed.
type campaignAudienceSnapshot struct {
	ListID    string
	SegmentID string
	Mode      string
}

func campaignAudienceOf(c *Campaign) campaignAudienceSnapshot {
	return campaignAudienceSnapshot{
		ListID:    strings.TrimSpace(c.ListID),
		SegmentID: strings.TrimSpace(c.SegmentID),
		Mode:      strings.TrimSpace(c.AudienceMode),
	}
}

// resolveUpdatedAudience finishes the audience half of Repo.Update inside the
// write transaction, after the patch has been applied to cur.
//
// A list the caller named is resolved through the tenant's list_id_map and
// stored as its engine id, so a uuid spelling of the same list is not a
// change and a list another tenant owns is ErrAudienceListNotFound. An
// unchanged list is not re-resolved: clients send the whole audience on every
// save, and a list that has since disappeared must not block an unrelated
// edit — the checklist and queue-fill already fail closed on it.
func resolveUpdatedAudience(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	cur *Campaign,
	before campaignAudienceSnapshot,
	in UpdateInput,
) error {
	if in.ListID != nil && cur.ListID != "" && cur.ListID != before.ListID {
		list, err := resolveOwnedCampaignList(ctx, tx, tenantID, cur.ListID)
		if err != nil {
			return err
		}
		cur.ListID = list.StoredListID()
	}
	after := campaignAudienceOf(cur)
	if after.ListID == before.ListID && after.SegmentID == before.SegmentID {
		return nil
	}
	// The mode the row will hold after this write. audience_mode is written as
	// COALESCE(NULLIF($mode, ''), audience_mode), so an empty value keeps it.
	mode := before.Mode
	if in.AudienceMode != nil {
		if requested := strings.TrimSpace(*in.AudienceMode); requested != "" {
			mode = requested
		}
	}
	if strings.EqualFold(mode, "static") {
		return ErrAudienceFrozen
	}
	return nil
}

// writeCampaignAudienceError maps the audience failures a campaign write can
// raise onto the same stable codes queue admission uses, so a client handles
// "that list is gone" identically whether it surfaced on save or on send.
// It reports whether it wrote a response.
func writeCampaignAudienceError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, ErrAudienceFrozen) {
		// 409, not 422: the request is well-formed and would be accepted on a
		// campaign with a live audience. What blocks it is this campaign's
		// state, and the remedy is a different request, not a corrected field.
		writeJSON(w, http.StatusConflict, errEnv("audience_frozen",
			"This campaign's audience is frozen to a snapshot, so its list or segment can't change. Duplicate the campaign to send to a different audience."))
		return true
	}
	qe := queueAudienceError(err)
	if qe.Status != http.StatusUnprocessableEntity {
		return false
	}
	writeJSON(w, qe.Status, errEnv(qe.Code, qe.Message))
	return true
}

// audienceListNotFoundMessage is the one sentence every surface shows when a
// campaign names a list this workspace does not have — on save, and on send.
// It deliberately does not distinguish "deleted" from "never yours": telling
// the two apart would confirm another tenant's list id exists.
const audienceListNotFoundMessage = "The selected list isn't available as an audience in this workspace. Choose another list or segment."

// audienceSegmentNotFoundMessage is its segment counterpart: the campaign
// names a segment this workspace does not have (deleted, or never its own).
const audienceSegmentNotFoundMessage = "The selected segment no longer exists. Choose another list or segment."

// frozenAudienceMissingMessage is what a frozen campaign whose snapshot is
// gone says. The snapshot cannot be retaken — freezing is one-way — so the
// only remedy is a new campaign.
const frozenAudienceMissingMessage = "This campaign's frozen audience snapshot is missing, so it can't be sent. Duplicate the campaign to choose its audience again."
