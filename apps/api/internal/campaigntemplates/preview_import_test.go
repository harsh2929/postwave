// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestImportedPreviewEnqueuesSeedsDesktopMobileAndCard(t *testing.T) {
	input := CreateInput{
		SourceProvider:   PreviewProviderReallyGoodEmails,
		SourceExternalID: "weekly-signal",
		ThumbnailURL: "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/" +
			"emails/weekly-signal.png",
		DesignMetadata: map[string]any{
			"screenshot_width":  float64(680),
			"screenshot_height": float64(2564),
		},
		SourceMetadata: map[string]any{
			"mobile_screenshot": map[string]any{
				"url": "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/" +
					"emails/mobile/weekly-signal.png",
				"width":  float64(375),
				"height": float64(2861),
			},
		},
	}

	jobs, err := importedPreviewEnqueues("11111111-1111-1111-1111-111111111111", input)
	if err != nil {
		t.Fatalf("importedPreviewEnqueues: %v", err)
	}
	if len(jobs) != 3 {
		t.Fatalf("jobs = %d, want desktop/mobile/card", len(jobs))
	}
	if jobs[0].Variant != "desktop" || jobs[1].Variant != "mobile" ||
		jobs[2].Variant != "card" {
		t.Fatalf("variant order = %q, %q, %q", jobs[0].Variant, jobs[1].Variant, jobs[2].Variant)
	}
	if jobs[2].SourceURL != jobs[0].SourceURL {
		t.Fatalf("card source = %q, want desktop source %q", jobs[2].SourceURL, jobs[0].SourceURL)
	}
	for _, job := range jobs {
		if job.SourceProvider != PreviewProviderReallyGoodEmails {
			t.Fatalf("%s provider = %q", job.Variant, job.SourceProvider)
		}
		if _, err := validatePreviewSourceStructure(job.SourceProvider, job.SourceURL); err != nil {
			t.Fatalf("%s source did not pass enqueue boundary: %v", job.Variant, err)
		}
		var provenance map[string]any
		if err := json.Unmarshal(job.SourceProvenance, &provenance); err != nil {
			t.Fatalf("%s provenance: %v", job.Variant, err)
		}
		if provenance["ingest"] != "campaign_template_import" ||
			provenance["source_external_id"] != "weekly-signal" {
			t.Fatalf("%s provenance = %#v", job.Variant, provenance)
		}
	}
	var cardProvenance map[string]any
	_ = json.Unmarshal(jobs[2].SourceProvenance, &cardProvenance)
	if cardProvenance["derived_from"] != "desktop" {
		t.Fatalf("card provenance = %#v", cardProvenance)
	}
}

func TestImportedPreviewEnqueuesSeedsAuraDesktopAndCardOnly(t *testing.T) {
	const sourceURL = "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
		"storage/v1/object/public/chat-thumbnails/" +
		"9109ecbb-cdc4-4815-981e-2ea83be13765/" +
		"react-project-28aad9b8-d552-4d8d-833a-46dc92bcda2c_800w.jpg"
	input := CreateInput{
		SourceProvider:   " AURA_BUILD ",
		SourceExternalID: "react:8fd8ad07-5f86-40ea-acfc-789bb29fed04",
		ThumbnailURL:     sourceURL,
		SourceMetadata: map[string]any{
			"preview_images": map[string]any{
				"image_320w": "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
					"storage/v1/object/public/chat-thumbnails/example_320w.jpg",
			},
		},
	}

	jobs, err := importedPreviewEnqueues("11111111-1111-1111-1111-111111111111", input)
	if err != nil {
		t.Fatalf("importedPreviewEnqueues: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("jobs = %d, want desktop/card only", len(jobs))
	}
	if jobs[0].Variant != "desktop" || jobs[1].Variant != "card" {
		t.Fatalf("variant order = %q, %q", jobs[0].Variant, jobs[1].Variant)
	}
	for _, job := range jobs {
		if job.SourceProvider != PreviewProviderAuraBuild || job.SourceURL != sourceURL {
			t.Fatalf("%s job = %#v", job.Variant, job)
		}
		if _, err := validatePreviewSourceStructure(job.SourceProvider, job.SourceURL); err != nil {
			t.Fatalf("%s source did not pass enqueue boundary: %v", job.Variant, err)
		}
	}
	var provenance map[string]any
	if err := json.Unmarshal(jobs[1].SourceProvenance, &provenance); err != nil {
		t.Fatal(err)
	}
	if provenance["derived_from"] != "desktop" {
		t.Fatalf("card provenance = %#v", provenance)
	}
}

func TestImportedPreviewEnqueuesRejectsAuraThumbnailOutsidePublicBuckets(t *testing.T) {
	_, err := importedPreviewEnqueues("template-1", CreateInput{
		SourceProvider: PreviewProviderAuraBuild,
		ThumbnailURL: "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
			"storage/v1/object/public/user-avatars/avatars/example.png",
	})
	if !errors.Is(err, ErrPreviewSourceRejected) {
		t.Fatalf("error = %v, want source rejected", err)
	}
}

func TestImportedPreviewEnqueuesSkipsUnknownProviderAndMissingPixels(t *testing.T) {
	unknown, err := importedPreviewEnqueues("template-1", CreateInput{
		SourceProvider: "another_provider",
		ThumbnailURL: "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/" +
			"emails/weekly-signal.png",
	})
	if err != nil {
		t.Fatalf("unknown provider: %v", err)
	}
	if len(unknown) != 0 {
		t.Fatalf("unknown-provider jobs = %#v", unknown)
	}

	missing, err := importedPreviewEnqueues("template-1", CreateInput{
		SourceProvider: PreviewProviderReallyGoodEmails,
	})
	if err != nil {
		t.Fatalf("missing pixels: %v", err)
	}
	if len(missing) != 0 {
		t.Fatalf("missing-pixel jobs = %#v", missing)
	}
}
