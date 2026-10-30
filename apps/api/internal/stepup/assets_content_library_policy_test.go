package stepup

import (
	"net/http"
	"testing"
	"time"
)

func TestAssetsAndContentLibraryWritesRequireProportionateFreshProof(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
		action string
		age    time.Duration
	}{
		{http.MethodPost, "/api/v1/assets", "asset.upload", Session},
		{http.MethodPatch, "/api/v1/assets/{id}", "asset.edit", Session},
		{http.MethodDelete, "/api/v1/assets/{id}", "asset.delete", Immediate},
		{http.MethodPost, "/api/v1/assets/bulk-delete", "asset.bulk_delete", Immediate},
		{http.MethodPost, "/api/v1/assets/folders", "asset_folder.create", Session},
		{http.MethodPatch, "/api/v1/assets/folders/{id}", "asset_folder.rename", Session},
		{http.MethodDelete, "/api/v1/assets/folders/{id}", "asset_folder.delete", Session},
		{http.MethodPatch, "/api/v1/assets/{id}/folder", "asset.move", Session},
		{http.MethodPost, "/api/v1/assets/{id}/tags", "asset.tag_add", Session},
		{http.MethodDelete, "/api/v1/assets/{id}/tags/{tag}", "asset.tag_remove", Session},
		{http.MethodPost, "/api/v1/blocks/saved", "saved_block.create", Session},
		{http.MethodPatch, "/api/v1/blocks/saved/{id}", "saved_block.update", Session},
		{http.MethodDelete, "/api/v1/blocks/saved/{id}", "saved_block.delete", Immediate},
		{http.MethodPost, "/api/v1/collections", "reference_collection.create", Session},
		{http.MethodPatch, "/api/v1/collections/{id}", "reference_collection.update", Session},
		{http.MethodDelete, "/api/v1/collections/{id}", "reference_collection.delete", Immediate},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.action, func(t *testing.T) {
			t.Parallel()
			got := For(tt.method, tt.path)
			if got.Action != tt.action || got.MaxAge != tt.age || got.Reason == "" {
				t.Fatalf("For(%q, %q) = %+v, want action=%q age=%s with a reason", tt.method, tt.path, got, tt.action, tt.age)
			}
		})
	}
}

func TestAssetsAndContentLibraryReadsDoNotRequireStepUp(t *testing.T) {
	t.Parallel()

	for _, path := range []string{
		"/api/v1/assets",
		"/api/v1/assets/{id}",
		"/api/v1/assets/{id}/tags",
		"/api/v1/blocks/saved",
		"/api/v1/blocks/saved/{id}",
		"/api/v1/collections",
		"/api/v1/collections/{id}",
	} {
		if got := For(http.MethodGet, path); got.Required() {
			t.Errorf("GET %s requirement = %+v, want no step-up", path, got)
		}
	}
}
