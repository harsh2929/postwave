package postwave

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var campaignPollStableReference = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var campaignPollOpaqueCursor = regexp.MustCompile(`^[A-Za-z0-9._-]{1,512}$`)

// CampaignPollMaterializationInput selects one poll from an exact immutable
// semantic-v2 revision. Question and option content are intentionally absent.
type CampaignPollMaterializationInput struct {
	ContentRevisionID string     `json:"content_revision_id"`
	PollKey           string     `json:"poll_key"`
	TwoStepRequired   *bool      `json:"two_step_required,omitempty"`
	ClosesAt          *time.Time `json:"closes_at,omitempty"`
}

// CampaignPollDefinitionOption is one immutable semantic option.
type CampaignPollDefinitionOption struct {
	OptionKey string `json:"option_key"`
	Label     string `json:"label"`
	Position  int    `json:"position"`
}

// CampaignPollDefinition is an immutable response contract projected from a
// campaign AST. It contains no tenant or recipient identity.
type CampaignPollDefinition struct {
	ID              string                         `json:"id"`
	CampaignID      string                         `json:"campaign_id"`
	PollKey         string                         `json:"poll_key"`
	Question        string                         `json:"question"`
	TwoStepRequired bool                           `json:"two_step_required"`
	ClosesAt        *time.Time                     `json:"closes_at,omitempty"`
	Options         []CampaignPollDefinitionOption `json:"options"`
	CreatedAt       time.Time                      `json:"created_at"`
}

// CampaignPollList is the campaign-scoped definition collection.
type CampaignPollList struct {
	Items      []CampaignPollDefinition `json:"items"`
	NextCursor string                   `json:"next_cursor,omitempty"`
}

// CampaignPollListOptions selects one bounded keyset page. A zero Limit uses
// the API default of 100. Cursor must be copied exactly from NextCursor.
type CampaignPollListOptions struct {
	Limit  int
	Cursor string
}

// CampaignPollOptionTally contains only explicitly human-classified,
// uncontaminated confirmations.
type CampaignPollOptionTally struct {
	OptionKey string `json:"option_key"`
	Label     string `json:"label"`
	Counted   int    `json:"counted"`
}

// CampaignPollTally keeps every excluded population separate. In particular,
// unknown classifier output never becomes human activity.
type CampaignPollTally struct {
	PollID               string                    `json:"poll_id"`
	PollKey              string                    `json:"poll_key"`
	Question             string                    `json:"question"`
	Options              []CampaignPollOptionTally `json:"options"`
	MachineExcluded      int                       `json:"machine_excluded"`
	UnclassifiedExcluded int                       `json:"unclassified_excluded"`
	VoidedMultiOption    int                       `json:"voided_multi_option"`
	PreviewedOnly        int                       `json:"previewed_only"`
}

// CampaignPollsResource exposes authenticated campaign authoring and aggregate
// report operations. Recipient-facing signed links are intentionally not SDK
// methods.
type CampaignPollsResource struct{ client *Client }

// Materialize projects one existing semantic poll into the response store.
func (r *CampaignPollsResource) Materialize(
	ctx context.Context,
	campaignID string,
	input *CampaignPollMaterializationInput,
) (*CampaignPollDefinition, error) {
	if r == nil || r.client == nil {
		return nil, fmt.Errorf("postwave: campaign polls client is unavailable")
	}
	campaignID = strings.TrimSpace(campaignID)
	if campaignID == "" {
		return nil, fmt.Errorf("postwave: campaign poll campaign ID is required")
	}
	if input == nil {
		return nil, fmt.Errorf("postwave: campaign poll materialization input is required")
	}
	if strings.TrimSpace(input.ContentRevisionID) == "" {
		return nil, fmt.Errorf("postwave: campaign poll content revision ID is required")
	}
	if !campaignPollStableReference.MatchString(input.PollKey) {
		return nil, fmt.Errorf("postwave: campaign poll key must be a 1-128 byte stable ASCII reference")
	}
	var out CampaignPollDefinition
	err := r.client.request(ctx, "POST",
		"/api/v1/campaigns/"+url.PathEscape(campaignID)+"/polls", input, &out)
	return &out, err
}

// List returns immutable poll definitions owned by one campaign.
func (r *CampaignPollsResource) List(
	ctx context.Context,
	campaignID string,
	options ...CampaignPollListOptions,
) (*CampaignPollList, error) {
	if r == nil || r.client == nil {
		return nil, fmt.Errorf("postwave: campaign polls client is unavailable")
	}
	campaignID = strings.TrimSpace(campaignID)
	if campaignID == "" {
		return nil, fmt.Errorf("postwave: campaign poll campaign ID is required")
	}
	if len(options) > 1 {
		return nil, fmt.Errorf("postwave: campaign poll list accepts at most one options value")
	}
	var input CampaignPollListOptions
	if len(options) == 1 {
		input = options[0]
	}
	if input.Limit < 0 || input.Limit > 100 {
		return nil, fmt.Errorf("postwave: campaign poll list limit must be an integer from 1 to 100")
	}
	if input.Cursor != "" && !campaignPollOpaqueCursor.MatchString(input.Cursor) {
		return nil, fmt.Errorf("postwave: campaign poll list cursor must be a 1-512 byte opaque ASCII cursor")
	}
	query := url.Values{}
	if input.Limit != 0 {
		if input.Limit < 1 {
			return nil, fmt.Errorf("postwave: campaign poll list limit must be an integer from 1 to 100")
		}
		query.Set("limit", fmt.Sprintf("%d", input.Limit))
	}
	if input.Cursor != "" {
		query.Set("cursor", input.Cursor)
	}
	path := "/api/v1/campaigns/" + url.PathEscape(campaignID) + "/polls"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out CampaignPollList
	err := r.client.request(ctx, "GET", path, nil, &out)
	return &out, err
}

// Tally returns counted votes and all excluded populations.
func (r *CampaignPollsResource) Tally(
	ctx context.Context,
	campaignID, pollKey string,
) (*CampaignPollTally, error) {
	if r == nil || r.client == nil {
		return nil, fmt.Errorf("postwave: campaign polls client is unavailable")
	}
	campaignID = strings.TrimSpace(campaignID)
	if campaignID == "" {
		return nil, fmt.Errorf("postwave: campaign poll campaign ID is required")
	}
	if !campaignPollStableReference.MatchString(pollKey) {
		return nil, fmt.Errorf("postwave: campaign poll key must be a 1-128 byte stable ASCII reference")
	}
	var out CampaignPollTally
	err := r.client.request(ctx, "GET", "/api/v1/campaigns/"+
		url.PathEscape(campaignID)+"/polls/"+url.PathEscape(pollKey)+"/tally", nil, &out)
	return &out, err
}
