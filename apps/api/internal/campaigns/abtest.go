// SPDX-License-Identifier: AGPL-3.0-only
//
// A/B test campaign creation. The desktop SubjectLineSuggestions
// component streams 3 subject-line variants from the voice service;
// when the user clicks "A/B test all three" the desktop posts here.
//
// Schema choice: this package does NOT add a new column to `campaigns`
// — the existing `delivery_settings jsonb` field carries the A/B
// metadata so the migration story stays untouched. The shape is:
//
//	delivery_settings.ab_test = {
//	    "is_parent": true,                     // on the parent
//	    "parent_id": "<uuid>",                 // on each child
//	    "variant_id": "A"|"B"|"C",             // on each child only
//	    "variant_index": 0|1|2,                // on each child only
//	    "total_variants": 3,                   // on each child only
//	    "split_percentage": 33,                // on the parent (default: 100/N)
//	}
//
// Child campaigns are full-fat campaigns sharing the parent's audience
// (audience_list_id + audience_segment_id) and body — only the subject
// line differs. The actual audience-split is performed at queue
// dispatch: ApplyABTestSplit hashes fnv-1a(parent_id + ":" + email)
// modulo total_variants and keeps the row iff the modulo equals the
// child's variant_index. This guarantees each subscriber lands in
// exactly one variant, with ~1/N expected share per variant across a
// large enough audience.
//
// Tenant isolation: all writes go through db.WithTenant (RLS enforced).
// The handler reads tenant from middleware context, never from the body.

package campaigns

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ABTestCreateInput is the body of POST /api/v1/campaigns/ab-test.
type ABTestCreateInput struct {
	Name              string         `json:"name"`
	SubjectVariants   []string       `json:"subject_variants"`
	AudienceListID    string         `json:"audience_list_id"`
	AudienceSegmentID string         `json:"audience_segment_id"`
	BodyHTML          string         `json:"body_html"`
	BodyMJML          string         `json:"body_mjml"`
	PlainText         string         `json:"plain_text"`
	PreviewText       string         `json:"preview_text"`
	FromName          string         `json:"from_name"`
	ReplyTo           string         `json:"reply_to"`
	SplitPercentage   int            `json:"split_percentage"`
	TrackingSettings  map[string]any `json:"tracking_settings"`
	DeliverySettings  map[string]any `json:"delivery_settings"`

	// G14 (campaigns 2026): multivariate axes. When any of these are
	// populated the test becomes a cross-product over the populated axes
	// (subject × from_name × body × send-time), capped at 8 combos.
	// Empty axes fall back to the scalar fields (FromName/Body*) / no
	// offset, so a subject-only test behaves exactly as before.
	FromNameVariants      []string `json:"from_name_variants,omitempty"`
	BodyHTMLVariants      []string `json:"body_html_variants,omitempty"`
	SendTimeOffsetMinutes []int    `json:"send_time_offset_minutes,omitempty"`
}

// abMaxCombos caps the multivariate cross-product. Matches the
// subject-only limit so the variant label set stays A–H.
const abMaxCombos = 8

// abCombo is one cell of the multivariate cross-product.
type abCombo struct {
	Subject       string
	FromName      string
	BodyHTML      string
	BodyMJML      string
	PlainText     string
	SendOffsetMin int
}

// buildABCombos cross-products the populated axes. Subject is always an
// axis (≥2 enforced in normalize). from_name/body/send-time axes fall
// back to the scalar field / zero offset when their slice is empty.
// Order is stable (subject outermost) so variant labels are deterministic.
func buildABCombos(in ABTestCreateInput) []abCombo {
	fromNames := in.FromNameVariants
	if len(fromNames) == 0 {
		fromNames = []string{in.FromName}
	}
	bodies := in.BodyHTMLVariants
	if len(bodies) == 0 {
		bodies = []string{in.BodyHTML}
	}
	offsets := in.SendTimeOffsetMinutes
	if len(offsets) == 0 {
		offsets = []int{0}
	}
	combos := make([]abCombo, 0, abMaxCombos)
	for _, subj := range in.SubjectVariants {
		for _, fn := range fromNames {
			for _, body := range bodies {
				for _, off := range offsets {
					combos = append(combos, abCombo{
						Subject:       subj,
						FromName:      fn,
						BodyHTML:      body,
						BodyMJML:      in.BodyMJML,
						PlainText:     in.PlainText,
						SendOffsetMin: off,
					})
				}
			}
		}
	}
	return combos
}

// abTestMetadataKey is the delivery_settings key carrying the A/B
// metadata. Kept as a constant so dispatch + create stay in sync.
const abTestMetadataKey = "ab_test"

// ABTestVariantConfig is the parsed shape of delivery_settings.ab_test
// on a child campaign. Used by the queue-dispatch split. Empty fields
// signal "not part of an A/B test".
type ABTestVariantConfig struct {
	ParentID      string
	VariantIndex  int
	TotalVariants int
	// SendTimeOffsetMin (G14) is this variant's send-time offset in
	// minutes relative to the test's base schedule. 0 when the variant
	// isn't a send-time arm. OffsetDuration converts it for scheduling.
	SendTimeOffsetMin int
}

// OffsetDuration returns the variant's send-time offset as a Duration.
func (c ABTestVariantConfig) OffsetDuration() time.Duration {
	return time.Duration(c.SendTimeOffsetMin) * time.Minute
}

// ParseABTestVariantConfig pulls the A/B metadata out of a campaign's
// delivery_settings. Returns (cfg, true) only when the campaign is a
// child variant with a non-empty parent_id and total_variants > 1.
//
// We accept either int or float64 for the numeric fields because the
// JSON round-trip through pgx.jsonb decodes numbers as float64 while
// in-memory creation uses int. Both shapes show up in tests.
func ParseABTestVariantConfig(deliverySettings map[string]any) (ABTestVariantConfig, bool) {
	if deliverySettings == nil {
		return ABTestVariantConfig{}, false
	}
	rawAB, ok := deliverySettings[abTestMetadataKey]
	if !ok {
		return ABTestVariantConfig{}, false
	}
	ab, ok := rawAB.(map[string]any)
	if !ok {
		return ABTestVariantConfig{}, false
	}
	cfg := ABTestVariantConfig{}
	if v, ok := ab["parent_id"].(string); ok {
		cfg.ParentID = strings.TrimSpace(v)
	}
	cfg.VariantIndex = coerceInt(ab["variant_index"])
	cfg.TotalVariants = coerceInt(ab["total_variants"])
	cfg.SendTimeOffsetMin = coerceInt(ab["send_time_offset_minutes"])
	if cfg.ParentID == "" || cfg.TotalVariants < 2 {
		return ABTestVariantConfig{}, false
	}
	if cfg.VariantIndex < 0 || cfg.VariantIndex >= cfg.TotalVariants {
		return ABTestVariantConfig{}, false
	}
	return cfg, true
}

func canonicalABVariantID(deliverySettings map[string]any) string {
	raw, ok := deliverySettings[abTestMetadataKey]
	if !ok {
		return ""
	}
	meta, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	id, _ := meta["canonical_variant_id"].(string)
	return strings.TrimSpace(id)
}

// coerceInt accepts both float64 (from JSON) and int (from in-memory
// construction) since both shapes show up in delivery_settings.
func coerceInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case float32:
		return int(t)
	default:
		return 0
	}
}

// ApplyABTestSplit returns the subset of `emails` that fall into the
// configured variant. Hash key is `<parent_id>:<email>` under fnv-1a/64
// so:
//
//   - the same email always lands in the same variant for the same A/B
//     test (deterministic),
//   - a different parent_id yields a different split (no carry-over
//     between A/B tests),
//   - and the modulo distribution is uniform-ish across a large
//     audience (~1/N per variant for N total variants).
//
// When cfg is the zero value or TotalVariants < 2 the input is returned
// unchanged.
func ApplyABTestSplit(cfg ABTestVariantConfig, emails []string) []string {
	if cfg.TotalVariants < 2 || cfg.ParentID == "" {
		return emails
	}
	out := make([]string, 0, len(emails)/cfg.TotalVariants+1)
	for _, e := range emails {
		if abVariantBucket(cfg.ParentID, e, cfg.TotalVariants) == cfg.VariantIndex {
			out = append(out, e)
		}
	}
	return out
}

// abVariantBucket is the deterministic hash-modulo used by
// ApplyABTestSplit. Exported as a package-private helper so tests can
// assert distribution properties without re-implementing the hash.
func abVariantBucket(parentID, email string, totalVariants int) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(parentID))
	_, _ = h.Write([]byte{':'})
	_, _ = h.Write([]byte(email))
	return int(h.Sum64() % uint64(totalVariants))
}

// ABTestCreateResponse is the body of a successful create.
type ABTestCreateResponse struct {
	Parent   *Campaign   `json:"parent"`
	Children []*Campaign `json:"children"`
}

// CreateABTest is the chi handler. Mounted in main.go alongside the
// other write campaigns routes.
func (d *Deps) CreateABTest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in ABTestCreateInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeABTest(&in); err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	parent, children, err := d.createABTest(r.Context(), t.ID, in)
	if err != nil {
		if writeCampaignAudienceError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Emit a single event for the parent — child rows are an internal
	// implementation detail. UI listeners only care that "an A/B test
	// was created"; they re-read the list on the signal.
	d.emit(t.ID, "campaign.ab_test_created", map[string]any{
		"parent_id":     parent.ID,
		"variant_count": len(children),
	})

	writeJSON(w, http.StatusCreated, ABTestCreateResponse{Parent: parent, Children: children})
}

// createABTest creates the parent + N children. Done as N+1 separate
// Repo.Create calls — the existing Repo.Create owns audience validation
// + RLS — so we don't have to re-implement segment validation here.
//
// Why not one big tx: Repo.Create opens its own tx (RLS-bound). Wrapping
// would require a second `WithTenantTx`-style API and re-plumbing. The
// honest tradeoff: a partial failure leaves orphan parents/children
// the caller can clean up via the campaigns list. The failure is loud
// (returns the inner error) so the operator sees it.
func (d *Deps) createABTest(ctx context.Context, tenantID string, in ABTestCreateInput) (*Campaign, []*Campaign, error) {
	combos := buildABCombos(in)
	n := len(combos)
	splitPct := in.SplitPercentage
	if splitPct <= 0 || splitPct > 100 {
		splitPct = 100 / n // even split — 33 for 3 variants, 50 for 2, etc.
	}

	parentDelivery := nonNilMap(in.DeliverySettings)
	parentDelivery[abTestMetadataKey] = map[string]any{
		"is_parent":        true,
		"variant_count":    n,
		"total_variants":   n,
		"split_percentage": splitPct,
	}

	parentInput := CreateInput{
		Name:             in.Name,
		Subject:          combos[0].Subject, // canonical subject is the first combo
		CampaignType:     "ab_test",
		EditorMode:       "blocks",
		PreviewText:      in.PreviewText,
		BodyHTML:         in.BodyHTML,
		BodyMJML:         in.BodyMJML,
		PlainText:        in.PlainText,
		FromName:         in.FromName,
		ReplyTo:          in.ReplyTo,
		SegmentID:        in.AudienceSegmentID,
		ListID:           in.AudienceListID,
		TrackingSettings: nonNilMap(in.TrackingSettings),
		DeliverySettings: parentDelivery,
	}
	if err := normalizeCreate(&parentInput); err != nil {
		return nil, nil, err
	}
	parent, err := d.Repo.Create(ctx, tenantID, parentInput)
	if err != nil {
		return nil, nil, err
	}
	// Repo.Create resolved the list through the tenant's list_id_map and
	// stored its engine id; every row below carries that canonical id, not the
	// caller's spelling. SetABTestAudience still stamps audience_segment_id
	// (the migration-0068 column Repo.Create does not write). Failure here is
	// loud — we don't want orphan children whose audience contract drifts from
	// the parent's.
	if err := d.Repo.SetABTestAudience(ctx, tenantID, parent.ID, in.AudienceListID, in.AudienceSegmentID); err != nil {
		return nil, nil, err
	}
	if d.ABRepo == nil {
		return nil, nil, errors.New("campaigns: A/B variant repo not configured")
	}
	canonicalVariants, err := d.ABRepo.CreateVariants(ctx, tenantID, parent.ID, canonicalABVariants(combos))
	if err != nil {
		return nil, nil, fmt.Errorf("seed canonical A/B variants: %w", err)
	}
	if _, err := d.ABRepo.UpsertSettings(ctx, tenantID, parent.ID, abtests.ABSettings{
		WinnerMetric:          abtests.WinnerMetricOpenRate,
		EvaluationWindowHours: 24,
		WinnerRecipientsPct:   100,
		SamplePct:             100,
		BanditStrategy:        "fixed",
	}); err != nil {
		return nil, nil, fmt.Errorf("seed canonical A/B settings: %w", err)
	}
	canonicalIDByLabel := make(map[string]string, len(canonicalVariants))
	for _, variant := range canonicalVariants {
		canonicalIDByLabel[variant.VariantLabel] = variant.ID
	}

	children := make([]*Campaign, 0, n)
	for i, combo := range combos {
		variantID := variantIDForIndex(i)
		canonicalVariantID := canonicalIDByLabel[variantID]
		if canonicalVariantID == "" {
			return nil, nil, fmt.Errorf("canonical A/B variant %s missing", variantID)
		}
		abMeta := map[string]any{
			"parent_id":            parent.ID,
			"variant_id":           variantID,
			"canonical_variant_id": canonicalVariantID,
			"variant_index":        i,
			"total_variants":       n,
		}
		// G14: record the per-combo axes so the reader + dispatcher can
		// see which axis values this variant carries. send_time_offset is
		// honored by the dispatcher when scheduling the child.
		if combo.SendOffsetMin != 0 {
			abMeta["send_time_offset_minutes"] = combo.SendOffsetMin
		}
		abMeta["axis_subject"] = combo.Subject
		abMeta["axis_from_name"] = combo.FromName
		childDelivery := map[string]any{abTestMetadataKey: abMeta}
		// Carry over caller-provided delivery settings so per-variant
		// overrides (e.g. send-time) work; the ab_test block above
		// always wins.
		for k, v := range nonNilMap(in.DeliverySettings) {
			if k == abTestMetadataKey {
				continue
			}
			childDelivery[k] = v
		}
		childInput := CreateInput{
			Name:             in.Name + " — variant " + variantID,
			Subject:          combo.Subject,
			CampaignType:     "ab_test",
			EditorMode:       "blocks",
			PreviewText:      in.PreviewText,
			BodyHTML:         combo.BodyHTML,
			BodyMJML:         combo.BodyMJML,
			PlainText:        combo.PlainText,
			FromName:         combo.FromName,
			ReplyTo:          in.ReplyTo,
			SegmentID:        in.AudienceSegmentID,
			TrackingSettings: nonNilMap(in.TrackingSettings),
			DeliverySettings: childDelivery,
		}
		if err := normalizeCreate(&childInput); err != nil {
			return nil, nil, err
		}
		child, err := d.Repo.Create(ctx, tenantID, childInput)
		if err != nil {
			return nil, nil, err
		}
		// Propagate audience_list_id to the child so the queue dispatch
		// path sees the same audience contract as the parent. Without
		// this children inherit a NULL list_id and the dispatch hash
		// can't tell which list a row belongs to.
		if err := d.Repo.SetABTestAudience(ctx, tenantID, child.ID, in.AudienceListID, in.AudienceSegmentID); err != nil {
			return nil, nil, err
		}
		children = append(children, child)
	}

	return parent, children, nil
}

func canonicalABVariants(combos []abCombo) []abtests.Variant {
	if len(combos) == 0 {
		return nil
	}
	weight := 100 / float64(len(combos))
	out := make([]abtests.Variant, 0, len(combos))
	for i, combo := range combos {
		out = append(out, abtests.Variant{
			VariantLabel:          variantIDForIndex(i),
			Subject:               combo.Subject,
			FromName:              combo.FromName,
			BodyMJML:              combo.BodyMJML,
			BodyHTML:              combo.BodyHTML,
			SendTimeOffsetMinutes: combo.SendOffsetMin,
			Weight:                weight,
		})
	}
	return out
}

// normalizeABTest validates + trims the input. Done before any DB call
// so a malformed body returns 422 fast.
func normalizeABTest(in *ABTestCreateInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.AudienceListID = strings.TrimSpace(in.AudienceListID)
	in.AudienceSegmentID = strings.TrimSpace(in.AudienceSegmentID)
	in.BodyMJML = strings.TrimSpace(in.BodyMJML)
	in.PlainText = strings.TrimSpace(in.PlainText)
	in.PreviewText = strings.TrimSpace(in.PreviewText)
	in.FromName = strings.TrimSpace(in.FromName)
	in.ReplyTo = strings.TrimSpace(strings.ToLower(in.ReplyTo))
	cleaned := make([]string, 0, len(in.SubjectVariants))
	for _, v := range in.SubjectVariants {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		cleaned = append(cleaned, v)
	}
	in.SubjectVariants = cleaned

	// G14: clean the optional multivariate axes (drop blanks).
	in.FromNameVariants = trimNonEmpty(in.FromNameVariants)
	in.BodyHTMLVariants = trimNonEmpty(in.BodyHTMLVariants)

	if in.Name == "" {
		return errors.New("name is required")
	}
	if len(in.SubjectVariants) < 2 {
		return errors.New("at least 2 subject variants required")
	}
	if len(in.SubjectVariants) > 8 {
		return errors.New("at most 8 subject variants supported")
	}
	if in.AudienceListID == "" && in.AudienceSegmentID == "" {
		return errors.New("audience_list_id or audience_segment_id required")
	}
	if in.SplitPercentage < 0 || in.SplitPercentage > 100 {
		return errors.New("split_percentage must be 0-100")
	}
	// G14: cap the multivariate cross-product. axisLen counts a populated
	// axis or 1 for the scalar fallback.
	axisLen := func(n int) int {
		if n == 0 {
			return 1
		}
		return n
	}
	combos := len(in.SubjectVariants) *
		axisLen(len(in.FromNameVariants)) *
		axisLen(len(in.BodyHTMLVariants)) *
		axisLen(len(in.SendTimeOffsetMinutes))
	if combos > abMaxCombos {
		return fmt.Errorf("multivariate cross-product is %d combinations; at most %d supported", combos, abMaxCombos)
	}
	return nil
}

// trimNonEmpty trims each entry and drops the blanks.
func trimNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// variantIDForIndex returns "A" for 0, "B" for 1, ... — caps at "Z"
// (we never get there: normalizeABTest enforces ≤8 variants).
func variantIDForIndex(i int) string {
	if i < 0 || i > 25 {
		return "?"
	}
	return string(rune('A' + i))
}

// SetABTestAudience writes the audience_list_id + audience_segment_id
// columns (added by migration 0068) on a campaign row. Repo.Create
// doesn't write audience_segment_id, so the A/B parent + every child
// needs this follow-up update to carry the audience contract.
//
// listID is resolved through the tenant's list_id_map, exactly as
// Repo.Create resolves it, and the canonical engine id is stored: the
// column is bigint, so a uuid spelling was a cast failure, and an
// unvalidated engine id named a list this tenant might not own. An empty
// listID or segmentID leaves that column NULL. Idempotent, so a retry
// after partial failure never duplicates.
func (r *Repo) SetABTestAudience(ctx context.Context, tenantID, campaignID, listID, segmentID string) error {
	listID = strings.TrimSpace(listID)
	segmentID = strings.TrimSpace(segmentID)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if listID != "" {
		list, err := resolveOwnedCampaignList(ctx, tx, tenantID, listID)
		if err != nil {
			return err
		}
		listID = list.StoredListID()
	}
	const q = `
UPDATE campaigns
   SET audience_list_id    = NULLIF($3,'')::bigint,
       audience_segment_id = NULLIF($4,'')::uuid,
       updated_at          = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`
	if _, err := tx.Exec(ctx, q, tenantID, campaignID, listID, segmentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
