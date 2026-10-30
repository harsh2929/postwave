package postwave

import (
	"context"
	"net/url"
)

// SegmentsResource is the segment API.
type SegmentsResource struct{ client *Client }

// Segment is a segment record.
type Segment = map[string]any

// List returns every segment (paginated via opts).
func (r *SegmentsResource) List(ctx context.Context, opts map[string]string) (map[string]any, error) {
	q := url.Values{}
	for k, v := range opts {
		q.Set(k, v)
	}
	path := "/api/v1/segments"
	if e := q.Encode(); e != "" {
		path += "?" + e
	}
	out := map[string]any{}
	return out, r.client.request(ctx, "GET", path, nil, &out)
}

// Get fetches one segment by id.
func (r *SegmentsResource) Get(ctx context.Context, id string) (Segment, error) {
	out := Segment{}
	return out, r.client.request(ctx, "GET", "/api/v1/segments/"+url.PathEscape(id), nil, &out)
}

// Create defines a segment.
func (r *SegmentsResource) Create(ctx context.Context, in map[string]any) (Segment, error) {
	out := Segment{}
	return out, r.client.request(ctx, "POST", "/api/v1/segments", in, &out)
}

// Delete removes a segment.
func (r *SegmentsResource) Delete(ctx context.Context, id string) error {
	return r.client.request(ctx, "DELETE", "/api/v1/segments/"+url.PathEscape(id), nil, nil)
}
