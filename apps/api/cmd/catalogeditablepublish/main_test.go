// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func reviewedRecord() releaseRecord {
	mjml := `<mjml><mj-body><mj-section><mj-column>` +
		`<mj-image src="https://assets.postwave.test/hero.png"></mj-image>` +
		`<mj-button href="{{ cta_url }}">Open</mj-button>` +
		`<mj-text>{{ mailing_address }} <a href="{{unsubscribe_url}}">Unsubscribe</a></mj-text>` +
		`</mj-column></mj-section></mj-body></mjml>`
	hash := sha256.Sum256([]byte(mjml))
	return releaseRecord{
		Slug: "catalog-editable-aura-html-29679", Name: "Original", Subject: "Original",
		BodyMJML: mjml, TemplateKind: "editable", SourceProvider: "postwave",
		SourceExternalID: "enhancement:aura:html:29679", SourceLicenseStatus: "owned",
		ThumbnailURL: "https://assets.postwave.test/desktop.png", ReviewStatus: "approved",
		QualityScore: 0.85, ContentHash: "sha256:" + hex.EncodeToString(hash[:]),
		SourceMetadata: json.RawMessage(`{"inspired_by":{"catalog_id":"aura:html:29679","provider":"aura_build","external_id":"html:29679","source_artifact_hash":"sha256:abc"}}`),
		DesignMetadata: json.RawMessage(`{"mobile_preview_url":"https://assets.postwave.test/mobile.png","has_desktop_preview":true,"has_mobile_preview":true,"asset_digests":{"hero":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","desktop":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mobile":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"review":{"reviewer":"Reviewer","reviewed_at":"2026-01-01T00:00:00Z","checks":{"visual":true,"facts":true,"rights":true,"accessibility":true,"links":true,"email_clients":true}}}`),
	}
}

func TestValidateReviewedEditableRelease(t *testing.T) {
	record := reviewedRecord()
	if err := validate(record); err != nil {
		t.Fatalf("valid release rejected: %v", err)
	}
	record.BodyMJML += "changed"
	if err := validate(record); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("stale content hash accepted: %v", err)
	}
	record = reviewedRecord()
	record.ReviewStatus = "pending"
	if err := validate(record); err == nil {
		t.Fatal("unreviewed template accepted")
	}
}

func updateDesign(t *testing.T, record *releaseRecord, change func(*releaseDesign)) {
	t.Helper()
	var design releaseDesign
	if err := json.Unmarshal(record.DesignMetadata, &design); err != nil {
		t.Fatal(err)
	}
	change(&design)
	data, err := json.Marshal(design)
	if err != nil {
		t.Fatal(err)
	}
	record.DesignMetadata = data
}

func updateBody(record *releaseRecord, body string) {
	record.BodyMJML = body
	hash := sha256.Sum256([]byte(body))
	record.ContentHash = "sha256:" + hex.EncodeToString(hash[:])
}

func TestValidateSupportingImageEvidence(t *testing.T) {
	record := reviewedRecord()
	updateBody(&record, strings.Replace(record.BodyMJML, "<mj-button",
		`<mj-image src="https://assets.postwave.test/detail.png"></mj-image><mj-button`, 1))
	updateDesign(t, &record, func(design *releaseDesign) {
		design.AssetDigests["detail"] = "sha256:" + strings.Repeat("d", 64)
	})
	if err := validate(record); err != nil {
		t.Fatalf("reviewed supporting image rejected: %v", err)
	}
	updateDesign(t, &record, func(design *releaseDesign) { delete(design.AssetDigests, "detail") })
	if err := validate(record); err == nil {
		t.Fatal("supporting image without digest evidence accepted")
	}
}

func TestValidateRepeatedOriginalImages(t *testing.T) {
	record := reviewedRecord()
	image := `<mj-image src="https://assets.postwave.test/hero.png"></mj-image>`
	updateBody(&record, strings.Replace(record.BodyMJML, image, strings.Repeat(image, 4), 1))
	updateDesign(t, &record, func(design *releaseDesign) {
		design.ImageReferenceCounts = map[string]int{"hero": 4}
		design.ImageAssetURLs = map[string]string{"hero": "https://assets.postwave.test/hero.png"}
	})
	if err := validate(record); err != nil {
		t.Fatalf("one reviewed original reused in four blocks rejected: %v", err)
	}
	for _, mutate := range []func(*releaseDesign){
		func(design *releaseDesign) { design.ImageReferenceCounts["hero"] = 3 },
		func(design *releaseDesign) { design.ImageReferenceCounts["hero"] = 0 },
		func(design *releaseDesign) { delete(design.ImageAssetURLs, "hero") },
		func(design *releaseDesign) { design.ImageAssetURLs["hero"] = "https://assets.postwave.test/other.png" },
		func(design *releaseDesign) { delete(design.AssetDigests, "hero") },
	} {
		bad := record
		updateDesign(t, &bad, mutate)
		if err := validate(bad); err == nil {
			t.Fatal("inconsistent reused image evidence accepted")
		}
	}
	bad := record
	updateBody(&bad, strings.Replace(bad.BodyMJML, "</mj-column>",
		`<mj-image src="https://assets.postwave.test/undeclared.png"></mj-image></mj-column>`, 1))
	if err := validate(bad); err == nil {
		t.Fatal("undeclared hosted image accepted beside reused image")
	}
}

func TestValidateEditableBackgroundEvidence(t *testing.T) {
	record := reviewedRecord()
	updateBody(&record, strings.Replace(record.BodyMJML, "<mj-section>",
		`<mj-section background-url="https://assets.postwave.test/scene.png">`, 1))
	updateDesign(t, &record, func(design *releaseDesign) {
		design.BackgroundImageKeys = []string{"scene"}
		design.AssetDigests["scene"] = "sha256:" + strings.Repeat("d", 64)
	})
	if err := validate(record); err != nil {
		t.Fatalf("reviewed section background rejected: %v", err)
	}
	updateDesign(t, &record, func(design *releaseDesign) { design.BackgroundImageKeys = nil })
	if err := validate(record); err == nil {
		t.Fatal("undeclared background image accepted")
	}
	updateDesign(t, &record, func(design *releaseDesign) { design.BackgroundImageKeys = []string{"scene"} })
	updateBody(&record, strings.Replace(record.BodyMJML, "https://assets.postwave.test/scene.png", "http://localhost/scene.png", 1))
	if err := validate(record); err == nil || !strings.Contains(err.Error(), "non-hosted image") {
		t.Fatalf("non-hosted background image accepted: %v", err)
	}
}

func TestValidateNativeTextAndRejectHiddenImages(t *testing.T) {
	record := reviewedRecord()
	updateBody(&record, strings.Replace(record.BodyMJML,
		`<mj-image src="https://assets.postwave.test/hero.png"></mj-image>`, "", 1))
	updateDesign(t, &record, func(design *releaseDesign) {
		design.VisualMode = "native_text"
		delete(design.AssetDigests, "hero")
	})
	if err := validate(record); err != nil {
		t.Fatalf("reviewed native text template rejected: %v", err)
	}
	updateDesign(t, &record, func(design *releaseDesign) { design.VisualMode = "" })
	if err := validate(record); err == nil {
		t.Fatal("missing image accepted without native text declaration")
	}
	updateDesign(t, &record, func(design *releaseDesign) { design.VisualMode = "native_text" })
	for _, markup := range []string{
		`<img src="https://assets.postwave.test/hidden.png">`,
		`<mj-section background-url="https://assets.postwave.test/hidden.png"></mj-section>`,
	} {
		bad := record
		updateBody(&bad, strings.Replace(bad.BodyMJML, "</mj-body>", markup+"</mj-body>", 1))
		if err := validate(bad); err == nil || !strings.Contains(err.Error(), "image markup") {
			t.Fatalf("native text image markup accepted: %v", err)
		}
	}
	updateDesign(t, &record, func(design *releaseDesign) {
		design.AssetDigests["desktop"] = "sha256:" + strings.Repeat("z", 64)
	})
	if err := validate(record); err == nil {
		t.Fatal("invalid preview digest accepted")
	}
}

func TestDryRunRequiresExactCountWithoutDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release.jsonl")
	line, err := json.Marshal(reviewedRecord())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := run([]string{"--release", path, "--expected-count", "1"}); got != 0 {
		t.Fatalf("dry run exit code = %d", got)
	}
	if got := run([]string{"--release", path, "--expected-count", "2"}); got == 0 {
		t.Fatal("count mismatch accepted")
	}
}
