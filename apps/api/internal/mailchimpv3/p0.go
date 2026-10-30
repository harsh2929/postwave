package mailchimpv3

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

func (r *Repo) CreateCampaign(ctx context.Context, tenant *middleware.Tenant, in CampaignInput) (*Campaign, error) {
	settings := nonNilMap(in.Settings)
	name := firstNonEmpty(stringValue(settings, "title"), stringValue(settings, "name"), "Untitled campaign")
	subject := stringValue(settings, "subject_line")
	tracking, _ := json.Marshal(nonNilMap(in.Tracking))
	recipients := nonNilMap(in.Recipients)
	segmentID := stringValue(recipients, "saved_segment_id")
	if seg, ok := recipients["segment_opts"].(map[string]any); ok {
		segmentID = firstNonEmpty(segmentID, stringValue(seg, "saved_segment_id"), fmt.Sprint(seg["saved_segment_id"]))
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// editor_mode is 'blocks', not 'template'. campaigns has
	// CHECK (editor_mode IN ('blocks','html','plain_text','mjml')) and has had it
	// since migration 0028 created the table -- 'template' has never been a legal
	// value, so every POST to this endpoint violated the constraint and answered
	// 500. The Mailchimp-compatible campaign create has never once succeeded.
	//
	// 'blocks' is the column's own DEFAULT and matches what this statement
	// already inserts beside it (content_blocks = '[]'::jsonb), so it is the
	// value the row was always shaped for.
	row := tx.QueryRow(ctx, `
INSERT INTO campaigns (
    tenant_id, name, subject, status, campaign_type, editor_mode, segment_id,
    preview_text, from_name, reply_to, content_blocks, reusable_section_ids,
    variants, tracking_settings, delivery_settings
)
VALUES (
    $1::uuid, $2, $3, 'draft', $4, 'blocks', NULLIF($5, '')::uuid,
    NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), '[]'::jsonb, '{}'::uuid[],
    '[]'::jsonb, $9::jsonb, '{}'::jsonb
)
RETURNING `+campaignColumns,
		tenant.ID, name, subject, defaulted(in.Type, "regular"), segmentID,
		stringValue(settings, "preview_text"), stringValue(settings, "from_name"),
		stringValue(settings, "reply_to"), string(tracking))
	c, err := scanCampaign(row, tenant)
	if err != nil {
		return nil, err
	}
	return c, tx.Commit(ctx)
}

const campaignColumns = `id::text, name, subject, status, campaign_type, editor_mode,
       tracking_settings, delivery_settings, COALESCE(segment_id::text, ''), sent_at, created_at, updated_at,
       COALESCE(from_name, ''), COALESCE(reply_to::text, ''), COALESCE(preview_text, '')`

func (r *Repo) UpdateCampaignContent(ctx context.Context, tenant *middleware.Tenant, campaignID string, in CampaignContent) (*CampaignContent, error) {
	blockList := nonNilBlocks(in.Blocks)
	if strings.TrimSpace(in.HTML) == "" && len(blockList) > 0 {
		in.HTML = renderMailchimpBlockHTML(blockList)
	}
	if strings.TrimSpace(in.PlainText) == "" && len(blockList) > 0 {
		in.PlainText = renderMailchimpBlockText(blockList)
	}
	blocks, _ := json.Marshal(blockList)
	mjml := ""
	if in.Template != nil {
		mjml = stringValue(in.Template, "mjml")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The dispatch freeze, in the same terms campaigns.Repo.Update states it:
	// once a campaign has begun sending, what a recipient receives stops
	// changing. sendloop.loadCampaignBodies re-reads body_html inside every
	// batch transaction, so an edit accepted here would put two different emails
	// out under one campaign id — and this is a public compatibility surface, so
	// it is reachable by anyone holding an API key.
	//
	// started_at rather than a status list, because a campaign paused halfway
	// through a send reads 'paused' while some recipients already hold the
	// delivered version.
	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET body_html = NULLIF($3, ''),
       plain_text = NULLIF($4, ''),
       body_mjml = NULLIF($5, ''),
       content_blocks = $6::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND started_at IS NULL
   AND status NOT IN ('sending', 'sent')`,
		tenant.ID, campaignID, in.HTML, in.PlainText, mjml, string(blocks))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		// Distinguish "already sending" from "no such campaign": the first is a
		// state the caller can act on, the second means their id is wrong.
		var dispatching bool
		if qerr := tx.QueryRow(ctx, `
SELECT started_at IS NOT NULL OR status IN ('sending', 'sent')
  FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
			tenant.ID, campaignID).Scan(&dispatching); qerr == nil && dispatching {
			return nil, ErrCampaignDispatching
		}
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.CampaignContent(ctx, tenant, campaignID)
}

func (r *Repo) CampaignAction(ctx context.Context, tenant *middleware.Tenant, campaignID, action string, payload map[string]any) (*CampaignActionResponse, error) {
	// The compatibility action used to write canonical scheduled state without
	// the campaign lifecycle gate, approval semantics, or transactional-send
	// scope. Keep the repository boundary closed as defense in depth until this
	// action delegates to the canonical scheduling lifecycle.
	if action == "schedule" {
		return nil, ErrCampaignSchedulingUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	var status string
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2)`, tenant.ID, campaignID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	switch action {
	case "unschedule", "cancel-send":
		// A campaign that never began dispatching goes back to 'draft'; one that
		// did goes to 'cancelled'.
		//
		// Both used to become 'draft', which after the content freeze produced an
		// inescapable state: the campaign reads 'draft' in every listing, so the
		// operator is shown a fully editable draft, and every edit then returns
		// "this campaign has started sending" — a message contradicting the
		// status in front of them, with no way out. 'cancelled' is what actually
		// happened, and it is a status the UI already renders as terminal.
		if err := tx.QueryRow(ctx, `
UPDATE campaigns
   SET status = CASE WHEN `+campaigndispatch.DispatchedPredicate+`
                     THEN 'cancelled' ELSE 'draft' END,
       scheduled_at = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING status`, tenant.ID, campaignID).Scan(&status); err != nil {
			return nil, err
		}
	default:
		if err := tx.QueryRow(ctx, `SELECT status FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, campaignID).Scan(&status); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CampaignActionResponse{
		ID:        campaignID,
		Status:    mailchimpCampaignStatus(status),
		Action:    action,
		Complete:  true,
		Queued:    action == "send",
		Message:   campaignActionMessage(action),
		Details:   nonNilMap(payload),
		Timestamp: time.Now().UTC(),
	}, nil
}

func (r *Repo) ReplicateCampaign(ctx context.Context, tenant *middleware.Tenant, campaignID string, resend bool) (*Campaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cols, err := cloneableCampaignColumns(ctx, tx)
	if err != nil {
		return nil, err
	}
	quoted := make([]string, 0, len(cols))
	for _, c := range cols {
		quoted = append(quoted, `"`+c+`"`)
	}
	colList := strings.Join(quoted, ", ")
	suffix := " copy"
	if resend {
		suffix = " resend"
	}
	row := tx.QueryRow(ctx, `
INSERT INTO campaigns (
  id, tenant_id, name, status, scheduled_at, sent_at, created_at, updated_at, `+colList+`
)
SELECT gen_random_uuid(), tenant_id, name || $3, 'draft', NULL, NULL, now(), now(), `+colList+`
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING `+campaignColumns, tenant.ID, campaignID, suffix)
	c, err := scanCampaign(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, tx.Commit(ctx)
}

func (r *Repo) ListLandingPages(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*LandingPagesResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, landingPageSelectSQL+`
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	pages, err := scanLandingPages(rows, tenant)
	if err != nil {
		return nil, err
	}
	return &LandingPagesResponse{LandingPages: pages, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) CreateLandingPage(ctx context.Context, tenant *middleware.Tenant, in LandingPageInput) (*LandingPage, error) {
	name := firstNonEmpty(in.Name, in.Title, "Landing page")
	slug := slugify(firstNonEmpty(in.Slug, name))
	status := defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "draft")
	if status != "published" {
		status = "draft"
	}
	blocks, _ := json.Marshal(nonNilBlocks(in.Content))
	seo, _ := json.Marshal(nonNilMap(in.SEO))
	tracking, _ := json.Marshal(nonNilMap(in.Tracking))
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO landing_pages (tenant_id, slug, name, status, domain, template, blocks, seo, tracking)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6, $7::jsonb, $8::jsonb, $9::jsonb)
ON CONFLICT (tenant_id, slug) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  domain = EXCLUDED.domain,
  template = EXCLUDED.template,
  blocks = EXCLUDED.blocks,
  seo = EXCLUDED.seo,
  tracking = EXCLUDED.tracking,
  updated_at = now()
RETURNING `+landingPageColumns,
		tenant.ID, slug, name, status, in.Domain, defaulted(in.Template, "signup"), string(blocks), string(seo), string(tracking))
	lp, err := scanLandingPageV3(row, tenant)
	if err != nil {
		return nil, err
	}
	return lp, tx.Commit(ctx)
}

func (r *Repo) GetLandingPage(ctx context.Context, tenant *middleware.Tenant, pageID string) (*LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, landingPageSelectSQL+`
WHERE tenant_id = $1::uuid AND (id::text = $2 OR slug = $2)`, tenant.ID, pageID)
	lp, err := scanLandingPageV3(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return lp, tx.Commit(ctx)
}

func (r *Repo) LandingPageContent(ctx context.Context, tenant *middleware.Tenant, pageID string) (*LandingPageContent, error) {
	lp, err := r.GetLandingPage(ctx, tenant, pageID)
	if err != nil {
		return nil, err
	}
	return &LandingPageContent{Sections: lp.Content, HTML: landingHTML(lp)}, nil
}

func (r *Repo) UpdateLandingPageContent(ctx context.Context, tenant *middleware.Tenant, pageID string, in LandingPageContent) (*LandingPageContent, error) {
	blocks, _ := json.Marshal(nonNilBlocks(in.Sections))
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE landing_pages
   SET blocks = $3::jsonb, updated_at = now()
 WHERE tenant_id = $1::uuid AND (id::text = $2 OR slug = $2)`, tenant.ID, pageID, string(blocks))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.LandingPageContent(ctx, tenant, pageID)
}

func (r *Repo) SetLandingPageStatus(ctx context.Context, tenant *middleware.Tenant, pageID, status string) (*LandingPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, landingPageSelectSQL+`
WHERE tenant_id = $1::uuid AND (id::text = $2 OR slug = $2)`, tenant.ID, pageID)
	lp, err := scanLandingPageV3(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	row = tx.QueryRow(ctx, `
UPDATE landing_pages
   SET status = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING `+landingPageColumns, tenant.ID, lp.ID, status)
	lp, err = scanLandingPageV3(row, tenant)
	if err != nil {
		return nil, err
	}
	return lp, tx.Commit(ctx)
}

func (r *Repo) ListFileManagerFiles(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*FileManagerFilesResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_assets WHERE tenant_id = $1::uuid AND asset_type <> 'folder'`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, fileSelectSQL+`
WHERE tenant_id = $1::uuid AND asset_type <> 'folder'
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	files, err := scanFiles(rows)
	if err != nil {
		return nil, err
	}
	return &FileManagerFilesResponse{Files: files, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) CreateFileManagerFile(ctx context.Context, tenant *middleware.Tenant, in FileManagerFileInput) (*FileManagerFile, error) {
	url := firstNonEmpty(in.FullSizeURL, in.URL, in.FileData)
	typ := defaulted(strings.ToLower(strings.TrimSpace(in.Type)), "image")
	metadataMap := nonNilMap(in.Metadata)
	metadataMap["folder_id"] = strings.TrimSpace(in.FolderID)
	metadataMap["mailchimp_v3"] = true
	if strings.TrimSpace(in.ThumbnailURL) != "" {
		metadataMap["thumbnail_url"] = strings.TrimSpace(in.ThumbnailURL)
	}
	if in.Size > 0 {
		metadataMap["size"] = in.Size
	}
	if len(in.Tags) > 0 {
		metadataMap["tags"] = normalizeStringSlice(in.Tags)
	}
	metadata, _ := json.Marshal(metadataMap)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO campaign_assets (tenant_id, name, asset_type, url, alt_text, metadata)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::jsonb)
RETURNING `+fileColumns, tenant.ID, defaulted(in.Name, "Uploaded file"), typ, url, strings.TrimSpace(in.AltText), string(metadata))
	f, err := scanFile(row)
	if err != nil {
		return nil, err
	}
	return f, tx.Commit(ctx)
}

func (r *Repo) GetFileManagerFile(ctx context.Context, tenant *middleware.Tenant, fileID string) (*FileManagerFile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, fileSelectSQL+` WHERE tenant_id = $1::uuid AND id::text = $2 AND asset_type <> 'folder'`, tenant.ID, fileID)
	f, err := scanFile(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, tx.Commit(ctx)
}

func (r *Repo) DeleteFileManagerFile(ctx context.Context, tenant *middleware.Tenant, fileID string) error {
	return deleteTenantRow(ctx, r.Pool, tenant.ID, `DELETE FROM campaign_assets WHERE tenant_id = $1::uuid AND id::text = $2 AND asset_type <> 'folder'`, fileID)
}

func (r *Repo) ListFileManagerFolders(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*FileManagerFoldersResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, folderSelectSQL+`
WHERE tenant_id = $1::uuid AND asset_type = 'folder'
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	folders, err := scanFolders(rows)
	if err != nil {
		return nil, err
	}
	folders = append([]FileManagerFolder{rootFolder()}, folders...)
	return &FileManagerFoldersResponse{Folders: folders, TotalItems: len(folders)}, tx.Commit(ctx)
}

func (r *Repo) CreateFileManagerFolder(ctx context.Context, tenant *middleware.Tenant, in FileManagerFolderInput) (*FileManagerFolder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO campaign_assets (tenant_id, name, asset_type, url, metadata)
VALUES ($1::uuid, $2, 'folder', $3, '{}'::jsonb)
RETURNING `+folderColumns, tenant.ID, defaulted(in.Name, "Folder"), "folder://"+stableID(in.Name))
	f, err := scanFolder(row)
	if err != nil {
		return nil, err
	}
	return f, tx.Commit(ctx)
}

func (r *Repo) GetFileManagerFolder(ctx context.Context, tenant *middleware.Tenant, folderID string) (*FileManagerFolder, error) {
	if folderID == "" || folderID == "0" || folderID == "root" {
		f := rootFolder()
		return &f, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, folderSelectSQL+` WHERE tenant_id = $1::uuid AND id::text = $2 AND asset_type = 'folder'`, tenant.ID, folderID)
	f, err := scanFolder(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, tx.Commit(ctx)
}

func (r *Repo) DeleteFileManagerFolder(ctx context.Context, tenant *middleware.Tenant, folderID string) error {
	if folderID == "" || folderID == "0" || folderID == "root" {
		return nil
	}
	return deleteTenantRow(ctx, r.Pool, tenant.ID, `DELETE FROM campaign_assets WHERE tenant_id = $1::uuid AND id::text = $2 AND asset_type = 'folder'`, folderID)
}

func (r *Repo) ListEcommerceProducts(ctx context.Context, tenant *middleware.Tenant, storeID string, offset, count int) (*EcommerceProductsResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_products WHERE tenant_id = $1::uuid AND integration_id::text = $2`, tenant.ID, storeID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, productSelectSQL+`
WHERE tenant_id = $1::uuid AND integration_id::text = $2
ORDER BY updated_at DESC
LIMIT $3 OFFSET $4`, tenant.ID, storeID, count, offset)
	if err != nil {
		return nil, err
	}
	products, err := scanProductsV3(rows)
	if err != nil {
		return nil, err
	}
	return &EcommerceProductsResponse{Products: products, StoreID: storeID, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) UpsertEcommerceProduct(ctx context.Context, tenant *middleware.Tenant, storeID, productID string, in EcommerceProductInput) (*EcommerceProduct, error) {
	sourceID := firstNonEmpty(productID, in.ID, stableID(in.Title))
	variant := firstVariant(in)
	raw, _ := json.Marshal(nonNilMap(map[string]any{
		"description": in.Description,
		"type":        in.Type,
		"vendor":      in.Vendor,
		"variants":    in.Variants,
	}))
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title, url, image_url, price_cents, currency, raw)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, 'USD', $8::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  url = EXCLUDED.url,
  image_url = EXCLUDED.image_url,
  price_cents = EXCLUDED.price_cents,
  raw = EXCLUDED.raw,
  updated_at = now()
RETURNING `+productColumns,
		tenant.ID, storeID, sourceID, defaulted(in.Title, sourceID), firstNonEmpty(in.URL, in.Handle),
		in.ImageURL, int(variant.Price*100), string(raw))
	p, err := scanProductV3(row)
	if err != nil {
		return nil, err
	}
	return p, tx.Commit(ctx)
}

func (r *Repo) GetEcommerceProduct(ctx context.Context, tenant *middleware.Tenant, storeID, productID string) (*EcommerceProduct, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, productSelectSQL+`
WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND (source_id = $3 OR id::text = $3)`, tenant.ID, storeID, productID)
	p, err := scanProductV3(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return p, tx.Commit(ctx)
}

func (r *Repo) DeleteEcommerceProduct(ctx context.Context, tenant *middleware.Tenant, storeID, productID string) error {
	return deleteTenantStoreRow(ctx, r.Pool, tenant.ID, storeID, `DELETE FROM commerce_products WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND (source_id = $3 OR id::text = $3)`, productID)
}

func (r *Repo) ListEcommerceOrders(ctx context.Context, tenant *middleware.Tenant, storeID string, offset, count int) (*EcommerceOrdersResponse, error) {
	orders, total, err := r.listOrdersByStatus(ctx, tenant, storeID, offset, count, false)
	if err != nil {
		return nil, err
	}
	return &EcommerceOrdersResponse{Orders: orders, StoreID: storeID, TotalItems: total}, nil
}

func (r *Repo) UpsertEcommerceOrder(ctx context.Context, tenant *middleware.Tenant, storeID, orderID string, in EcommerceOrderInput) (*EcommerceOrder, error) {
	sourceID := firstNonEmpty(orderID, in.ID, stableID(in.CustomerEmail+time.Now().UTC().String()))
	return r.upsertOrderLike(ctx, tenant, storeID, sourceID, in, "paid")
}

func (r *Repo) GetEcommerceOrder(ctx context.Context, tenant *middleware.Tenant, storeID, orderID string) (*EcommerceOrder, error) {
	return r.getOrderLike(ctx, tenant, storeID, orderID, false)
}

func (r *Repo) DeleteEcommerceOrder(ctx context.Context, tenant *middleware.Tenant, storeID, orderID string) error {
	return deleteTenantStoreRow(ctx, r.Pool, tenant.ID, storeID, `DELETE FROM commerce_orders WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND status <> 'cart' AND (source_id = $3 OR id::text = $3)`, orderID)
}

func (r *Repo) ListEcommerceCarts(ctx context.Context, tenant *middleware.Tenant, storeID string, offset, count int) (*EcommerceCartsResponse, error) {
	orders, total, err := r.listOrdersByStatus(ctx, tenant, storeID, offset, count, true)
	if err != nil {
		return nil, err
	}
	carts := make([]EcommerceCart, 0, len(orders))
	for _, o := range orders {
		carts = append(carts, cartFromOrder(o))
	}
	return &EcommerceCartsResponse{Carts: carts, StoreID: storeID, TotalItems: total}, nil
}

func (r *Repo) UpsertEcommerceCart(ctx context.Context, tenant *middleware.Tenant, storeID, cartID string, in EcommerceCartInput) (*EcommerceCart, error) {
	orderIn := EcommerceOrderInput{
		ID:              firstNonEmpty(cartID, in.ID),
		Customer:        in.Customer,
		CustomerEmail:   in.CustomerEmail,
		FinancialStatus: "cart",
		CurrencyCode:    in.CurrencyCode,
		OrderTotal:      in.OrderTotal,
		Lines:           in.Lines,
	}
	if orderIn.Customer == nil {
		orderIn.Customer = map[string]any{}
	}
	orderIn.Customer["checkout_url"] = in.CheckoutURL
	order, err := r.upsertOrderLike(ctx, tenant, storeID, firstNonEmpty(cartID, in.ID, stableID(in.CustomerEmail+time.Now().UTC().String())), orderIn, "cart")
	if err != nil {
		return nil, err
	}
	cart := cartFromOrder(*order)
	return &cart, nil
}

func (r *Repo) GetEcommerceCart(ctx context.Context, tenant *middleware.Tenant, storeID, cartID string) (*EcommerceCart, error) {
	order, err := r.getOrderLike(ctx, tenant, storeID, cartID, true)
	if err != nil {
		return nil, err
	}
	cart := cartFromOrder(*order)
	return &cart, nil
}

func (r *Repo) DeleteEcommerceCart(ctx context.Context, tenant *middleware.Tenant, storeID, cartID string) error {
	return deleteTenantStoreRow(ctx, r.Pool, tenant.ID, storeID, `DELETE FROM commerce_orders WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND status = 'cart' AND (source_id = $3 OR id::text = $3)`, cartID)
}

func (r *Repo) ListEcommercePromoRules(ctx context.Context, tenant *middleware.Tenant, storeID string, offset, count int) (*EcommercePromoRulesResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM discounts WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, promoSelectSQL+` WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	rules, err := scanPromoRules(rows)
	if err != nil {
		return nil, err
	}
	return &EcommercePromoRulesResponse{PromoRules: rules, StoreID: storeID, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) UpsertEcommercePromoRule(ctx context.Context, tenant *middleware.Tenant, storeID, ruleID string, in EcommercePromoRuleInput) (*EcommercePromoRule, error) {
	code := strings.ToUpper(strings.TrimSpace(firstNonEmpty(ruleID, in.ID, in.Title)))
	if code == "" {
		code = strings.ToUpper(stableID(time.Now().UTC().String()))
	}
	typ := defaulted(strings.ToLower(strings.TrimSpace(in.Type)), "fixed")
	var percent any
	var amount any
	if typ == "percentage" || typ == "percent" {
		v := int(in.Amount)
		if v <= 0 {
			v = 1
		}
		percent = v
		typ = "percentage"
	} else {
		v := int(in.Amount * 100)
		if v <= 0 {
			v = 1
		}
		amount = v
		typ = "fixed"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO discounts (tenant_id, code, percent_off, amount_off_cents, currency, expires_at, applies_to)
VALUES ($1::uuid, $2, $3, $4, 'usd', $5, 'both')
ON CONFLICT (tenant_id, code) DO UPDATE SET
  percent_off = EXCLUDED.percent_off,
  amount_off_cents = EXCLUDED.amount_off_cents,
  expires_at = EXCLUDED.expires_at
RETURNING `+promoColumns, tenant.ID, code, percent, amount, in.EndsAt)
	rule, err := scanPromoRule(row)
	if err != nil {
		return nil, err
	}
	rule.Title = firstNonEmpty(in.Title, rule.Title)
	rule.Description = in.Description
	rule.Type = typ
	rule.Target = defaulted(in.Target, "total")
	rule.Enabled = in.Enabled || !in.Enabled && in.Title == ""
	return rule, tx.Commit(ctx)
}

func (r *Repo) GetEcommercePromoRule(ctx context.Context, tenant *middleware.Tenant, storeID, ruleID string) (*EcommercePromoRule, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, promoSelectSQL+` WHERE tenant_id = $1::uuid AND code = $2`, tenant.ID, strings.ToUpper(ruleID))
	rule, err := scanPromoRule(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return rule, tx.Commit(ctx)
}

func (r *Repo) DeleteEcommercePromoRule(ctx context.Context, tenant *middleware.Tenant, storeID, ruleID string) error {
	return deleteTenantStoreRow(ctx, r.Pool, tenant.ID, storeID, `DELETE FROM discounts WHERE tenant_id = $1::uuid AND $2 <> '' AND code = $3`, strings.ToUpper(ruleID))
}

func (r *Repo) listOrdersByStatus(ctx context.Context, tenant *middleware.Tenant, storeID string, offset, count int, carts bool) ([]EcommerceOrder, int, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, 0, err
	}
	op := "<>"
	if carts {
		op = "="
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_orders WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND status `+op+` 'cart'`, tenant.ID, storeID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.Query(ctx, orderSelectSQL+`
WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND status `+op+` 'cart'
ORDER BY ordered_at DESC
LIMIT $3 OFFSET $4`, tenant.ID, storeID, count, offset)
	if err != nil {
		return nil, 0, err
	}
	orders, err := scanOrdersV3(rows)
	if err != nil {
		return nil, 0, err
	}
	return orders, total, tx.Commit(ctx)
}

func (r *Repo) upsertOrderLike(ctx context.Context, tenant *middleware.Tenant, storeID, sourceID string, in EcommerceOrderInput, fallbackStatus string) (*EcommerceOrder, error) {
	at := in.ProcessedAt
	if at == nil {
		now := time.Now().UTC()
		at = &now
	}
	status := defaulted(strings.ToLower(strings.TrimSpace(in.FinancialStatus)), fallbackStatus)
	customerEmail := firstNonEmpty(in.CustomerEmail, stringValue(in.Customer, "email"))
	currency := defaulted(strings.ToUpper(strings.TrimSpace(in.CurrencyCode)), "USD")
	attribution, _ := json.Marshal(nonNilMap(in.Customer))
	lines, _ := json.Marshal(nonNilBlocks(in.Lines))
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_orders (
    tenant_id, integration_id, source_id, customer_email, status, subtotal_cents,
    discount_cents, shipping_cents, tax_cents, total_cents, currency, campaign_id,
    attribution, line_items, ordered_at, raw
)
VALUES (
    $1::uuid, $2::uuid, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11,
    NULLIF($12, '')::uuid, $13::jsonb, $14::jsonb, $15, '{}'::jsonb
)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  customer_email = EXCLUDED.customer_email,
  status = EXCLUDED.status,
  subtotal_cents = EXCLUDED.subtotal_cents,
  discount_cents = EXCLUDED.discount_cents,
  shipping_cents = EXCLUDED.shipping_cents,
  tax_cents = EXCLUDED.tax_cents,
  total_cents = EXCLUDED.total_cents,
  currency = EXCLUDED.currency,
  campaign_id = EXCLUDED.campaign_id,
  attribution = EXCLUDED.attribution,
  line_items = EXCLUDED.line_items,
  ordered_at = EXCLUDED.ordered_at,
  updated_at = now()
RETURNING `+orderColumns,
		tenant.ID, storeID, sourceID, customerEmail, status, int(in.OrderTotal*100),
		int(in.DiscountTotal*100), int(in.ShippingTotal*100), int(in.TaxTotal*100),
		int(in.OrderTotal*100), currency, in.CampaignID, string(attribution), string(lines), at)
	order, err := scanOrderV3(row)
	if err != nil {
		return nil, err
	}
	return order, tx.Commit(ctx)
}

func (r *Repo) getOrderLike(ctx context.Context, tenant *middleware.Tenant, storeID, orderID string, cart bool) (*EcommerceOrder, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenant.ID, storeID); err != nil {
		return nil, err
	}
	op := "<>"
	if cart {
		op = "="
	}
	row := tx.QueryRow(ctx, orderSelectSQL+`
WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND status `+op+` 'cart' AND (source_id = $3 OR id::text = $3)`, tenant.ID, storeID, orderID)
	order, err := scanOrderV3(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return order, tx.Commit(ctx)
}

const landingPageSelectSQL = `SELECT ` + landingPageColumns + ` FROM landing_pages `
const landingPageColumns = `id::text, slug::text, name, status, COALESCE(domain, ''), template, blocks, seo, tracking, created_at, updated_at`

const fileSelectSQL = `SELECT ` + fileColumns + ` FROM campaign_assets `
const fileColumns = `id::text, name, asset_type, url, COALESCE(alt_text, ''), metadata, created_at, updated_at`

const folderSelectSQL = `SELECT ` + folderColumns + ` FROM campaign_assets `
const folderColumns = `id::text, name, created_at, updated_at,
       (SELECT count(*) FROM campaign_assets f WHERE f.tenant_id = campaign_assets.tenant_id AND f.metadata->>'folder_id' = campaign_assets.id::text)`

const productSelectSQL = `SELECT ` + productColumns + ` FROM commerce_products `
const productColumns = `id::text, source_id, title, COALESCE(url, ''), COALESCE(image_url, ''), price_cents, currency, raw, created_at, updated_at`

const orderSelectSQL = `SELECT ` + orderColumns + ` FROM commerce_orders `
const orderColumns = `id::text, source_id, COALESCE(customer_email::text, ''), status,
       subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
       currency, COALESCE(campaign_id::text, ''), attribution, line_items, ordered_at,
       created_at, updated_at`

const promoSelectSQL = `SELECT ` + promoColumns + ` FROM discounts`
const promoColumns = `id::text, code, percent_off, amount_off_cents, currency, max_redemptions, times_redeemed, expires_at, created_at`

func scanLandingPages(rows pgx.Rows, tenant *middleware.Tenant) ([]LandingPage, error) {
	defer rows.Close()
	out := []LandingPage{}
	for rows.Next() {
		lp, err := scanLandingPageV3(rows, tenant)
		if err != nil {
			return nil, err
		}
		out = append(out, *lp)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanLandingPageV3(row memberScanner, tenant *middleware.Tenant) (*LandingPage, error) {
	var lp LandingPage
	var slug, domain, template string
	var blocksRaw, seoRaw, trackingRaw []byte
	if err := row.Scan(&lp.ID, &slug, &lp.Name, &lp.Status, &domain, &template, &blocksRaw, &seoRaw, &trackingRaw, &lp.DateCreated, &lp.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(blocksRaw, &lp.Content)
	_ = json.Unmarshal(trackingRaw, &lp.Tracking)
	seo := map[string]any{}
	_ = json.Unmarshal(seoRaw, &seo)
	if lp.Content == nil {
		lp.Content = []map[string]any{}
	}
	if lp.Tracking == nil {
		lp.Tracking = map[string]any{}
	}
	lp.WebID = stableTagID(lp.ID)
	lp.Title = firstNonEmpty(fmt.Sprint(seo["title"]), lp.Name)
	lp.URL = landingURL(domain, slug)
	lp.ListID = tenant.Slug
	lp.TemplateID = stableTagID(template)
	lp.Settings = map[string]any{"slug": slug, "template": template, "domain": domain, "seo": seo}
	lp.CreatedBy = "postwave"
	return &lp, nil
}

func scanFiles(rows pgx.Rows) ([]FileManagerFile, error) {
	defer rows.Close()
	out := []FileManagerFile{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

func scanFile(row memberScanner) (*FileManagerFile, error) {
	var f FileManagerFile
	var metadataRaw []byte
	if err := row.Scan(&f.ID, &f.Name, &f.Type, &f.FullSizeURL, &f.AltText, &metadataRaw, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return nil, err
	}
	metadata := map[string]any{}
	_ = json.Unmarshal(metadataRaw, &metadata)
	f.FolderID = firstNonEmpty(fmt.Sprint(metadata["folder_id"]), "0")
	f.ThumbnailURL = firstNonEmpty(fmt.Sprint(metadata["thumbnail_url"]), f.FullSizeURL)
	f.Metadata = metadata
	f.Tags = stringsFromAny(metadata["tags"])
	if size, ok := metadata["size"].(float64); ok {
		f.Size = int(size)
	}
	return &f, nil
}

func scanFolders(rows pgx.Rows) ([]FileManagerFolder, error) {
	defer rows.Close()
	out := []FileManagerFolder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

func scanFolder(row memberScanner) (*FileManagerFolder, error) {
	var f FileManagerFolder
	if err := row.Scan(&f.ID, &f.Name, &f.CreatedAt, &f.UpdatedAt, &f.FileCount); err != nil {
		return nil, err
	}
	return &f, nil
}

func scanProductsV3(rows pgx.Rows) ([]EcommerceProduct, error) {
	defer rows.Close()
	out := []EcommerceProduct{}
	for rows.Next() {
		p, err := scanProductV3(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func scanProductV3(row memberScanner) (*EcommerceProduct, error) {
	var internalID, currency string
	var priceCents int
	var raw []byte
	var p EcommerceProduct
	if err := row.Scan(&internalID, &p.ID, &p.Title, &p.URL, &p.ImageURL, &priceCents, &currency, &raw, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	meta := map[string]any{}
	_ = json.Unmarshal(raw, &meta)
	p.Description = stringValue(meta, "description")
	p.Type = stringValue(meta, "type")
	p.Vendor = stringValue(meta, "vendor")
	p.Handle = p.URL
	if variants, ok := meta["variants"].([]any); ok {
		for _, rawVariant := range variants {
			if m, ok := rawVariant.(map[string]any); ok {
				p.Variants = append(p.Variants, EcommerceVariant{
					ID:        firstNonEmpty(stringValue(m, "id"), p.ID),
					Title:     firstNonEmpty(stringValue(m, "title"), p.Title),
					SKU:       stringValue(m, "sku"),
					URL:       p.URL,
					Price:     floatValue(m, "price"),
					CreatedAt: p.CreatedAt,
					UpdatedAt: p.UpdatedAt,
				})
			}
		}
	}
	if len(p.Variants) == 0 {
		p.Variants = []EcommerceVariant{{
			ID:        p.ID,
			Title:     p.Title,
			URL:       p.URL,
			Price:     float64(priceCents) / 100,
			CreatedAt: p.CreatedAt,
			UpdatedAt: p.UpdatedAt,
		}}
	}
	_ = internalID
	_ = currency
	return &p, nil
}

func scanOrdersV3(rows pgx.Rows) ([]EcommerceOrder, error) {
	defer rows.Close()
	out := []EcommerceOrder{}
	for rows.Next() {
		o, err := scanOrderV3(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *o)
	}
	return out, rows.Err()
}

func scanOrderV3(row memberScanner) (*EcommerceOrder, error) {
	var internalID, customerEmail string
	var subtotalCents, discountCents, shippingCents, taxCents, totalCents int
	var customerRaw, linesRaw []byte
	var o EcommerceOrder
	if err := row.Scan(&internalID, &o.ID, &customerEmail, &o.FinancialStatus, &subtotalCents, &discountCents, &shippingCents, &taxCents, &totalCents, &o.CurrencyCode, &o.CampaignID, &customerRaw, &linesRaw, &o.ProcessedAt, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(customerRaw, &o.Customer)
	_ = json.Unmarshal(linesRaw, &o.Lines)
	if o.Customer == nil {
		o.Customer = map[string]any{}
	}
	if customerEmail != "" {
		o.Customer["email_address"] = customerEmail
	}
	if o.Lines == nil {
		o.Lines = []map[string]any{}
	}
	o.OrderTotal = float64(totalCents) / 100
	o.TaxTotal = float64(taxCents) / 100
	o.ShippingTotal = float64(shippingCents) / 100
	o.DiscountTotal = float64(discountCents) / 100
	_ = internalID
	_ = subtotalCents
	return &o, nil
}

func scanPromoRules(rows pgx.Rows) ([]EcommercePromoRule, error) {
	defer rows.Close()
	out := []EcommercePromoRule{}
	for rows.Next() {
		rule, err := scanPromoRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rule)
	}
	return out, rows.Err()
}

func scanPromoRule(row memberScanner) (*EcommercePromoRule, error) {
	var internalID, code, currency string
	var percentOff, amountOffCents, maxRedemptions *int
	var timesRedeemed int
	var expiresAt *time.Time
	var createdAt time.Time
	if err := row.Scan(&internalID, &code, &percentOff, &amountOffCents, &currency, &maxRedemptions, &timesRedeemed, &expiresAt, &createdAt); err != nil {
		return nil, err
	}
	rule := &EcommercePromoRule{
		ID:        code,
		Title:     code,
		Target:    "total",
		Enabled:   true,
		EndsAt:    expiresAt,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
	if percentOff != nil {
		rule.Type = "percentage"
		rule.Amount = float64(*percentOff)
	} else if amountOffCents != nil {
		rule.Type = "fixed"
		rule.Amount = float64(*amountOffCents) / 100
	} else {
		rule.Type = "fixed"
	}
	_ = internalID
	_ = currency
	_ = maxRedemptions
	_ = timesRedeemed
	return rule, nil
}

func ensureStore(ctx context.Context, tx pgx.Tx, tenantID, storeID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM commerce_integrations WHERE tenant_id = $1::uuid AND id::text = $2)`, tenantID, storeID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func deleteTenantRow(ctx context.Context, pool *db.Pool, tenantID, q, id string) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, q, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func deleteTenantStoreRow(ctx context.Context, pool *db.Pool, tenantID, storeID, q, id string) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureStore(ctx, tx, tenantID, storeID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, q, tenantID, storeID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func cloneableCampaignColumns(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'campaigns'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// started_at and finished_at are facts about the SOURCE's dispatch. A replica
	// that inherits them is born frozen — every content edit refused, forever,
	// since the stamp is monotonic and replicating again copies it forward. That
	// makes this path the worst place to get it wrong: "duplicate it to send a
	// revised version" is the remedy the freeze itself recommends.
	skip := map[string]bool{
		"id": true, "tenant_id": true, "name": true, "status": true,
		"scheduled_at": true, "sent_at": true, "created_at": true, "updated_at": true,
		"finished_at": true, "started_at": true, "claimed_at": true,
	}
	cols := []string{}
	for rows.Next() {
		var col string
		if err := rows.Scan(&col); err != nil {
			return nil, err
		}
		if !skip[col] {
			cols = append(cols, col)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(cols)
	return cols, nil
}

func parseMailchimpTime(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "<nil>" {
		return nil, nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc, nil
		}
	}
	return nil, fmt.Errorf("invalid schedule_time")
}

func campaignActionMessage(action string) string {
	switch action {
	case "send":
		return "Accepted by the Mailchimp-compatible facade; delivery is handled by Moosewave send orchestration."
	case "test":
		return "Test send accepted as a compatibility no-op."
	case "schedule":
		return "Campaign scheduled."
	case "unschedule":
		return "Campaign returned to draft."
	case "cancel-send":
		return "Pending send cancellation accepted."
	default:
		return "Action accepted."
	}
}

func landingURL(domain, slug string) string {
	if strings.TrimSpace(domain) != "" {
		return strings.TrimRight(domain, "/") + "/" + slug
	}
	return "/api/public/landing-pages/" + slug
}

func landingHTML(lp *LandingPage) string {
	b, _ := json.Marshal(lp.Content)
	return string(b)
}

func rootFolder() FileManagerFolder {
	return FileManagerFolder{ID: "0", Name: "root", CreatedAt: time.Time{}, UpdatedAt: time.Time{}}
}

func cartFromOrder(o EcommerceOrder) EcommerceCart {
	return EcommerceCart{
		ID:           o.ID,
		Customer:     o.Customer,
		CheckoutURL:  stringValue(o.Customer, "checkout_url"),
		CurrencyCode: o.CurrencyCode,
		OrderTotal:   o.OrderTotal,
		Lines:        o.Lines,
		CreatedAt:    o.CreatedAt,
		UpdatedAt:    o.UpdatedAt,
	}
}

func firstVariant(in EcommerceProductInput) EcommerceVariant {
	if len(in.Variants) > 0 {
		return in.Variants[0]
	}
	return EcommerceVariant{ID: firstNonEmpty(in.ID, stableID(in.Title)), Title: in.Title}
}

func nonNilBlocks(blocks []map[string]any) []map[string]any {
	if blocks == nil {
		return []map[string]any{}
	}
	return blocks
}

func renderMailchimpBlockHTML(blocks []map[string]any) string {
	var b strings.Builder
	for _, block := range blocks {
		kind := strings.ToLower(firstNonEmpty(stringValue(block, "type"), stringValue(block, "id"), stringValue(block, "block_type")))
		switch kind {
		case "heading", "title":
			b.WriteString("<h2>")
			b.WriteString(html.EscapeString(firstNonEmpty(stringValue(block, "content"), stringValue(block, "text"), stringValue(block, "title"))))
			b.WriteString("</h2>")
		case "image":
			url := html.EscapeString(firstNonEmpty(stringValue(block, "url"), stringValue(block, "src")))
			alt := html.EscapeString(firstNonEmpty(stringValue(block, "alt"), stringValue(block, "alt_text")))
			if url != "" {
				b.WriteString(`<img src="` + url + `" alt="` + alt + `" style="max-width:100%;height:auto;">`)
			}
		case "button":
			label := html.EscapeString(firstNonEmpty(stringValue(block, "label"), stringValue(block, "text"), "Learn more"))
			url := html.EscapeString(firstNonEmpty(stringValue(block, "url"), stringValue(block, "href"), "#"))
			b.WriteString(`<p><a href="` + url + `" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:4px;">` + label + `</a></p>`)
		case "video":
			converted := convertVideoForEmail(VideoConvertInput{
				URL:          firstNonEmpty(stringValue(block, "video_url"), stringValue(block, "url")),
				ThumbnailURL: stringValue(block, "thumbnail_url"),
				Title:        firstNonEmpty(stringValue(block, "title"), "Watch video"),
				AltText:      firstNonEmpty(stringValue(block, "alt_text"), "Video thumbnail"),
				CTA:          firstNonEmpty(stringValue(block, "cta"), "Watch video"),
			})
			b.WriteString(converted.EmailHTML)
		case "product_recommendations", "product", "products":
			b.WriteString("<section><h3>")
			b.WriteString(html.EscapeString(firstNonEmpty(stringValue(block, "title"), "Recommended for you")))
			b.WriteString("</h3>")
			products, _ := block["products"].([]any)
			if len(products) == 0 {
				b.WriteString("<p>*|PRODUCT_RECOMMENDATIONS|*</p>")
			}
			for _, item := range products {
				product := asCompatMap(item)
				name := html.EscapeString(firstNonEmpty(stringValue(product, "title"), stringValue(product, "name"), "Product"))
				url := html.EscapeString(firstNonEmpty(stringValue(product, "url"), stringValue(product, "product_url"), "#"))
				price := html.EscapeString(firstNonEmpty(stringValue(product, "price"), stringValue(product, "price_text")))
				b.WriteString(`<p><a href="` + url + `">` + name + `</a>`)
				if price != "" {
					b.WriteString(" " + price)
				}
				b.WriteString("</p>")
			}
			b.WriteString("</section>")
		case "discount_code", "promo_code":
			code := html.EscapeString(firstNonEmpty(stringValue(block, "code"), "*|PROMO_CODE|*"))
			desc := html.EscapeString(firstNonEmpty(stringValue(block, "description"), "Use this code at checkout."))
			b.WriteString(`<p><strong>` + code + `</strong><br>` + desc + `</p>`)
		case "rss":
			b.WriteString("<section><h3>")
			b.WriteString(html.EscapeString(firstNonEmpty(stringValue(block, "title"), "Latest updates")))
			b.WriteString("</h3><p>*|RSSITEMS:|*</p></section>")
		case "survey":
			question := html.EscapeString(firstNonEmpty(stringValue(block, "question"), "Tell us what you think"))
			b.WriteString("<section><p>" + question + "</p><p>*|POLL|*</p></section>")
		case "dynamic_content", "conditional_content":
			condition := strings.TrimSpace(stringValue(block, "condition"))
			content := firstNonEmpty(stringValue(block, "content"), stringValue(block, "html"))
			fallback := stringValue(block, "fallback")
			if condition != "" {
				b.WriteString("*|IF:" + html.EscapeString(condition) + "|*")
			}
			b.WriteString(contentOrParagraph(content))
			if fallback != "" {
				b.WriteString("*|ELSE:|*")
				b.WriteString(contentOrParagraph(fallback))
			}
			if condition != "" {
				b.WriteString("*|END:IF|*")
			}
		case "html":
			b.WriteString(stringValue(block, "html"))
		default:
			b.WriteString(contentOrParagraph(firstNonEmpty(stringValue(block, "content"), stringValue(block, "text"), stringValue(block, "body"))))
		}
	}
	return b.String()
}

func renderMailchimpBlockText(blocks []map[string]any) string {
	lines := make([]string, 0, len(blocks))
	for _, block := range blocks {
		for _, key := range []string{"title", "heading", "content", "text", "body", "label", "question"} {
			if value := stringValue(block, key); value != "" {
				lines = append(lines, value)
				break
			}
		}
	}
	return strings.Join(lines, "\n\n")
}

func contentOrParagraph(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.Contains(value, "<") && strings.Contains(value, ">") {
		return value
	}
	return "<p>" + html.EscapeString(value) + "</p>"
}

func asCompatMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func stringValue(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func floatValue(m map[string]any, key string) float64 {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	default:
		return 0
	}
}

func stableID(s string) string {
	sum := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(s))))
	return hex.EncodeToString(sum[:])
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	dash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
