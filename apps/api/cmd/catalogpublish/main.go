// SPDX-License-Identifier: AGPL-3.0-only
//
// Command catalogpublish is the privileged, auditable bridge between a
// tenant's bounded reference import and Moosewave's shared inspiration gallery.
//
// It deliberately does not scrape or ingest. Use
// scripts/rge-newsletter-ingest.mjs to import the checked-in catalog through
// the normal tenant API first, then run this command with the migrator/operator
// database credential. Runtime postwave_app credentials cannot execute the
// publication function.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
)

type options struct {
	databaseURL       string
	tenantID          string
	provider          string
	actorID           string
	note              string
	inventoryManifest string
	expectedCount     int
	approveAdaptation bool
	publish           bool
	reconcileStale    bool
	dryRun            bool
	timeout           time.Duration
}

type inventoryManifest struct {
	SchemaVersion string `json:"schema_version"`
	Source        struct {
		Provider string `json:"provider"`
	} `json:"source"`
	Harvest struct {
		Complete             *bool `json:"complete"`
		PaginationExhausted  *bool `json:"pagination_exhausted"`
		TemplateCount        *int  `json:"template_count"`
		SourceTotal          *int  `json:"source_total"`
		SourceTotalAtCapture *int  `json:"source_total_at_capture"`
	} `json:"harvest"`
	Templates     []inventoryIdentity `json:"templates"`
	identities    []string
	contentHashes map[string]string
}

type inventoryIdentity struct {
	SourceProvider   string `json:"source_provider"`
	SourceExternalID string `json:"source_external_id"`
	ContentHash      string `json:"content_hash"`
}

type sourceReference struct {
	ID                string
	ExternalID        string
	Name              string
	ContentHash       string
	BodyHash          string
	ReviewStatus      string
	AdaptationAllowed bool
	NeedsPublication  bool
}

type platformReference struct {
	ID         string
	ExternalID string
	Name       string
}

type catalogDB interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

const (
	inventoryManifestSchema   = "postwave.campaign-template-reference-manifest.v1"
	maxInventoryManifestBytes = 64 << 20
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	opts, err := parseOptions(args, os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish:", err)
		return 2
	}
	inventory, err := loadInventoryManifest(
		opts.inventoryManifest,
		opts.provider,
		opts.expectedCount,
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish: inventory manifest:", err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, opts.databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish: connect:", err)
		return 1
	}
	defer pool.Close()

	var canPublish, canUnpublish bool
	if err := pool.QueryRow(ctx, `
SELECT has_function_privilege(
    current_user,
    'campaign_template_publish_reference(uuid,uuid,text,text)',
    'EXECUTE'
),
has_function_privilege(
    current_user,
    'campaign_template_unpublish_reference(uuid,text,text)',
    'EXECUTE'
)`).Scan(&canPublish, &canUnpublish); err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish: inspect operator privilege:", err)
		return 1
	}
	if opts.publish && !canPublish {
		fmt.Fprintln(os.Stderr,
			"catalogpublish: current database role is not the privileged catalog operator")
		return 1
	}
	if opts.reconcileStale && !opts.dryRun && !canUnpublish {
		fmt.Fprintln(os.Stderr,
			"catalogpublish: current database role cannot reconcile stale catalog references")
		return 1
	}

	references, err := loadReferences(
		ctx,
		pool,
		opts,
		inventory.identities,
		inventory.contentHashes,
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish: load references:", err)
		return 1
	}
	stale, err := loadStaleReferences(ctx, pool, opts.provider, inventory.identities)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish: load stale shared references:", err)
		return 1
	}

	pending, publicationNeeded := 0, 0
	for _, reference := range references {
		if reference.ReviewStatus != "approved" || !reference.AdaptationAllowed {
			pending++
		}
		if reference.NeedsPublication {
			publicationNeeded++
		}
	}
	fmt.Printf(
		"catalogpublish: verified %d references (%d need adaptation review, %d need publish/refresh)\n",
		len(references), pending, publicationNeeded,
	)
	reportStaleReferences(stale, opts.reconcileStale)
	if opts.dryRun {
		return 0
	}
	if err := validateStaleMutation(opts, stale); err != nil {
		fmt.Fprintln(os.Stderr, "catalogpublish:", err)
		return 1
	}
	if opts.publish && pending > 0 && !opts.approveAdaptation {
		fmt.Fprintln(os.Stderr,
			"catalogpublish: pending references remain; rerun with --approve-adaptation after operator review")
		return 1
	}

	if opts.reconcileStale {
		if err := reconcileStaleReferences(ctx, pool, stale, opts.actorID, opts.note); err != nil {
			fmt.Fprintln(os.Stderr, "catalogpublish: reconcile stale references:", err)
			return 1
		}
	}

	repo := &campaigntemplates.Repo{Pool: pool}
	actor := campaigntemplates.ReferenceReviewActor{
		Type: "service", ID: opts.actorID, Label: "Catalog operator",
	}
	reviewed, published, skipped := 0, 0, 0
	for index := range references {
		reference := &references[index]
		if opts.approveAdaptation &&
			(reference.ReviewStatus != "approved" || !reference.AdaptationAllowed) {
			_, err := repo.ReviewReference(
				ctx,
				opts.tenantID,
				reference.ID,
				campaigntemplates.ReferenceReviewDecisionInput{
					Decision:          "approve",
					AdaptationAllowed: true,
					DirectUseAllowed:  false,
					Note:              opts.note,
				},
				actor,
			)
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"catalogpublish: review %s (%s): %v\n",
					reference.ID, reference.ExternalID, err)
				return 1
			}
			reviewed++
			reference.NeedsPublication = true
		}
		if !opts.publish || !reference.NeedsPublication {
			skipped++
			continue
		}
		var platformID string
		if err := pool.QueryRow(ctx, `
SELECT campaign_template_publish_reference(
    $1::uuid, $2::uuid, $3, $4
)::text`,
			opts.tenantID, reference.ID, opts.actorID, opts.note,
		).Scan(&platformID); err != nil {
			fmt.Fprintf(os.Stderr,
				"catalogpublish: publish %s (%s): %v\n",
				reference.ID, reference.ExternalID, err)
			return 1
		}
		published++
		if published%100 == 0 || index == len(references)-1 {
			fmt.Printf(
				"catalogpublish: published/refreshed %d; processed %d of %d current references\n",
				published, index+1, len(references),
			)
		}
	}
	fmt.Printf(
		"catalogpublish: complete: %d reviewed, %d published/refreshed, %d unchanged\n",
		reviewed, published, skipped,
	)
	return 0
}

func parseOptions(args []string, env func(string) string) (options, error) {
	if env == nil {
		env = os.Getenv
	}
	var opts options
	flags := flag.NewFlagSet("catalogpublish", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&opts.databaseURL, "database-url",
		strings.TrimSpace(env("POSTWAVE_CATALOG_DATABASE_URL")),
		"privileged catalog-operator Postgres URL (or POSTWAVE_CATALOG_DATABASE_URL)")
	flags.StringVar(&opts.tenantID, "tenant", "", "source tenant UUID")
	flags.StringVar(&opts.provider, "provider", "really_good_emails",
		"exact external source provider")
	flags.StringVar(&opts.actorID, "actor", "", "stable operator/service identity")
	flags.StringVar(&opts.note, "note", "",
		"required rights/publication review note")
	flags.StringVar(&opts.inventoryManifest, "inventory-manifest", "",
		"required HTML-free complete source inventory manifest JSON")
	flags.IntVar(&opts.expectedCount, "expected-count", 0,
		"exact manifest inventory count required before changes")
	flags.BoolVar(&opts.approveAdaptation, "approve-adaptation", false,
		"append adaptation-only approval receipts for pending references")
	flags.BoolVar(&opts.publish, "publish", false,
		"publish or refresh reviewed references into the shared gallery")
	flags.BoolVar(&opts.reconcileStale, "reconcile-stale", false,
		"unpublish active shared provider references absent from the manifest")
	flags.BoolVar(&opts.dryRun, "dry-run", false,
		"verify counts and report work without mutation")
	flags.DurationVar(&opts.timeout, "timeout", 30*time.Minute,
		"overall operation deadline")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, errors.New("unexpected positional arguments")
	}
	if opts.databaseURL == "" {
		return options{}, errors.New(
			"--database-url or POSTWAVE_CATALOG_DATABASE_URL is required")
	}
	parsedTenant, err := uuid.Parse(strings.TrimSpace(opts.tenantID))
	if err != nil || parsedTenant == uuid.Nil {
		return options{}, errors.New("--tenant must be a non-zero UUID")
	}
	opts.tenantID = parsedTenant.String()
	opts.provider = strings.ToLower(strings.TrimSpace(opts.provider))
	if opts.provider == "" || opts.provider == "postwave" {
		return options{}, errors.New("--provider must name an external provider")
	}
	opts.actorID = strings.TrimSpace(opts.actorID)
	opts.note = strings.TrimSpace(opts.note)
	if len(opts.actorID) < 1 || len(opts.actorID) > 512 {
		return options{}, errors.New("--actor must contain 1 to 512 characters")
	}
	if len(opts.note) < 1 || len(opts.note) > 2000 {
		return options{}, errors.New("--note must contain 1 to 2000 characters")
	}
	opts.inventoryManifest = strings.TrimSpace(opts.inventoryManifest)
	if opts.inventoryManifest == "" {
		return options{}, errors.New("--inventory-manifest is required")
	}
	if opts.expectedCount < 1 || opts.expectedCount > 10000 {
		return options{}, errors.New("--expected-count must be between 1 and 10000")
	}
	if opts.timeout <= 0 || opts.timeout > 6*time.Hour {
		return options{}, errors.New("--timeout must be greater than zero and at most 6h")
	}
	if !opts.dryRun && !opts.approveAdaptation && !opts.publish && !opts.reconcileStale {
		return options{}, errors.New(
			"choose --dry-run, --approve-adaptation, --publish, or --reconcile-stale")
	}
	return opts, nil
}

func loadInventoryManifest(
	path string,
	expectedProvider string,
	expectedCount int,
) (inventoryManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return inventoryManifest{}, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return inventoryManifest{}, err
	}
	if !info.Mode().IsRegular() {
		return inventoryManifest{}, errors.New("path must identify a regular file")
	}
	if info.Size() < 1 {
		return inventoryManifest{}, errors.New("manifest is empty")
	}
	if info.Size() > maxInventoryManifestBytes {
		return inventoryManifest{}, fmt.Errorf(
			"manifest is %d bytes; maximum is %d",
			info.Size(),
			maxInventoryManifestBytes,
		)
	}
	payload, err := io.ReadAll(io.LimitReader(file, maxInventoryManifestBytes+1))
	if err != nil {
		return inventoryManifest{}, err
	}
	if len(payload) > maxInventoryManifestBytes {
		return inventoryManifest{}, fmt.Errorf(
			"manifest exceeded %d bytes while being read",
			maxInventoryManifestBytes,
		)
	}
	var raw any
	if err := json.Unmarshal(payload, &raw); err != nil {
		return inventoryManifest{}, fmt.Errorf("decode JSON: %w", err)
	}
	if err := validateManifestEnvelope(raw); err != nil {
		return inventoryManifest{}, err
	}
	var manifest inventoryManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return inventoryManifest{}, fmt.Errorf("decode inventory fields: %w", err)
	}
	if manifest.SchemaVersion != inventoryManifestSchema {
		return inventoryManifest{}, fmt.Errorf(
			"schema_version must be %q",
			inventoryManifestSchema,
		)
	}
	if manifest.Source.Provider != expectedProvider {
		return inventoryManifest{}, fmt.Errorf(
			"source.provider %q does not exactly match --provider %q",
			manifest.Source.Provider,
			expectedProvider,
		)
	}
	if manifest.Harvest.Complete == nil || !*manifest.Harvest.Complete {
		return inventoryManifest{}, errors.New("harvest.complete must be true")
	}
	if manifest.Harvest.PaginationExhausted == nil ||
		!*manifest.Harvest.PaginationExhausted {
		return inventoryManifest{},
			errors.New("harvest.pagination_exhausted must be true")
	}
	if manifest.Harvest.TemplateCount == nil {
		return inventoryManifest{}, errors.New("harvest.template_count is required")
	}
	sourceTotal, err := manifestSourceTotal(manifest)
	if err != nil {
		return inventoryManifest{}, err
	}
	if *manifest.Harvest.TemplateCount != sourceTotal ||
		sourceTotal != expectedCount ||
		len(manifest.Templates) != expectedCount {
		return inventoryManifest{}, fmt.Errorf(
			"inventory counts disagree: harvest.template_count=%d, "+
				"harvest.source_total=%d, templates=%d, --expected-count=%d",
			*manifest.Harvest.TemplateCount,
			sourceTotal,
			len(manifest.Templates),
			expectedCount,
		)
	}
	seen := make(map[string]struct{}, expectedCount)
	identities := make([]string, 0, expectedCount)
	contentHashes := make(map[string]string, expectedCount)
	for index, identity := range manifest.Templates {
		if identity.SourceProvider != expectedProvider {
			return inventoryManifest{}, fmt.Errorf(
				"templates[%d].source_provider %q does not exactly match --provider %q",
				index,
				identity.SourceProvider,
				expectedProvider,
			)
		}
		externalID := identity.SourceExternalID
		if externalID == "" || externalID != strings.TrimSpace(externalID) {
			return inventoryManifest{}, fmt.Errorf(
				"templates[%d].source_external_id must be non-empty and whitespace-normalized",
				index,
			)
		}
		if _, duplicate := seen[externalID]; duplicate {
			return inventoryManifest{}, fmt.Errorf(
				"duplicate source_external_id %q in inventory manifest",
				externalID,
			)
		}
		if !isSHA256(identity.ContentHash) {
			return inventoryManifest{}, fmt.Errorf(
				"templates[%d].content_hash must be a lowercase sha256 digest",
				index,
			)
		}
		seen[externalID] = struct{}{}
		identities = append(identities, externalID)
		contentHashes[externalID] = identity.ContentHash
	}
	sort.Strings(identities)
	manifest.identities = identities
	manifest.contentHashes = contentHashes
	return manifest, nil
}

func isSHA256(value string) bool {
	const prefix = "sha256:"
	if !strings.HasPrefix(value, prefix) || len(value) != len(prefix)+64 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, prefix))
	return err == nil
}

func bodyHTMLHash(bodyHTML string) string {
	digest := sha256.Sum256([]byte(bodyHTML))
	return fmt.Sprintf("sha256:%x", digest)
}

func manifestSourceTotal(manifest inventoryManifest) (int, error) {
	total := manifest.Harvest.SourceTotal
	captured := manifest.Harvest.SourceTotalAtCapture
	if total == nil && captured == nil {
		return 0, errors.New(
			"harvest.source_total or harvest.source_total_at_capture is required",
		)
	}
	if total != nil && captured != nil && *total != *captured {
		return 0, fmt.Errorf(
			"harvest.source_total=%d disagrees with "+
				"harvest.source_total_at_capture=%d",
			*total,
			*captured,
		)
	}
	if total != nil {
		return *total, nil
	}
	return *captured, nil
}

func validateManifestEnvelope(raw any) error {
	root, ok := raw.(map[string]any)
	if !ok {
		return errors.New("manifest root must be a JSON object")
	}
	allowed := map[string]struct{}{
		"schema_version": {},
		"generated_at":   {},
		"artifact":       {},
		"source":         {},
		"harvest":        {},
		"templates":      {},
	}
	for key := range root {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unexpected top-level manifest field %q", key)
		}
	}
	for _, required := range []string{
		"schema_version", "source", "harvest", "templates",
	} {
		if _, ok := root[required]; !ok {
			return fmt.Errorf("manifest field %q is required", required)
		}
	}
	return validateHTMLFreeJSON(raw, "$")
}

func validateHTMLFreeJSON(value any, path string) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			normalized := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
			if normalized == "html" ||
				normalized == "mjml" ||
				normalized == "markup" ||
				strings.HasSuffix(normalized, "_html") ||
				strings.HasSuffix(normalized, "_mjml") {
				return fmt.Errorf(
					"manifest must be HTML-free; content field %s.%s is forbidden",
					path,
					key,
				)
			}
			if err := validateHTMLFreeJSON(nested, path+"."+key); err != nil {
				return err
			}
		}
	case []any:
		for index, nested := range typed {
			if err := validateHTMLFreeJSON(
				nested,
				fmt.Sprintf("%s[%d]", path, index),
			); err != nil {
				return err
			}
		}
	case string:
		lower := strings.ToLower(typed)
		for _, marker := range []string{
			"<!doctype html", "<html", "<head", "<body", "<style",
			"<table", "<tbody", "<tr", "<td", "<div", "<span", "<img",
			"<a ", "<p>", "<p ", "<mjml",
		} {
			if strings.Contains(lower, marker) {
				return fmt.Errorf(
					"manifest must be HTML-free; markup found at %s",
					path,
				)
			}
		}
	}
	return nil
}

func loadReferences(
	ctx context.Context,
	db catalogDB,
	opts options,
	identities []string,
	contentHashes map[string]string,
) ([]sourceReference, error) {
	rows, err := db.Query(ctx, `
SELECT source.id::text,
       source.source_external_id,
       source.name,
       source.content_hash,
       source.body_html,
       source.review_status,
       source.reference_adaptation_allowed,
       (
           platform.id IS NULL
           OR platform.content_hash IS DISTINCT FROM source.content_hash
           OR platform.name IS DISTINCT FROM source.name
           OR platform.description IS DISTINCT FROM source.description
           OR platform.category IS DISTINCT FROM source.category
           OR platform.goal IS DISTINCT FROM source.goal
           OR platform.subject IS DISTINCT FROM source.subject
           OR platform.preview_text IS DISTINCT FROM source.preview_text
           OR platform.variables IS DISTINCT FROM source.variables
           OR platform.tags IS DISTINCT FROM source.tags
           OR platform.source_url IS DISTINCT FROM source.source_url
           OR platform.source_brand IS DISTINCT FROM source.source_brand
           OR platform.thumbnail_url IS DISTINCT FROM source.thumbnail_url
           OR platform.source_captured_at IS DISTINCT FROM source.source_captured_at
           OR platform.source_license_status IS DISTINCT FROM source.source_license_status
           OR (
               platform.source_metadata - 'published_from_tenant_template_id'
           ) IS DISTINCT FROM source.source_metadata
           OR platform.industry IS DISTINCT FROM source.industry
           OR platform.style IS DISTINCT FROM source.style
           OR platform.layout IS DISTINCT FROM source.layout
           OR platform.design_metadata IS DISTINCT FROM source.design_metadata
           OR platform.quality_score IS DISTINCT FROM source.quality_score
           OR platform.catalog_published_at IS NULL
           OR platform.catalog_unpublished_at IS NOT NULL
       ) AS needs_publication
  FROM campaign_templates AS source
  LEFT JOIN campaign_templates AS platform
    ON platform.tenant_id IS NULL
   AND platform.source_provider = source.source_provider
   AND platform.source_external_id = source.source_external_id
 WHERE source.tenant_id = $1::uuid
   AND source.template_kind = 'reference'
   AND source.source_provider = $2
   AND source.source_external_id = ANY($3::text[])
 ORDER BY source.source_external_id, source.id`,
		opts.tenantID, opts.provider, identities)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	references := make([]sourceReference, 0, opts.expectedCount)
	for rows.Next() {
		var reference sourceReference
		var bodyHTML string
		if err := rows.Scan(
			&reference.ID,
			&reference.ExternalID,
			&reference.Name,
			&reference.ContentHash,
			&bodyHTML,
			&reference.ReviewStatus,
			&reference.AdaptationAllowed,
			&reference.NeedsPublication,
		); err != nil {
			return nil, err
		}
		reference.BodyHash = bodyHTMLHash(bodyHTML)
		references = append(references, reference)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := validateLoadedReferences(
		references,
		identities,
		contentHashes,
	); err != nil {
		return nil, err
	}
	return references, nil
}

func validateLoadedReferences(
	references []sourceReference,
	identities []string,
	contentHashes map[string]string,
) error {
	expected := make(map[string]struct{}, len(identities))
	for _, externalID := range identities {
		expected[externalID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if _, ok := expected[reference.ExternalID]; !ok {
			return fmt.Errorf(
				"database returned source_external_id %q absent from manifest",
				reference.ExternalID,
			)
		}
		if _, duplicate := seen[reference.ExternalID]; duplicate {
			return fmt.Errorf(
				"database contains duplicate source_external_id %q for staging tenant",
				reference.ExternalID,
			)
		}
		seen[reference.ExternalID] = struct{}{}
	}
	if len(seen) != len(expected) {
		missing := make([]string, 0, len(expected)-len(seen))
		for externalID := range expected {
			if _, ok := seen[externalID]; !ok {
				missing = append(missing, externalID)
			}
		}
		sort.Strings(missing)
		const displayLimit = 10
		displayed := missing
		if len(displayed) > displayLimit {
			displayed = displayed[:displayLimit]
		}
		return fmt.Errorf(
			"staging tenant is missing %d manifest references (first %d: %s)",
			len(missing),
			len(displayed),
			strings.Join(displayed, ", "),
		)
	}

	for _, reference := range references {
		manifestHash, ok := contentHashes[reference.ExternalID]
		if !ok {
			return fmt.Errorf(
				"manifest is missing content_hash for source_external_id %q",
				reference.ExternalID,
			)
		}
		if reference.ContentHash != manifestHash {
			return fmt.Errorf(
				"staging content_hash for source_external_id %q does not match manifest",
				reference.ExternalID,
			)
		}
		if reference.BodyHash != reference.ContentHash {
			return fmt.Errorf(
				"staging body_html hash for source_external_id %q does not match content_hash",
				reference.ExternalID,
			)
		}
	}
	return nil
}

func loadStaleReferences(
	ctx context.Context,
	db catalogDB,
	provider string,
	identities []string,
) ([]platformReference, error) {
	rows, err := db.Query(ctx, `
SELECT id::text, source_external_id, name
  FROM campaign_templates
 WHERE tenant_id IS NULL
   AND template_kind = 'reference'
   AND source_provider = $1
   AND source_external_id IS NOT NULL
   AND catalog_published_at IS NOT NULL
   AND catalog_unpublished_at IS NULL
   AND NOT (source_external_id = ANY($2::text[]))
 ORDER BY source_external_id, id`,
		provider, identities)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stale := make([]platformReference, 0)
	for rows.Next() {
		var reference platformReference
		if err := rows.Scan(
			&reference.ID,
			&reference.ExternalID,
			&reference.Name,
		); err != nil {
			return nil, err
		}
		stale = append(stale, reference)
	}
	return stale, rows.Err()
}

func reportStaleReferences(
	stale []platformReference,
	reconcileRequested bool,
) {
	if len(stale) == 0 {
		fmt.Println("catalogpublish: no stale active shared references")
		return
	}
	action := "report only"
	if reconcileRequested {
		action = "unpublish requested"
	}
	fmt.Printf(
		"catalogpublish: found %d stale active shared references (%s)\n",
		len(stale),
		action,
	)
	for _, reference := range stale {
		fmt.Printf(
			"catalogpublish: stale platform_id=%s source_external_id=%q\n",
			reference.ID,
			reference.ExternalID,
		)
	}
}

func validateStaleMutation(
	opts options,
	stale []platformReference,
) error {
	if opts.dryRun {
		return nil
	}
	if len(stale) > 0 && opts.publish && !opts.reconcileStale {
		return fmt.Errorf(
			"refusing publication while %d stale active shared references remain; "+
				"review the dry-run and rerun with --reconcile-stale",
			len(stale),
		)
	}
	return nil
}

func reconcileStaleReferences(
	ctx context.Context,
	db catalogDB,
	stale []platformReference,
	actorID string,
	note string,
) error {
	for index, reference := range stale {
		var unpublished bool
		if err := db.QueryRow(ctx, `
SELECT campaign_template_unpublish_reference(
    $1::uuid, $2, $3
)`,
			reference.ID,
			actorID,
			note,
		).Scan(&unpublished); err != nil {
			return fmt.Errorf(
				"unpublish %s (%s): %w",
				reference.ID,
				reference.ExternalID,
				err,
			)
		}
		if !unpublished {
			return fmt.Errorf(
				"unpublish %s (%s): reference was no longer active",
				reference.ID,
				reference.ExternalID,
			)
		}
		fmt.Printf(
			"catalogpublish: unpublished stale reference %d of %d\n",
			index+1,
			len(stale),
		)
	}
	return nil
}
