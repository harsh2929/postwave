// SPDX-License-Identifier: AGPL-3.0-only

// Command catalogeditablepublish installs reviewed, Postwave-authored MJML
// designs into the shared editable template library. The companion release
// compiler performs asset and review checks before writing the JSONL input.
// The command previews locally by default; --publish requires an operator DB
// credential and records an append-only catalog publication receipt per row.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type releaseRecord struct {
	Slug                string          `json:"slug"`
	Name                string          `json:"name"`
	Description         string          `json:"description"`
	Category            string          `json:"category"`
	Subject             string          `json:"subject"`
	PreviewText         string          `json:"preview_text"`
	BodyMJML            string          `json:"body_mjml"`
	Variables           json.RawMessage `json:"variables"`
	Tags                []string        `json:"tags"`
	TemplateKind        string          `json:"template_kind"`
	SourceProvider      string          `json:"source_provider"`
	SourceExternalID    string          `json:"source_external_id"`
	SourceLicenseStatus string          `json:"source_license_status"`
	ThumbnailURL        string          `json:"thumbnail_url"`
	SourceMetadata      json.RawMessage `json:"source_metadata"`
	DesignMetadata      json.RawMessage `json:"design_metadata"`
	GenerationMetadata  json.RawMessage `json:"generation_metadata"`
	ReviewStatus        string          `json:"review_status"`
	QualityScore        float64         `json:"quality_score"`
	ContentHash         string          `json:"content_hash"`
	Industry            string          `json:"industry"`
	Style               string          `json:"style"`
}

type releaseSource struct {
	InspiredBy struct {
		CatalogID          string `json:"catalog_id"`
		Provider           string `json:"provider"`
		ExternalID         string `json:"external_id"`
		SourceArtifactHash string `json:"source_artifact_hash"`
	} `json:"inspired_by"`
}

type releaseDesign struct {
	VisualMode           string            `json:"visual_mode,omitempty"`
	BackgroundImageKeys  []string          `json:"background_image_keys,omitempty"`
	ImageReferenceCounts map[string]int    `json:"image_reference_counts,omitempty"`
	ImageAssetURLs       map[string]string `json:"image_asset_urls,omitempty"`
	MobilePreviewURL     string            `json:"mobile_preview_url"`
	HasDesktopPreview    bool              `json:"has_desktop_preview"`
	HasMobilePreview     bool              `json:"has_mobile_preview"`
	AssetDigests         map[string]string `json:"asset_digests"`
	Review               struct {
		Reviewer   string          `json:"reviewer"`
		ReviewedAt string          `json:"reviewed_at"`
		Checks     map[string]bool `json:"checks"`
	} `json:"review"`
}

var slugPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`)
var imageSourcePattern = regexp.MustCompile(`<mj-image\b[^>]*\bsrc="([^"]+)"`)
var backgroundSourcePattern = regexp.MustCompile(`\bbackground-url="([^"]+)"`)
var nativeTextImagePattern = regexp.MustCompile(`(?i)<mj-image\b|<img\b|\bbackground-url\s*=`)
var assetDigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var buildMarkerPattern = regexp.MustCompile(`__[A-Z_]+__`)

func validHostedURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" &&
		u.Hostname() != "localhost" && u.Hostname() != "example.com" &&
		!strings.HasSuffix(u.Hostname(), ".invalid") &&
		(ip == nil || (!ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast()))
}

func validate(record releaseRecord) error {
	if !slugPattern.MatchString(record.Slug) || strings.TrimSpace(record.Name) == "" ||
		record.TemplateKind != "editable" || record.SourceProvider != "postwave" ||
		!strings.HasPrefix(record.SourceExternalID, "enhancement:") ||
		record.SourceLicenseStatus != "owned" || record.ReviewStatus != "approved" {
		return errors.New("invalid editable release identity or review state")
	}
	if record.Subject == "" || record.BodyMJML == "" || record.QualityScore <= 0 || record.QualityScore > 1 ||
		buildMarkerPattern.MatchString(record.BodyMJML) {
		return errors.New("incomplete editable content")
	}
	imageSources := imageSourcePattern.FindAllStringSubmatch(record.BodyMJML, -1)
	backgroundSources := backgroundSourcePattern.FindAllStringSubmatch(record.BodyMJML, -1)
	for _, image := range append(imageSources, backgroundSources...) {
		if !validHostedURL(image[1]) {
			return errors.New("editable MJML has a non-hosted image")
		}
	}
	for _, token := range []string{"{{ cta_url }}", "{{ mailing_address }}", "{{unsubscribe_url}}"} {
		if !strings.Contains(record.BodyMJML, token) {
			return fmt.Errorf("required editable token %q is missing", token)
		}
	}
	digest := sha256.Sum256([]byte(record.BodyMJML))
	if record.ContentHash != "sha256:"+hex.EncodeToString(digest[:]) {
		return errors.New("MJML content hash mismatch")
	}
	if !validHostedURL(record.ThumbnailURL) {
		return errors.New("hosted desktop preview URL is required")
	}
	var source releaseSource
	if err := json.Unmarshal(record.SourceMetadata, &source); err != nil {
		return fmt.Errorf("source metadata: %w", err)
	}
	if source.InspiredBy.CatalogID == "" || source.InspiredBy.Provider == "" ||
		source.InspiredBy.ExternalID == "" || source.InspiredBy.SourceArtifactHash == "" ||
		record.SourceExternalID != "enhancement:"+source.InspiredBy.CatalogID {
		return errors.New("source provenance is incomplete or mismatched")
	}
	var design releaseDesign
	if err := json.Unmarshal(record.DesignMetadata, &design); err != nil {
		return fmt.Errorf("design metadata: %w", err)
	}
	if design.VisualMode != "" && design.VisualMode != "generated_images" && design.VisualMode != "native_text" {
		return errors.New("unknown template visual mode")
	}
	nativeText := design.VisualMode == "native_text"
	if nativeText && nativeTextImagePattern.MatchString(record.BodyMJML) {
		return errors.New("native text template contains image markup")
	}
	if !nativeText && len(imageSources)+len(backgroundSources) == 0 {
		return errors.New("hosted image is missing from editable MJML")
	}
	originalImageCount := len(imageSources) + len(backgroundSources)
	if len(design.ImageReferenceCounts) > 0 {
		if nativeText || len(design.ImageReferenceCounts) != len(design.ImageAssetURLs) ||
			len(design.AssetDigests) != len(design.ImageReferenceCounts)+2 {
			return errors.New("reused image declarations are incomplete")
		}
		observed := make(map[string]int)
		for _, image := range append(imageSources, backgroundSources...) {
			observed[image[1]]++
		}
		seen := make(map[string]bool)
		for key, count := range design.ImageReferenceCounts {
			url := design.ImageAssetURLs[key]
			if key == "desktop" || key == "mobile" || count < 1 ||
				!assetDigestPattern.MatchString(design.AssetDigests[key]) ||
				!validHostedURL(url) || seen[url] || observed[url] != count {
				return errors.New("reused image occurrence evidence is inconsistent")
			}
			seen[url] = true
		}
		if len(observed) != len(seen) {
			return errors.New("reused image has an undeclared hosted URL")
		}
		for _, key := range design.BackgroundImageKeys {
			found := false
			for _, background := range backgroundSources {
				found = found || background[1] == design.ImageAssetURLs[key]
			}
			if !found {
				return errors.New("reused background does not match its asset URL")
			}
		}
		originalImageCount = len(design.ImageReferenceCounts)
	} else if len(design.ImageAssetURLs) > 0 {
		return errors.New("image asset URLs require occurrence declarations")
	}
	if !validHostedURL(design.MobilePreviewURL) || !design.HasDesktopPreview ||
		!design.HasMobilePreview || design.Review.Reviewer == "" ||
		len(design.AssetDigests) != originalImageCount+2 ||
		len(design.BackgroundImageKeys) != len(backgroundSources) {
		return errors.New("preview or review evidence is incomplete")
	}
	requiredDigests := []string{"desktop", "mobile"}
	if !nativeText {
		requiredDigests = append(requiredDigests, "hero")
	}
	for _, key := range requiredDigests {
		if !assetDigestPattern.MatchString(design.AssetDigests[key]) {
			return fmt.Errorf("%s digest is missing", key)
		}
	}
	for key, digest := range design.AssetDigests {
		if !assetDigestPattern.MatchString(digest) {
			return fmt.Errorf("%s digest is invalid", key)
		}
	}
	seenBackgrounds := make(map[string]bool)
	for _, key := range design.BackgroundImageKeys {
		if key == "desktop" || key == "mobile" || seenBackgrounds[key] || !assetDigestPattern.MatchString(design.AssetDigests[key]) {
			return errors.New("background image evidence is incomplete or repeated")
		}
		seenBackgrounds[key] = true
	}
	reviewedAt, err := time.Parse(time.RFC3339, design.Review.ReviewedAt)
	if err != nil || reviewedAt.After(time.Now()) {
		return errors.New("review timestamp is missing or invalid")
	}
	for _, check := range []string{"visual", "facts", "rights", "accessibility", "links", "email_clients"} {
		if !design.Review.Checks[check] {
			return fmt.Errorf("review check %q is missing", check)
		}
	}
	return nil
}

func loadRelease(path string) ([]releaseRecord, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	var records []releaseRecord
	seen := make(map[string]bool)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.DisallowUnknownFields()
		var record releaseRecord
		if err := decoder.Decode(&record); err != nil {
			return nil, fmt.Errorf("line %d: %w", len(records)+1, err)
		}
		if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("line %d: extra JSON after record", len(records)+1)
		}
		if err := validate(record); err != nil {
			return nil, fmt.Errorf("line %d: %w", len(records)+1, err)
		}
		if seen[record.SourceExternalID] {
			return nil, fmt.Errorf("duplicate release identity %q", record.SourceExternalID)
		}
		seen[record.SourceExternalID] = true
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, errors.New("release is empty")
	}
	return records, nil
}

func publishOne(ctx context.Context, pool *pgxpool.Pool, record releaseRecord, actor, note string) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var role string
	if err := tx.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil {
		return err
	}
	if role == "postwave_app" {
		return errors.New("runtime database role cannot publish shared templates")
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.catalog_operator', 'true', true)`); err != nil {
		return err
	}
	var existed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM campaign_templates WHERE tenant_id IS NULL
AND source_provider = 'postwave' AND source_external_id = $1)`, record.SourceExternalID).Scan(&existed); err != nil {
		return err
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_templates (
  tenant_id, slug, name, description, category, subject, preview_text,
  body_mjml, variables, tags, template_kind, source_provider,
  source_external_id, source_license_status, thumbnail_url, source_metadata,
  design_metadata, generation_metadata, review_status, quality_score,
  content_hash, industry, style, catalog_published_at
) VALUES (
  NULL, $1, $2, $3, $4, $5, $6,
  $7, $8::jsonb, $9, 'editable', 'postwave',
  $10, 'owned', $11, $12::jsonb,
  $13::jsonb, $14::jsonb, 'approved', $15,
  $16, $17, $18, now()
)
ON CONFLICT (source_provider, source_external_id)
  WHERE tenant_id IS NULL AND source_external_id IS NOT NULL
DO UPDATE SET
  slug = EXCLUDED.slug, name = EXCLUDED.name,
  description = EXCLUDED.description, category = EXCLUDED.category,
  subject = EXCLUDED.subject, preview_text = EXCLUDED.preview_text,
  body_html = '', body_mjml = EXCLUDED.body_mjml,
  variables = EXCLUDED.variables, tags = EXCLUDED.tags,
  thumbnail_url = EXCLUDED.thumbnail_url,
  source_metadata = EXCLUDED.source_metadata,
  design_metadata = EXCLUDED.design_metadata,
  generation_metadata = EXCLUDED.generation_metadata,
  review_status = EXCLUDED.review_status,
  quality_score = EXCLUDED.quality_score,
  content_hash = EXCLUDED.content_hash,
  industry = EXCLUDED.industry, style = EXCLUDED.style,
  catalog_published_at = COALESCE(campaign_templates.catalog_published_at, now()),
  catalog_unpublished_at = NULL
WHERE campaign_templates.template_kind = 'editable'
  AND campaign_templates.source_provider = 'postwave'
  AND campaign_templates.source_metadata->'inspired_by'->>'catalog_id' =
      EXCLUDED.source_metadata->'inspired_by'->>'catalog_id'
RETURNING id::text`,
		record.Slug, record.Name, record.Description, record.Category,
		record.Subject, record.PreviewText, record.BodyMJML,
		string(record.Variables), record.Tags, record.SourceExternalID,
		record.ThumbnailURL, string(record.SourceMetadata),
		string(record.DesignMetadata), string(record.GenerationMetadata),
		record.QualityScore, record.ContentHash, record.Industry, record.Style,
	).Scan(&id)
	if err != nil {
		return fmt.Errorf("upsert shared template: %w", err)
	}
	action := "publish"
	if existed {
		action = "refresh"
	}
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_template_catalog_publications (
  platform_template_id, action, source_provider, source_external_id,
  source_content_hash, actor_id, note
) VALUES ($1::uuid, $2, 'postwave', $3, $4, $5, $6)`,
		id, action, record.SourceExternalID, record.ContentHash, actor, note)
	if err != nil {
		return fmt.Errorf("append publication receipt: %w", err)
	}
	// The original captured reference remains in the database for provenance,
	// while the reviewed editable replacement becomes the visible gallery card.
	// Keep both actions in one transaction so users cannot see two cards if a
	// reference retirement fails.
	var source releaseSource
	if err := json.Unmarshal(record.SourceMetadata, &source); err != nil {
		return err
	}
	var referenceID string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM campaign_templates
 WHERE tenant_id IS NULL AND template_kind = 'reference'
   AND source_provider = $1 AND source_external_id = $2
   AND catalog_published_at IS NOT NULL AND catalog_unpublished_at IS NULL`,
		source.InspiredBy.Provider, source.InspiredBy.ExternalID).Scan(&referenceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("find source reference: %w", err)
	}
	if referenceID != "" {
		var retired bool
		if err := tx.QueryRow(ctx, `SELECT campaign_template_unpublish_reference($1::uuid, $2, $3)`,
			referenceID, actor, note).Scan(&retired); err != nil {
			return fmt.Errorf("retire source reference: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func run(args []string) int {
	flags := flag.NewFlagSet("catalogeditablepublish", flag.ContinueOnError)
	releasePath := flags.String("release", "", "reviewed release JSONL")
	databaseURL := flags.String("database-url", os.Getenv("OPS_DATABASE_URL"), "operator database URL")
	actor := flags.String("actor", "", "operator identity for receipts")
	note := flags.String("note", "", "publication reason for receipts")
	expected := flags.Int("expected-count", 0, "exact expected release row count")
	publish := flags.Bool("publish", false, "write reviewed templates to the shared library")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *releasePath == "" || *expected < 1 {
		fmt.Fprintln(os.Stderr, "catalogeditablepublish: --release and positive --expected-count are required")
		return 2
	}
	records, err := loadRelease(*releasePath)
	if err != nil || len(records) != *expected {
		fmt.Fprintf(os.Stderr, "catalogeditablepublish: release invalid or count mismatch: %v; got %d, expected %d\n", err, len(records), *expected)
		return 1
	}
	fmt.Printf("catalogeditablepublish: validated %d reviewed editable templates\n", len(records))
	if !*publish {
		return 0
	}
	if *databaseURL == "" || strings.TrimSpace(*actor) == "" || strings.TrimSpace(*note) == "" ||
		len(*actor) > 512 || len(*note) > 2000 {
		fmt.Fprintln(os.Stderr, "catalogeditablepublish: operator database URL, actor, and note are required to publish")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, *databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogeditablepublish: connect:", err)
		return 1
	}
	defer pool.Close()
	for index, record := range records {
		if err := publishOne(ctx, pool, record, *actor, *note); err != nil {
			fmt.Fprintf(os.Stderr, "catalogeditablepublish: %s: %v\n", record.SourceExternalID, err)
			return 1
		}
		if (index+1)%100 == 0 || index+1 == len(records) {
			fmt.Printf("catalogeditablepublish: published %d/%d\n", index+1, len(records))
		}
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:])) }
