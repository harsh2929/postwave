package postwave

import (
	"context"
	"fmt"
	"net/url"
)

// EmailsResource is the transactional email API.
type EmailsResource struct{ client *Client }

// Attachment is one file on a message. Set exactly one of Content (base64) or
// Path (a remote https URL fetched at send time).
type Attachment struct {
	Filename    string `json:"filename"`
	Content     string `json:"content,omitempty"`
	Path        string `json:"path,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	ContentID   string `json:"content_id,omitempty"`
}

// Tag is a per-message key/value label.
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SendEmailInput is the body of a send. One of HTML/Text is required; From
// defaults to the tenant's configured sender when empty.
type SendEmailInput struct {
	From        string            `json:"from,omitempty"`
	To          []string          `json:"to"`
	Cc          []string          `json:"cc,omitempty"`
	Bcc         []string          `json:"bcc,omitempty"`
	ReplyTo     []string          `json:"reply_to,omitempty"`
	Subject     string            `json:"subject"`
	HTML        string            `json:"html,omitempty"`
	Text        string            `json:"text,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	Attachments []Attachment      `json:"attachments,omitempty"`
	ScheduledAt string            `json:"scheduled_at,omitempty"`
}

// SendEmailResult is the response of a send.
type SendEmailResult struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
	Suppressed int    `json:"suppressed,omitempty"`
}

// EmailRecord is a transactional email's status row.
type EmailRecord struct {
	ID                string   `json:"id"`
	From              string   `json:"from"`
	To                []string `json:"to"`
	Subject           string   `json:"subject"`
	Status            string   `json:"status"`
	ProviderMessageID string   `json:"provider_message_id,omitempty"`
	Source            string   `json:"source"`
	CreatedAt         string   `json:"created_at"`
}

// Send sends one transactional email.
func (r *EmailsResource) Send(ctx context.Context, in *SendEmailInput) (*SendEmailResult, error) {
	out := &SendEmailResult{}
	if err := r.client.request(ctx, "POST", "/api/v1/emails", in, out); err != nil {
		return nil, err
	}
	return out, nil
}

// SendBatch sends up to 100 distinct emails in one call.
func (r *EmailsResource) SendBatch(ctx context.Context, emails []SendEmailInput) ([]SendEmailResult, error) {
	var out struct {
		Data []SendEmailResult `json:"data"`
	}
	if err := r.client.request(ctx, "POST", "/api/v1/emails/batch", map[string]any{"emails": emails}, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

// Get fetches one email's status.
func (r *EmailsResource) Get(ctx context.Context, id string) (*EmailRecord, error) {
	out := &EmailRecord{}
	if err := r.client.request(ctx, "GET", "/api/v1/emails/"+url.PathEscape(id), nil, out); err != nil {
		return nil, err
	}
	return out, nil
}

// List returns recent transactional sends.
func (r *EmailsResource) List(ctx context.Context, limit int) ([]EmailRecord, error) {
	path := "/api/v1/emails"
	if limit > 0 {
		path += fmt.Sprintf("?limit=%d", limit)
	}
	var out struct {
		Data []EmailRecord `json:"data"`
	}
	if err := r.client.request(ctx, "GET", path, nil, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}
