package email_blocks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeProductResolver struct{}

func (fakeProductResolver) ResolveProductFeed(context.Context, string, string, string, ProductFeedResolveOptions) ([]ResolvedProduct, error) {
	return []ResolvedProduct{{
		Title:      "Resolved lamp",
		ImageURL:   "https://img.example.test/lamp.jpg",
		URL:        "https://shop.example.test/products/lamp",
		PriceCents: 2500,
		Currency:   "USD",
	}}, nil
}

type fakeCouponResolver struct {
	seen CouponResolveOptions
}

func (f *fakeCouponResolver) AssignCoupon(_ context.Context, _, poolID string, opts CouponResolveOptions) (*ResolvedCoupon, error) {
	f.seen = opts
	return &ResolvedCoupon{Code: "UNIQUE-123", PoolID: poolID, AssignmentID: "assign_1"}, nil
}

func TestCatalogIncludesMailchimpContentParityBlocks(t *testing.T) {
	want := map[string]bool{
		"product_recommendations": false,
		"discount_code":           false,
		"survey":                  false,
		"social_follow":           false,
		"social_share":            false,
		"rss":                     false,
		"video":                   false,
		"dynamic_content":         false,
		"conditional_content":     false,
	}
	for _, block := range V1Blocks {
		if _, ok := want[block.ID]; ok {
			want[block.ID] = true
		}
	}
	for id, found := range want {
		if !found {
			t.Fatalf("missing block %s", id)
		}
	}
}

func TestComposeHydratesProductRecommendationsFromFeed(t *testing.T) {
	deps := &Deps{ProductResolver: fakeProductResolver{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/email-blocks/compose", strings.NewReader(`{
		"subscriber_email":"buyer@example.com",
		"blocks":[{"block_id":"product_recommendations","config":{"feed_id":"feed_1","title":"For you"}}]
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.Compose(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, needle := range []string{"Resolved lamp", "https://img.example.test/lamp.jpg", "USD 25.00"} {
		if !strings.Contains(rec.Body.String(), needle) {
			t.Fatalf("response missing %q: %s", needle, rec.Body.String())
		}
	}
}

func TestComposeHydratesDiscountCodeFromCouponPool(t *testing.T) {
	resolver := &fakeCouponResolver{}
	deps := &Deps{CouponResolver: resolver}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/email-blocks/compose", strings.NewReader(`{
		"subscriber_email":"buyer@example.com",
		"blocks":[{"block_id":"discount_code","config":{"coupon_pool_id":"pool_1","description":"Your code"}}]
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.Compose(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "UNIQUE-123") {
		t.Fatalf("response missing resolved coupon: %s", rec.Body.String())
	}
	if resolver.seen.SubscriberEmail != "buyer@example.com" || resolver.seen.ContextKey != "email_block:pool_1" {
		t.Fatalf("resolver options = %#v", resolver.seen)
	}
}

func TestRenderMailchimpContentParityBlocks(t *testing.T) {
	mjml, warnings, err := Render(ComposeRequest{
		Blocks: []BlockInstance{
			{BlockID: "product_recommendations", Config: map[string]any{"title": "Picked for you"}},
			{BlockID: "discount_code", Config: map[string]any{"code": "SAVE20"}},
			{BlockID: "survey", Config: map[string]any{"question": "How was it?", "choices": []string{"Great", "No"}}},
			{BlockID: "video", Config: map[string]any{"video_url": "https://youtu.be/abc", "thumbnail_url": "https://img.example.test/abc.jpg"}},
			{BlockID: "conditional_content", Config: map[string]any{"condition": "FNAME", "content": "Hi *|FNAME|*"}},
		},
	})
	if err != nil {
		t.Fatalf("render error: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	for _, needle := range []string{"Picked for you", "SAVE20", "How was it?", "https://img.example.test/abc.jpg", "*|IF:FNAME|*"} {
		if !strings.Contains(mjml, needle) {
			t.Fatalf("mjml missing %q:\n%s", needle, mjml)
		}
	}
}
