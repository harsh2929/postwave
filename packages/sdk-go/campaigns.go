package postwave

import (
	"context"
	"net/url"
)

// CampaignsResource is the campaign API (create, queue/send, schedule).
type CampaignsResource struct{ client *Client }

// Campaign is a campaign record (a permissive map of the API shape).
type Campaign = map[string]any

// List returns a page of campaigns. opts are query parameters.
func (r *CampaignsResource) List(ctx context.Context, opts map[string]string) (map[string]any, error) {
	q := url.Values{}
	for k, v := range opts {
		q.Set(k, v)
	}
	path := "/api/v1/campaigns"
	if e := q.Encode(); e != "" {
		path += "?" + e
	}
	out := map[string]any{}
	return out, r.client.request(ctx, "GET", path, nil, &out)
}

// Get fetches one campaign by id.
func (r *CampaignsResource) Get(ctx context.Context, id string) (Campaign, error) {
	out := Campaign{}
	return out, r.client.request(ctx, "GET", "/api/v1/campaigns/"+url.PathEscape(id), nil, &out)
}

// Create drafts a campaign.
func (r *CampaignsResource) Create(ctx context.Context, in map[string]any) (Campaign, error) {
	out := Campaign{}
	return out, r.client.request(ctx, "POST", "/api/v1/campaigns", in, &out)
}

// Update patches a campaign draft.
func (r *CampaignsResource) Update(ctx context.Context, id string, in map[string]any) (Campaign, error) {
	out := Campaign{}
	return out, r.client.request(ctx, "PATCH", "/api/v1/campaigns/"+url.PathEscape(id), in, &out)
}

// Delete removes a campaign draft.
func (r *CampaignsResource) Delete(ctx context.Context, id string) error {
	return r.client.request(ctx, "DELETE", "/api/v1/campaigns/"+url.PathEscape(id), nil, nil)
}

// Send queues a campaign for immediate delivery.
func (r *CampaignsResource) Send(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, r.client.request(ctx, "POST", "/api/v1/campaigns/"+url.PathEscape(id)+"/send", nil, &out)
}

// Schedule queues a campaign to send at the given RFC3339 time.
func (r *CampaignsResource) Schedule(ctx context.Context, id, at string) (map[string]any, error) {
	out := map[string]any{}
	return out, r.client.request(ctx, "POST", "/api/v1/campaigns/"+url.PathEscape(id)+"/schedule",
		map[string]any{"send_at": at}, &out)
}

// AudienceCount previews how many recipients a campaign will reach.
func (r *CampaignsResource) AudienceCount(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, r.client.request(ctx, "GET", "/api/v1/campaigns/"+url.PathEscape(id)+"/audience-count", nil, &out)
}
