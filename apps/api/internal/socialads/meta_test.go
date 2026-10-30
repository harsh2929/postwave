package socialads

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetaProviderPublishesFacebookFeedPost(t *testing.T) {
	var gotPath string
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		gotBody = r.Form.Encode()
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "page_123_post_456"})
	}))
	defer srv.Close()

	provider := NewMetaProvider(MetaConfig{
		GraphBaseURL:    srv.URL,
		GraphVersion:    "v24.0",
		PageID:          "page_123",
		PageAccessToken: "page-token",
	}, srv.Client())
	res, err := provider.PublishSocial(context.Background(), SocialPostRequest{
		Network: "facebook",
		Text:    "Launch day",
		LinkURL: "https://example.com",
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if gotPath != "/v24.0/page_123/feed" {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.Contains(gotBody, "message=Launch+day") || !strings.Contains(gotBody, "access_token=page-token") || !strings.Contains(gotBody, "link=https%3A%2F%2Fexample.com") {
		t.Fatalf("body = %q", gotBody)
	}
	if res.Status != "published" || res.ProviderID != "page_123_post_456" {
		t.Fatalf("result = %#v", res)
	}
}

func TestMetaProviderPublishesInstagramMediaTwoStep(t *testing.T) {
	paths := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		switch r.URL.Path {
		case "/v24.0/ig_123/media":
			if r.Form.Get("image_url") != "https://cdn.example.com/post.jpg" {
				t.Fatalf("image_url = %q", r.Form.Get("image_url"))
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "container_1"})
		case "/v24.0/ig_123/media_publish":
			if r.Form.Get("creation_id") != "container_1" {
				t.Fatalf("creation_id = %q", r.Form.Get("creation_id"))
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "ig_media_1"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	provider := NewMetaProvider(MetaConfig{
		GraphBaseURL:               srv.URL,
		GraphVersion:               "v24.0",
		PageAccessToken:            "page-token",
		InstagramBusinessAccountID: "ig_123",
	}, srv.Client())
	res, err := provider.PublishSocial(context.Background(), SocialPostRequest{
		Network:   "instagram",
		Text:      "New issue",
		MediaURLs: []string{"https://cdn.example.com/post.jpg"},
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(paths) != 2 || paths[0] != "/v24.0/ig_123/media" || paths[1] != "/v24.0/ig_123/media_publish" {
		t.Fatalf("paths = %#v", paths)
	}
	if res.Provider != "meta_instagram" || res.ProviderID != "ig_media_1" {
		t.Fatalf("result = %#v", res)
	}
}

func TestMetaProviderMissingCredentialsFailClosed(t *testing.T) {
	provider := NewMetaProvider(MetaConfig{}, http.DefaultClient)
	res, err := provider.PublishSocial(context.Background(), SocialPostRequest{Network: "facebook", Text: "Hi"})
	if err == nil {
		t.Fatal("expected error")
	}
	if res.Status != "requires_provider" {
		t.Fatalf("status = %q", res.Status)
	}
}
