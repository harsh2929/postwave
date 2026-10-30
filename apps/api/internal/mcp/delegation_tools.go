// SPDX-License-Identifier: AGPL-3.0-only
//
// Handlers for the native write tools (1.3b): create_campaign,
// send_campaign, create_tag, apply_subscriber_tag. Each delegates to a
// domain service via the narrow seams in delegation.go — no SQL is
// duplicated here, so the tools cannot drift from the REST behavior. Each
// guards its seam (nil → clean "not available" error) so a partial wiring
// degrades gracefully instead of panicking.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

func mcpTenantID(ctx context.Context) (string, error) {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok || t == nil {
		return "", errors.New("mcp: no tenant in context")
	}
	return t.ID, nil
}

// ---------------------------------------------------------------------
// create_campaign
// ---------------------------------------------------------------------

type createCampaignInput struct {
	Name        string `json:"name"`
	Subject     string `json:"subject"`
	BodyHTML    string `json:"body_html"`
	PreviewText string `json:"preview_text"`
	FromName    string `json:"from_name"`
	ReplyTo     string `json:"reply_to"`
	SegmentID   string `json:"segment_id"`
	// Decode lifecycle-owned fields only so this legacy tool can reject them
	// explicitly instead of json.Unmarshal silently ignoring them. create_campaign
	// is an authoring tool and always creates a draft.
	ScheduledAt json.RawMessage `json:"scheduled_at"`
	Status      json.RawMessage `json:"status"`
}

func handleCreateCampaign(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignCreate == nil {
		return nil, errors.New("create_campaign is unavailable: the campaigns service is not configured")
	}
	var in createCampaignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if len(in.ScheduledAt) != 0 || len(in.Status) != 0 {
		return nil, errors.New("status and scheduled_at are controlled by campaign lifecycle endpoints; create_campaign only creates drafts")
	}
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Subject) == "" {
		return nil, errors.New("name and subject are required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	// When the agent supplies HTML, prefer the html editor mode so the body
	// renders as authored; otherwise let the repo apply its default. The
	// campaign type is left to the repo default ("regular"): this tool only
	// produces a standard single-step campaign, so it does not advertise the
	// multi-step types (ab_test/rss/automated) it cannot fully construct.
	editorMode := ""
	if strings.TrimSpace(in.BodyHTML) != "" {
		editorMode = "html"
	}
	c, err := d.CampaignCreate.Create(ctx, tenantID, campaigns.CreateInput{
		Name:        in.Name,
		Subject:     in.Subject,
		BodyHTML:    markAgentGeneratedHTML(in.BodyHTML),
		PreviewText: in.PreviewText,
		FromName:    in.FromName,
		ReplyTo:     in.ReplyTo,
		SegmentID:   in.SegmentID,
		EditorMode:  editorMode,
	})
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, errors.New("create_campaign: service returned no campaign")
	}
	return map[string]any{
		"id":            c.ID,
		"name":          c.Name,
		"subject":       c.Subject,
		"status":        c.Status,
		"campaign_type": c.CampaignType,
		"segment_id":    c.SegmentID,
		"scheduled_at":  c.ScheduledAt,
		"created_at":    c.CreatedAt,
	}, nil
}

// ---------------------------------------------------------------------
// send_campaign
// ---------------------------------------------------------------------

type sendCampaignInput struct {
	CampaignID string `json:"campaign_id"`
}

func handleSendCampaign(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignSend == nil {
		return nil, errors.New("send_campaign is unavailable: the campaigns service is not configured")
	}
	var in sendCampaignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(in.CampaignID) == "" {
		return nil, errors.New("campaign_id is required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	// Label the approval/audit actor with who is acting (e.g. api_key/agent)
	// so the send is attributable; the service defaults to "agent" if blank.
	_, actorLabel := middleware.ActorFromContext(ctx)
	res, err := d.CampaignSend.QueueCampaignForAgent(ctx, tenantID, strings.TrimSpace(in.CampaignID), actorLabel)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// ---------------------------------------------------------------------
// create_tag
// ---------------------------------------------------------------------

type createTagInput struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

func handleCreateTag(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.TagCreate == nil {
		return nil, errors.New("create_tag is unavailable: the tags service is not configured")
	}
	var in createTagInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, errors.New("name is required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	t, err := d.TagCreate.Create(ctx, tenantID, tags.CreateInput{
		Name:        strings.TrimSpace(in.Name),
		Color:       in.Color,
		Description: in.Description,
	})
	if err != nil {
		if errors.Is(err, tags.ErrConflict) {
			return nil, fmt.Errorf("a tag named %q already exists", strings.TrimSpace(in.Name))
		}
		return nil, err
	}
	if t == nil {
		return nil, errors.New("create_tag: service returned no tag")
	}
	return map[string]any{
		"id":          t.ID,
		"name":        t.Name,
		"color":       t.Color,
		"description": t.Description,
		"created_at":  t.CreatedAt,
	}, nil
}

// ---------------------------------------------------------------------
// apply_subscriber_tag
// ---------------------------------------------------------------------

type applySubscriberTagInput struct {
	SubscriberID string `json:"subscriber_id"`
	Tag          string `json:"tag"`
}

func handleApplySubscriberTag(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.SubTagApply == nil {
		return nil, errors.New("apply_subscriber_tag is unavailable: the tags service is not configured")
	}
	var in applySubscriberTagInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(in.SubscriberID) == "" || strings.TrimSpace(in.Tag) == "" {
		return nil, errors.New("subscriber_id and tag are required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	// Resolve subscriber id-or-email to the canonical UUID (read-only tx;
	// ApplyByName needs a UUID and opens its own write tx).
	subResult, err := withTenantTx(ctx, d, func(tx pgx.Tx, tid string) (any, error) {
		return mcpResolveSubscriberID(ctx, tx, tid, in.SubscriberID)
	})
	if err != nil {
		return nil, err
	}
	subUUID, ok := subResult.(string)
	if !ok || subUUID == "" {
		return nil, errors.New("could not resolve subscriber")
	}
	tagName := strings.TrimSpace(in.Tag)
	tagID, err := d.SubTagApply.ApplyByName(ctx, tenantID, subUUID, tagName, "", "mcp")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"subscriber_id": subUUID,
		"tag":           tagName,
		"tag_id":        tagID,
		"applied":       true,
	}, nil
}

// ---------------------------------------------------------------------
// upload_asset
// ---------------------------------------------------------------------

// maxUploadBase64Len caps the inbound base64 string before decoding so a
// huge argument can't force a large allocation. ~14 MiB of base64 decodes to
// ~10 MiB of bytes (assets.MaxBytes); ValidateUpload enforces the exact
// decoded ceiling.
const maxUploadBase64Len = 14 * 1024 * 1024

type uploadAssetInput struct {
	Filename      string `json:"filename"`
	Mime          string `json:"mime"`
	ContentBase64 string `json:"content_base64"`
}

func handleUploadAsset(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.AssetUpload == nil {
		return nil, errors.New("upload_asset is unavailable: the asset service is not configured")
	}
	var in uploadAssetInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	raw := strings.TrimSpace(in.ContentBase64)
	if raw == "" {
		return nil, errors.New("content_base64 is required")
	}
	// Accept a data: URI prefix (data:image/png;base64,....) by stripping it.
	if strings.HasPrefix(raw, "data:") {
		if i := strings.IndexByte(raw, ','); i > 0 {
			raw = raw[i+1:]
		}
	}
	if len(raw) > maxUploadBase64Len {
		return nil, errors.New("content_base64 exceeds the maximum size (~10 MiB image)")
	}
	// Use the assets decoder so the tool accepts exactly the alphabets the
	// HTTP upload endpoint does (std/url, padded/unpadded).
	body, err := assets.DecodeBase64(raw)
	if err != nil {
		return nil, errors.New("content_base64 is not valid base64")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	// Validate first so the model gets a precise, model-friendly reason for
	// bad input (derived from the decoded length + a type check — NOT the raw
	// internal sentinel text). After this passes, any UploadBytes error is
	// infra/config and must NOT leak to the model.
	switch {
	case len(body) == 0:
		return nil, errors.New("content_base64 decoded to an empty body")
	case len(body) > assets.MaxBytes:
		return nil, fmt.Errorf("image exceeds the maximum size of %d MiB", assets.MaxBytes/(1024*1024))
	default:
		if _, _, _, verr := assets.ValidateUpload(in.Mime, body); verr != nil {
			return nil, errors.New("not a recognised image (PNG, JPEG, GIF, or WebP required)")
		}
	}
	saved, err := d.AssetUpload.UploadBytes(ctx, tenantID, in.Filename, in.Mime, body)
	if err != nil {
		return nil, errors.New("asset upload failed")
	}
	if saved == nil {
		return nil, errors.New("upload_asset: service returned no asset")
	}
	return map[string]any{
		"id":       saved.ID,
		"url":      saved.URL,
		"filename": saved.Filename,
		"mime":     saved.Mime,
		"width":    saved.Width,
		"height":   saved.Height,
		"bytes":    saved.Bytes,
	}, nil
}

// ---------------------------------------------------------------------
// create_list
// ---------------------------------------------------------------------

type createListInput struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Optin       string   `json:"optin"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
}

func handleCreateList(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.ListCreate == nil {
		return nil, errors.New("create_list is unavailable: the lists service is not configured")
	}
	var in createListInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, errors.New("name is required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	created, err := d.ListCreate.CreateForAgent(ctx, tenantID, lists.CreateListInput{
		Name:        strings.TrimSpace(in.Name),
		Type:        in.Type,
		Optin:       in.Optin,
		Description: in.Description,
		Tags:        in.Tags,
	})
	if err != nil {
		return nil, err
	}
	if created == nil {
		return nil, errors.New("create_list: service returned no list")
	}
	return map[string]any{
		"id":          created.ID,
		"name":        created.Name,
		"type":        created.Type,
		"optin":       created.Optin,
		"description": created.Description,
		"tags":        created.Tags,
	}, nil
}

// markAgentGeneratedHTML applies the EU AI Act Article 50(2) content marking to
// a body an agent wrote.
//
// aicompose already marks its output, with the stated reason that the marking
// "travels with the content (survives editing/sending)". This surface produces
// the same artifact — an email body written by a model and mailed to people —
// and passed it through untouched, so one product had two rules.
//
// Article 50(1), the "you are talking to an AI" notice, is a different
// obligation and is already met by the agent's SSE disclosure frame. A frame on
// a chat stream cannot discharge 50(2): it does not travel with the email.
//
// Empty in, empty out. A subject-only draft must not acquire a body consisting
// of nothing but a comment — the editor would then treat an empty draft as
// having content.
func markAgentGeneratedHTML(html string) string {
	if strings.TrimSpace(html) == "" {
		return html
	}
	return aidisclosure.MarkHTML(html)
}
