package mailchimpv3

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeV3Store struct {
	member              *Member
	memberInput         MemberInput
	memberHash          string
	memberCreateCalls   int
	memberUpdateCalls   int
	tagsInput           TagsInput
	reportHits          int
	campaignActionCalls int
	customReportInput   CustomReportInput
}

func withV3TestPrincipal(r *http.Request, t *middleware.Tenant) *http.Request {
	ctx := middleware.WithTenant(r.Context(), t)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:            "test-owner",
		TenantID:      t.ID,
		Role:          "owner",
		EffectiveRole: "owner",
		MFASatisfied:  true,
	})
	return r.WithContext(ctx)
}

func (f *fakeV3Store) ListAudiences(_ context.Context, t *middleware.Tenant) (*ListResponse, error) {
	return &ListResponse{Lists: []AudienceList{{ID: t.Slug, Name: t.Name}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) ListMembers(context.Context, *middleware.Tenant, string, MemberQuery) (*MembersResponse, error) {
	return &MembersResponse{Members: []Member{*f.member}, TotalItems: 1}, nil
}
func (f *fakeV3Store) GetMember(context.Context, *middleware.Tenant, string, string) (*Member, error) {
	return f.member, nil
}
func (f *fakeV3Store) CreateMember(_ context.Context, _ *middleware.Tenant, _ string, in MemberInput) (*Member, error) {
	f.memberCreateCalls++
	f.memberInput = in
	f.member.EmailAddress = in.EmailAddress
	status := firstNonEmpty(in.Status, in.StatusIfNew)
	if status == "" {
		status = "non_subscribed"
	}
	f.member.Status = normalizeMailchimpStatus(status)
	return f.member, nil
}
func (f *fakeV3Store) UpdateMember(_ context.Context, _ *middleware.Tenant, _, subscriberHash string, in MemberInput) (*Member, error) {
	f.memberUpdateCalls++
	f.memberHash = subscriberHash
	f.memberInput = in
	f.member.EmailAddress = in.EmailAddress
	if strings.TrimSpace(in.Status) != "" {
		f.member.Status = normalizeMailchimpStatus(in.Status)
	}
	return f.member, nil
}
func (f *fakeV3Store) ListMemberTags(context.Context, *middleware.Tenant, string, string) (*TagsResponse, error) {
	return tagsResponse(f.member.Tags), nil
}
func (f *fakeV3Store) UpdateMemberTags(_ context.Context, _ *middleware.Tenant, _, _ string, in TagsInput) (*TagsResponse, error) {
	f.tagsInput = in
	return tagsResponseFromStrings(applyTagOperations(tagNames(f.member.Tags), in.Tags)), nil
}
func (f *fakeV3Store) ListCampaigns(context.Context, *middleware.Tenant, int, int) (*CampaignsResponse, error) {
	return &CampaignsResponse{Campaigns: []Campaign{{ID: "camp_1", Status: "save"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateCampaign(context.Context, *middleware.Tenant, CampaignInput) (*Campaign, error) {
	return &Campaign{ID: "camp_1", Status: "save"}, nil
}
func (f *fakeV3Store) GetCampaign(context.Context, *middleware.Tenant, string) (*Campaign, error) {
	return &Campaign{ID: "camp_1", Status: "save"}, nil
}
func (f *fakeV3Store) CampaignContent(context.Context, *middleware.Tenant, string) (*CampaignContent, error) {
	return &CampaignContent{HTML: "<p>Launch</p>"}, nil
}
func (f *fakeV3Store) UpdateCampaignContent(context.Context, *middleware.Tenant, string, CampaignContent) (*CampaignContent, error) {
	return &CampaignContent{HTML: "<p>Launch</p>"}, nil
}
func (f *fakeV3Store) CampaignAction(context.Context, *middleware.Tenant, string, string, map[string]any) (*CampaignActionResponse, error) {
	f.campaignActionCalls++
	return &CampaignActionResponse{ID: "camp_1", Status: "save", Complete: true}, nil
}
func (f *fakeV3Store) ReplicateCampaign(context.Context, *middleware.Tenant, string, bool) (*Campaign, error) {
	return &Campaign{ID: "camp_2", Status: "save"}, nil
}
func (f *fakeV3Store) CampaignReport(context.Context, *middleware.Tenant, string) (*Report, error) {
	f.reportHits++
	return &Report{ID: "camp_1", CampaignTitle: "Launch", EmailsSent: 10}, nil
}
func (f *fakeV3Store) EmailActivity(context.Context, *middleware.Tenant, string, int, int) (*EmailActivityResponse, error) {
	return &EmailActivityResponse{CampaignID: "camp_1"}, nil
}
func (f *fakeV3Store) ReportEventDetails(context.Context, *middleware.Tenant, string, string, int, int) (*ReportEventDetailsResponse, error) {
	return &ReportEventDetailsResponse{CampaignID: "camp_1", TotalItems: 0}, nil
}
func (f *fakeV3Store) ListTemplates(context.Context, *middleware.Tenant, int, int) (*TemplatesResponse, error) {
	return &TemplatesResponse{Templates: []Template{{ID: "tpl_1", Name: "Launch"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) GetTemplate(context.Context, *middleware.Tenant, string) (*Template, error) {
	return &Template{ID: "tpl_1", Name: "Launch"}, nil
}
func (f *fakeV3Store) ListAutomations(context.Context, *middleware.Tenant, int, int) (*AutomationsResponse, error) {
	return &AutomationsResponse{Automations: []Automation{{ID: "auto_1", Status: "active"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) GetAutomation(context.Context, *middleware.Tenant, string) (*Automation, error) {
	return &Automation{ID: "auto_1", Status: "active"}, nil
}
func (f *fakeV3Store) ListEcommerceStores(context.Context, *middleware.Tenant, int, int) (*EcommerceStoresResponse, error) {
	return &EcommerceStoresResponse{Stores: []EcommerceStore{{ID: "store_1", Platform: "shopify"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) GetEcommerceStore(context.Context, *middleware.Tenant, string) (*EcommerceStore, error) {
	return &EcommerceStore{ID: "store_1", Platform: "shopify"}, nil
}
func (f *fakeV3Store) ListLandingPages(context.Context, *middleware.Tenant, int, int) (*LandingPagesResponse, error) {
	return &LandingPagesResponse{LandingPages: []LandingPage{{ID: "lp_1", Name: "Landing"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateLandingPage(context.Context, *middleware.Tenant, LandingPageInput) (*LandingPage, error) {
	return &LandingPage{ID: "lp_1", Name: "Landing"}, nil
}
func (f *fakeV3Store) GetLandingPage(context.Context, *middleware.Tenant, string) (*LandingPage, error) {
	return &LandingPage{ID: "lp_1", Name: "Landing"}, nil
}
func (f *fakeV3Store) LandingPageContent(context.Context, *middleware.Tenant, string) (*LandingPageContent, error) {
	return &LandingPageContent{HTML: "<main></main>"}, nil
}
func (f *fakeV3Store) UpdateLandingPageContent(context.Context, *middleware.Tenant, string, LandingPageContent) (*LandingPageContent, error) {
	return &LandingPageContent{HTML: "<main></main>"}, nil
}
func (f *fakeV3Store) SetLandingPageStatus(context.Context, *middleware.Tenant, string, string) (*LandingPage, error) {
	return &LandingPage{ID: "lp_1", Status: "published"}, nil
}
func (f *fakeV3Store) ListFileManagerFiles(context.Context, *middleware.Tenant, int, int) (*FileManagerFilesResponse, error) {
	return &FileManagerFilesResponse{Files: []FileManagerFile{{ID: "file_1", Name: "Hero"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateFileManagerFile(context.Context, *middleware.Tenant, FileManagerFileInput) (*FileManagerFile, error) {
	return &FileManagerFile{ID: "file_1", Name: "Hero"}, nil
}
func (f *fakeV3Store) GetFileManagerFile(context.Context, *middleware.Tenant, string) (*FileManagerFile, error) {
	return &FileManagerFile{ID: "file_1", Name: "Hero"}, nil
}
func (f *fakeV3Store) UpdateFileManagerFile(context.Context, *middleware.Tenant, string, FileManagerFileUpdate) (*FileManagerFile, error) {
	return &FileManagerFile{ID: "file_1", Name: "Hero updated", AltText: "Hero image"}, nil
}
func (f *fakeV3Store) FileManagerFileUsage(context.Context, *middleware.Tenant, string) (*FileManagerFileUsageResponse, error) {
	return &FileManagerFileUsageResponse{FileID: "file_1", TotalUses: 1, Usage: []ContentStudioUsage{{Kind: "campaign", ID: "camp_1", Name: "Launch"}}}, nil
}
func (f *fakeV3Store) DeleteFileManagerFile(context.Context, *middleware.Tenant, string) error {
	return nil
}
func (f *fakeV3Store) ListFileManagerFolders(context.Context, *middleware.Tenant, int, int) (*FileManagerFoldersResponse, error) {
	return &FileManagerFoldersResponse{Folders: []FileManagerFolder{{ID: "0", Name: "Root"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateFileManagerFolder(context.Context, *middleware.Tenant, FileManagerFolderInput) (*FileManagerFolder, error) {
	return &FileManagerFolder{ID: "folder_1", Name: "Uploads"}, nil
}
func (f *fakeV3Store) GetFileManagerFolder(context.Context, *middleware.Tenant, string) (*FileManagerFolder, error) {
	return &FileManagerFolder{ID: "folder_1", Name: "Uploads"}, nil
}
func (f *fakeV3Store) DeleteFileManagerFolder(context.Context, *middleware.Tenant, string) error {
	return nil
}
func (f *fakeV3Store) ListEcommerceProducts(context.Context, *middleware.Tenant, string, int, int) (*EcommerceProductsResponse, error) {
	return &EcommerceProductsResponse{Products: []EcommerceProduct{{ID: "product_1", Title: "Product"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) UpsertEcommerceProduct(context.Context, *middleware.Tenant, string, string, EcommerceProductInput) (*EcommerceProduct, error) {
	return &EcommerceProduct{ID: "product_1", Title: "Product"}, nil
}
func (f *fakeV3Store) GetEcommerceProduct(context.Context, *middleware.Tenant, string, string) (*EcommerceProduct, error) {
	return &EcommerceProduct{ID: "product_1", Title: "Product"}, nil
}
func (f *fakeV3Store) DeleteEcommerceProduct(context.Context, *middleware.Tenant, string, string) error {
	return nil
}
func (f *fakeV3Store) ListEcommerceOrders(context.Context, *middleware.Tenant, string, int, int) (*EcommerceOrdersResponse, error) {
	return &EcommerceOrdersResponse{Orders: []EcommerceOrder{{ID: "order_1"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) UpsertEcommerceOrder(context.Context, *middleware.Tenant, string, string, EcommerceOrderInput) (*EcommerceOrder, error) {
	return &EcommerceOrder{ID: "order_1"}, nil
}
func (f *fakeV3Store) GetEcommerceOrder(context.Context, *middleware.Tenant, string, string) (*EcommerceOrder, error) {
	return &EcommerceOrder{ID: "order_1"}, nil
}
func (f *fakeV3Store) DeleteEcommerceOrder(context.Context, *middleware.Tenant, string, string) error {
	return nil
}
func (f *fakeV3Store) ListEcommerceCarts(context.Context, *middleware.Tenant, string, int, int) (*EcommerceCartsResponse, error) {
	return &EcommerceCartsResponse{Carts: []EcommerceCart{{ID: "cart_1"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) UpsertEcommerceCart(context.Context, *middleware.Tenant, string, string, EcommerceCartInput) (*EcommerceCart, error) {
	return &EcommerceCart{ID: "cart_1"}, nil
}
func (f *fakeV3Store) GetEcommerceCart(context.Context, *middleware.Tenant, string, string) (*EcommerceCart, error) {
	return &EcommerceCart{ID: "cart_1"}, nil
}
func (f *fakeV3Store) DeleteEcommerceCart(context.Context, *middleware.Tenant, string, string) error {
	return nil
}
func (f *fakeV3Store) ListEcommercePromoRules(context.Context, *middleware.Tenant, string, int, int) (*EcommercePromoRulesResponse, error) {
	return &EcommercePromoRulesResponse{PromoRules: []EcommercePromoRule{{ID: "rule_1", Title: "SAVE"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) UpsertEcommercePromoRule(context.Context, *middleware.Tenant, string, string, EcommercePromoRuleInput) (*EcommercePromoRule, error) {
	return &EcommercePromoRule{ID: "rule_1", Title: "SAVE"}, nil
}
func (f *fakeV3Store) GetEcommercePromoRule(context.Context, *middleware.Tenant, string, string) (*EcommercePromoRule, error) {
	return &EcommercePromoRule{ID: "rule_1", Title: "SAVE"}, nil
}
func (f *fakeV3Store) DeleteEcommercePromoRule(context.Context, *middleware.Tenant, string, string) error {
	return nil
}
func (f *fakeV3Store) CampaignPlanner(context.Context, *middleware.Tenant, PlannerQuery) (*CampaignPlannerResponse, error) {
	return &CampaignPlannerResponse{
		Touchpoints: []CampaignTouchpoint{{ID: "camp_1", Channel: "email", Name: "Launch", Status: "scheduled"}},
		Tasks:       []CampaignTask{{ID: "task_1", CampaignID: "camp_1", Title: "Review audience", Status: "open"}},
		Summary:     map[string]int{"email": 1},
	}, nil
}
func (f *fakeV3Store) GetMultivariateTest(context.Context, *middleware.Tenant, string) (*MultivariateTest, error) {
	return &MultivariateTest{
		CampaignID: "camp_1", Enabled: true, WinnerMetric: "open_rate", EvaluationWindowHours: 24,
		SamplePct: 25, WinnerRecipientsPct: 75,
		Variations: []MultivariateVariation{{ID: "var_a", Label: "A"}, {ID: "var_b", Label: "B"}},
		Dimensions: []string{"subject"},
		Limits:     map[string]any{"max_variations": 8},
	}, nil
}
func (f *fakeV3Store) UpsertMultivariateTest(context.Context, *middleware.Tenant, string, MultivariateTestInput) (*MultivariateTest, error) {
	return f.GetMultivariateTest(context.Background(), nil, "camp_1")
}
func (f *fakeV3Store) SendTimeOptimization(context.Context, *middleware.Tenant, string) (*SendTimeOptimizationResponse, error) {
	return &SendTimeOptimizationResponse{CampaignID: "camp_1", Recommendation: OptimizationRecommendation{Label: "10:00 UTC", Score: 12, Confidence: "medium"}}, nil
}
func (f *fakeV3Store) SendDayOptimization(context.Context, *middleware.Tenant, string) (*SendDayOptimizationResponse, error) {
	return &SendDayOptimizationResponse{CampaignID: "camp_1", Recommendation: OptimizationRecommendation{Label: "Tuesday", Score: 12, Confidence: "medium"}}, nil
}
func (f *fakeV3Store) ClickMap(context.Context, *middleware.Tenant, string) (*ClickMapResponse, error) {
	return &ClickMapResponse{CampaignID: "camp_1", TotalClicks: 2, Links: []ClickMapLink{{URL: "https://example.com", Clicks: 2}}}, nil
}
func (f *fakeV3Store) CustomReport(_ context.Context, _ *middleware.Tenant, in CustomReportInput) (*CustomReportResponse, error) {
	f.customReportInput = in
	return &CustomReportResponse{ID: "report_1", View: "table", Metrics: []string{"sent"}, GroupBy: []string{"campaign"}, Rows: []CustomReportRow{{Dimensions: map[string]string{"campaign": "Launch"}, Metrics: map[string]float64{"sent": 10}}}}, nil
}
func (f *fakeV3Store) DeliveryInsights(context.Context, *middleware.Tenant, string) (*DeliveryInsightsResponse, error) {
	return &DeliveryInsightsResponse{CampaignID: "camp_1", Status: "sending", CanCancel: true, Progress: map[string]int{"total": 10, "sent": 5}}, nil
}
func (f *fakeV3Store) CancelDelivery(context.Context, *middleware.Tenant, string) (*DeliveryInsightsResponse, error) {
	return &DeliveryInsightsResponse{CampaignID: "camp_1", Status: "cancelled", Cancelled: true, Progress: map[string]int{"cancelled": 5}}, nil
}
func (f *fakeV3Store) CampaignInbox(context.Context, *middleware.Tenant, string, int, int) (*CampaignInboxResponse, error) {
	return &CampaignInboxResponse{CampaignID: "camp_1", TotalItems: 1, Replies: []CampaignReply{{ID: "reply_1", EmailAddress: "reader@example.com"}}}, nil
}
func (f *fakeV3Store) MultiChannelReadiness(context.Context, *middleware.Tenant) (*MultiChannelReadinessResponse, error) {
	return &MultiChannelReadinessResponse{Channels: []ChannelCapability{{Feature: "hosted_surveys", Status: "available"}}, Summary: map[string]int{"surveys": 1}, OperationalMode: "planning_only_provider_credentials_required"}, nil
}
func (f *fakeV3Store) ListSocialProviderConnections(context.Context, *middleware.Tenant) (*SocialProviderConnectionsResponse, error) {
	return &SocialProviderConnectionsResponse{Connections: []SocialProviderConnection{{ID: "conn_1", Provider: "meta_pages", Status: "connected"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) UpsertSocialProviderConnection(context.Context, *middleware.Tenant, SocialProviderConnectionInput) (*SocialProviderConnection, error) {
	return &SocialProviderConnection{ID: "conn_1", Provider: "meta_pages", Status: "connected", Metadata: map[string]any{"credential_storage": "envelope_encrypted"}}, nil
}
func (f *fakeV3Store) ListSocialPosts(context.Context, *middleware.Tenant, int, int) (*SocialPostsResponse, error) {
	return &SocialPostsResponse{Posts: []SocialPost{{ID: "social_1", Network: "facebook", Status: "scheduled"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateSocialPost(context.Context, *middleware.Tenant, SocialPostInput) (*SocialPost, error) {
	return &SocialPost{ID: "social_1", Network: "facebook", Status: "scheduled"}, nil
}
func (f *fakeV3Store) SocialPostReport(context.Context, *middleware.Tenant, string) (*SocialPostReport, error) {
	return &SocialPostReport{PostID: "social_1", ProviderStatus: "requires_provider", Interactions: map[string]int{"clicks": 0}}, nil
}
func (f *fakeV3Store) ListAdCampaigns(context.Context, *middleware.Tenant, int, int) (*AdCampaignsResponse, error) {
	return &AdCampaignsResponse{Ads: []AdCampaign{{ID: "ad_1", Channel: "google_remarketing", Status: "draft"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateAdCampaign(context.Context, *middleware.Tenant, AdCampaignInput) (*AdCampaign, error) {
	return &AdCampaign{ID: "ad_1", Channel: "google_remarketing", Status: "draft"}, nil
}
func (f *fakeV3Store) AdCampaignReport(context.Context, *middleware.Tenant, string) (*AdCampaignReport, error) {
	return &AdCampaignReport{AdID: "ad_1", ProviderStatus: "requires_provider", Metrics: map[string]int{"clicks": 0}}, nil
}
func (f *fakeV3Store) DirectMailStatus(context.Context, *middleware.Tenant) (*DirectMailStatusResponse, error) {
	return &DirectMailStatusResponse{Status: "manual"}, nil
}
func (f *fakeV3Store) ListSurveys(context.Context, *middleware.Tenant, int, int) (*SurveysResponse, error) {
	return &SurveysResponse{Surveys: []Survey{{ID: "survey_1", Name: "NPS", Status: "published"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) CreateSurvey(context.Context, *middleware.Tenant, SurveyInput) (*Survey, error) {
	return &Survey{ID: "survey_1", Name: "NPS", Status: "draft"}, nil
}
func (f *fakeV3Store) SurveyReport(context.Context, *middleware.Tenant, string) (*SurveyReport, error) {
	return &SurveyReport{SurveyID: "survey_1", TotalResponses: 1}, nil
}
func (f *fakeV3Store) RecordSurveyResponse(context.Context, *middleware.Tenant, string, SurveyResponseInput) (*SurveyResponseReceipt, error) {
	return &SurveyResponseReceipt{ID: "resp_1", SurveyID: "survey_1"}, nil
}
func (f *fakeV3Store) PollMergeTags(context.Context, *middleware.Tenant, PollMergeTagInput) (*PollMergeTagResponse, error) {
	return &PollMergeTagResponse{SurveyID: "survey_1", QuestionID: "q_1", Tags: []PollMergeTag{{Choice: "Yes", Tag: "*|POLL|*"}}}, nil
}
func (f *fakeV3Store) LandingPageParity(context.Context, *middleware.Tenant) (*LandingPageParityResponse, error) {
	return &LandingPageParityResponse{Status: "available", Counts: map[string]int{"landing_pages": 1}}, nil
}
func (f *fakeV3Store) WebsiteBuilderStatus(context.Context, *middleware.Tenant) (*WebsiteBuilderStatusResponse, error) {
	return &WebsiteBuilderStatusResponse{Status: "not_native", Fallback: "landing_pages"}, nil
}
func (f *fakeV3Store) ListInterestCategories(context.Context, *middleware.Tenant, string) (*InterestCategoriesResponse, error) {
	return &InterestCategoriesResponse{Categories: []InterestCategory{{ID: "cat_1", Title: "Interests", InterestCount: 1}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) ListInterests(context.Context, *middleware.Tenant, string, string) (*InterestsResponse, error) {
	return &InterestsResponse{Interests: []Interest{{ID: "interest_1", Name: "Product"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) ContactRating(context.Context, *middleware.Tenant, string, string) (*ContactRatingResponse, error) {
	return &ContactRatingResponse{EmailAddress: "reader@example.com", Rating: 4, Evidence: map[string]int{"opened": 2}}, nil
}
func (f *fakeV3Store) ContactProfile(context.Context, *middleware.Tenant, string, string) (*ContactProfile, error) {
	return &ContactProfile{Member: *f.member, Rating: ContactRatingResponse{EmailAddress: "reader@example.com", Rating: 4}}, nil
}
func (f *fakeV3Store) AudienceInsights(context.Context, *middleware.Tenant, string) (*AudienceInsightsResponse, error) {
	return &AudienceInsightsResponse{ListID: "demo", ContactRatings: map[int]int{4: 1}, StatusCounts: map[string]int{"subscribed": 1}}, nil
}
func (f *fakeV3Store) AdvancedSegmentSchema(context.Context, *middleware.Tenant, string) (*AdvancedSegmentSchemaResponse, error) {
	return &AdvancedSegmentSchemaResponse{ListID: "demo", Dimensions: []SegmentDimension{{Key: "groups.*", Label: "Groups"}}}, nil
}
func (f *fakeV3Store) ContentStudio(context.Context, *middleware.Tenant) (*ContentStudioResponse, error) {
	return &ContentStudioResponse{Status: "available", Summary: map[string]int{"files": 1}, Files: []FileManagerFile{{ID: "file_1", Name: "Hero"}}}, nil
}
func (f *fakeV3Store) CreativeAssistant(context.Context, *middleware.Tenant, CreativeAssistantInput) (*CreativeAssistantResponse, error) {
	return &CreativeAssistantResponse{ID: "creative_1", SubjectLines: []string{"Launch"}, Checklist: []string{"Preview"}}, nil
}
func (f *fakeV3Store) InlineAI(context.Context, *middleware.Tenant, InlineAIInput) (*InlineAIResponse, error) {
	return &InlineAIResponse{Mode: "rewrite", Channel: "email", Text: "Better copy", Variants: []string{"Better copy"}, Metadata: map[string]any{}}, nil
}
func (f *fakeV3Store) ConvertVideo(context.Context, *middleware.Tenant, VideoConvertInput) (*VideoConvertResponse, error) {
	return &VideoConvertResponse{Provider: "youtube", VideoID: "abc", MergeTag: "*|VIDEO:abc|*", EmailHTML: "<a>Watch</a>"}, nil
}
func (f *fakeV3Store) ContentBlockCatalog(context.Context, *middleware.Tenant) (*MailchimpBlockCatalogResponse, error) {
	return &MailchimpBlockCatalogResponse{Blocks: []MailchimpBlockDefinition{{ID: "video", Name: "Video"}}, TotalItems: 1}, nil
}
func (f *fakeV3Store) PreviewMailchimpTemplate(context.Context, *middleware.Tenant, TemplateLanguagePreviewInput) (*TemplateLanguagePreviewResponse, error) {
	return &TemplateLanguagePreviewResponse{HTML: "Hi Ada", FoundTags: []string{"FNAME"}, RequiredFooterPresent: true}, nil
}

func TestApplyTagOperations(t *testing.T) {
	got := applyTagOperations([]string{"vip", "beta"}, []TagOperation{
		{Name: "VIP", Status: "inactive"},
		{Name: "new", Status: "active"},
	})
	if strings.Join(got, ",") != "beta,new" {
		t.Fatalf("tags = %v", got)
	}
}

func TestMailchimpV3TagsRoute(t *testing.T) {
	store := &fakeV3Store{member: &Member{
		ID: "hash", EmailAddress: "reader@example.com",
		Status: "subscribed", Tags: []Tag{{ID: 1, Name: "vip"}},
	}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t := &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001", Slug: "demo", Name: "Demo", Tier: "pro"}
			next.ServeHTTP(w, withV3TestPrincipal(r, t))
		})
	})
	Mount(router, &Deps{Store: store})

	req := httptest.NewRequest(http.MethodPost, "/3.0/lists/demo/members/hash/tags",
		strings.NewReader(`{"tags":[{"name":"vip","status":"inactive"},{"name":"new","status":"active"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.tagsInput.Tags) != 2 {
		t.Fatalf("tags input = %+v", store.tagsInput)
	}
	if !strings.Contains(rec.Body.String(), `"new"`) || strings.Contains(rec.Body.String(), `"vip"`) {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestMailchimpV3RejectsBadMemberEmail(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t := &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001", Slug: "demo", Name: "Demo", Tier: "pro"}
			next.ServeHTTP(w, withV3TestPrincipal(r, t))
		})
	})
	Mount(router, &Deps{Store: store})

	req := httptest.NewRequest(http.MethodPut, "/3.0/lists/demo/members/hash",
		strings.NewReader(`{"email_address":"not an email","status":"subscribed"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMailchimpMemberHandlersSeparateCreateAndTargetedUpdate(t *testing.T) {
	store := &fakeV3Store{member: &Member{
		ID: "hash", EmailAddress: "before@example.test", Status: "pending", LastChanged: time.Now(),
	}}
	router := testV3Router(store)

	createReq := httptest.NewRequest(http.MethodPost, "/3.0/lists/demo/members",
		strings.NewReader(`{"email_address":"Ada Lovelace <ADA@Example.Test>"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	router.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	if store.memberCreateCalls != 1 || store.memberUpdateCalls != 0 {
		t.Fatalf("create/update calls=%d/%d", store.memberCreateCalls, store.memberUpdateCalls)
	}
	if got := store.memberInput.EmailAddress; got != "ada@example.test" {
		t.Fatalf("display-name email normalized to %q; want bare mailbox", got)
	}
	if store.memberInput.Status != "" || store.memberInput.StatusIfNew != "" {
		t.Fatalf("omitted create status was synthesized in handler: %#v", store.memberInput)
	}

	updateReq := httptest.NewRequest(http.MethodPatch, "/3.0/lists/demo/members/path-target-hash",
		strings.NewReader(`{"email_address":"Grace Hopper <GRACE@Example.Test>","status_if_new":"subscribed"}`))
	updateReq.Header.Set("Content-Type", "application/json")
	updateRec := httptest.NewRecorder()
	router.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updateRec.Code, updateRec.Body.String())
	}
	if store.memberUpdateCalls != 1 || store.memberHash != "path-target-hash" {
		t.Fatalf("update calls/hash=%d/%q", store.memberUpdateCalls, store.memberHash)
	}
	if got := store.memberInput.EmailAddress; got != "grace@example.test" {
		t.Fatalf("update display-name email normalized to %q; want bare mailbox", got)
	}
	if store.memberInput.Status != "" {
		t.Fatalf("status_if_new became an existing-member status: %#v", store.memberInput)
	}
}

func TestMailchimpMemberCreateRequiresEmail(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", LastChanged: time.Now()}}
	req := httptest.NewRequest(http.MethodPost, "/3.0/lists/demo/members", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	testV3Router(store).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || store.memberCreateCalls != 0 {
		t.Fatalf("missing-email status=%d calls=%d body=%s", rec.Code, store.memberCreateCalls, rec.Body.String())
	}
}

func TestMailchimpV3DeveloperPlatformRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t := &middleware.Tenant{ID: "00000000-0000-0000-0000-0000000000d1", Slug: "demo", Name: "Demo", Tier: "pro"}
			next.ServeHTTP(w, withV3TestPrincipal(r, t))
		})
	})
	Mount(router, &Deps{Store: store})

	batchReq := httptest.NewRequest(http.MethodPost, "/3.0/batches",
		strings.NewReader(`{"operations":[{"method":"GET","path":"/lists","operation_id":"lists"},{"method":"GET","path":"/connected-sites","operation_id":"sites"}]}`))
	batchReq.Header.Set("Content-Type", "application/json")
	batchRec := httptest.NewRecorder()
	router.ServeHTTP(batchRec, batchReq)
	if batchRec.Code != http.StatusOK {
		t.Fatalf("batch status = %d body=%s", batchRec.Code, batchRec.Body.String())
	}
	if !strings.Contains(batchRec.Body.String(), `"finished_operations":2`) || !strings.Contains(batchRec.Body.String(), `"response_body_url"`) {
		t.Fatalf("unexpected batch body: %s", batchRec.Body.String())
	}

	exportReq := httptest.NewRequest(http.MethodPost, "/3.0/account-exports", strings.NewReader(`{"sections":["audiences","campaigns"]}`))
	exportReq.Header.Set("Content-Type", "application/json")
	exportRec := httptest.NewRecorder()
	router.ServeHTTP(exportRec, exportReq)
	if exportRec.Code != http.StatusAccepted {
		t.Fatalf("export status = %d body=%s", exportRec.Code, exportRec.Body.String())
	}
	if !strings.Contains(exportRec.Body.String(), `"campaigns":1`) || !strings.Contains(exportRec.Body.String(), `"download_url"`) {
		t.Fatalf("unexpected export body: %s", exportRec.Body.String())
	}
}

func TestMailchimpV3ConnectedSitesDomainsAndMarketplace(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t := &middleware.Tenant{ID: "00000000-0000-0000-0000-0000000000d2", Slug: "demo", Name: "Demo", Tier: "pro"}
			next.ServeHTTP(w, withV3TestPrincipal(r, t))
		})
	})
	Mount(router, &Deps{Store: store})

	siteReq := httptest.NewRequest(http.MethodPost, "/3.0/connected-sites",
		strings.NewReader(`{"domain":"example.com","name":"Example","platform":"custom","script_installed":true}`))
	siteReq.Header.Set("Content-Type", "application/json")
	siteRec := httptest.NewRecorder()
	router.ServeHTTP(siteRec, siteReq)
	if siteRec.Code != http.StatusCreated {
		t.Fatalf("site status = %d body=%s", siteRec.Code, siteRec.Body.String())
	}
	if !strings.Contains(siteRec.Body.String(), `"status":"verified"`) {
		t.Fatalf("unexpected site body: %s", siteRec.Body.String())
	}

	domainReq := httptest.NewRequest(http.MethodPost, "/3.0/verified-domains", strings.NewReader(`{"domain":"send.example.com"}`))
	domainReq.Header.Set("Content-Type", "application/json")
	domainRec := httptest.NewRecorder()
	router.ServeHTTP(domainRec, domainReq)
	if domainRec.Code != http.StatusCreated {
		t.Fatalf("domain status = %d body=%s", domainRec.Code, domainRec.Body.String())
	}
	if !strings.Contains(domainRec.Body.String(), `"dns_records"`) || !strings.Contains(domainRec.Body.String(), `"pending"`) {
		t.Fatalf("unexpected domain body: %s", domainRec.Body.String())
	}

	marketReq := httptest.NewRequest(http.MethodGet, "/3.0/integration-marketplace", nil)
	marketRec := httptest.NewRecorder()
	router.ServeHTTP(marketRec, marketReq)
	if marketRec.Code != http.StatusOK {
		t.Fatalf("market status = %d body=%s", marketRec.Code, marketRec.Body.String())
	}
	if !strings.Contains(marketRec.Body.String(), `"total_items":312`) || !strings.Contains(marketRec.Body.String(), `"hubspot"`) {
		t.Fatalf("unexpected marketplace body: %s", marketRec.Body.String())
	}
}

func TestMailchimpV3LongTailRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	for _, path := range []string{
		"/3.0/campaigns",
		"/3.0/campaigns/camp_1/content",
		"/3.0/templates",
		"/3.0/automations",
		"/3.0/ecommerce/stores",
		"/3.0/reports/camp_1/click-details",
		"/3.0/reports/camp_1/open-details",
		"/3.0/reports/camp_1/unsubscribed",
		"/3.0/reports/camp_1/abuse-reports",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestMailchimpV3P0CompatibilityRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	gets := []string{
		"/3.0/landing-pages",
		"/3.0/landing-pages/lp_1/content",
		"/3.0/file-manager/files",
		"/3.0/file-manager/files/file_1/usage",
		"/3.0/file-manager/folders",
		"/3.0/ecommerce/stores/store_1/products",
		"/3.0/ecommerce/stores/store_1/orders",
		"/3.0/ecommerce/stores/store_1/carts",
		"/3.0/ecommerce/stores/store_1/promo-rules",
		"/3.0/reports/camp_1/sent-to",
		"/3.0/reports/camp_1/domain-performance",
		"/3.0/batches",
		"/3.0/account-exports",
	}
	for _, path := range gets {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
		if strings.HasPrefix(path, "/3.0/reports/custom") && !strings.Contains(rec.Body.String(), `"report_1"`) {
			t.Fatalf("%s hit the wrong handler: %s", path, rec.Body.String())
		}
	}

	posts := []struct {
		path string
		body string
		want int
	}{
		{"/3.0/campaigns/camp_1/actions/schedule", `{"schedule_time":"2026-05-27T12:00:00Z"}`, http.StatusServiceUnavailable},
		{"/3.0/campaigns/camp_1/actions/replicate", `{}`, http.StatusOK},
		{"/3.0/landing-pages/lp_1/actions/publish", `{}`, http.StatusOK},
		{"/3.0/batches", `{"operations":[{"method":"GET","path":"/lists"}]}`, http.StatusOK},
		{"/3.0/account-exports", `{}`, http.StatusAccepted},
	}
	for _, tc := range posts {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d want %d body=%s", tc.path, rec.Code, tc.want, rec.Body.String())
		}
		if strings.Contains(tc.path, "/actions/schedule") &&
			!strings.Contains(rec.Body.String(), `"code":"campaign_compat_schedule_unavailable"`) {
			t.Fatalf("%s missing stable scheduling error: %s", tc.path, rec.Body.String())
		}
	}
}

func TestMailchimpCampaignScheduleIsScopeProtectedAndFailsBeforeStore(t *testing.T) {
	t.Parallel()

	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com"}}
	router := chi.NewRouter()
	Mount(router, &Deps{Store: store})
	tenant := &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000001", Slug: "demo", Name: "Demo", Tier: "pro",
	}

	serve := func(path string, scopes []apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"schedule_time":"2030-01-01T12:00:00Z"}`))
		req.Header.Set("Content-Type", "application/json")
		ctx := middleware.WithTenant(req.Context(), tenant)
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = apikeys.WithScopes(ctx, scopes)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}

	for _, base := range []string{"/3.0", "/api/mailchimp/3.0", "/api/v1/mailchimp/3.0"} {
		path := base + "/campaigns/camp_1/actions/schedule"
		for _, insufficient := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadCampaigns},
			{apikeys.ScopeSendTransactional},
		} {
			if rec := serve(path, insufficient); rec.Code != http.StatusForbidden {
				t.Errorf("%s scopes=%v status=%d, want 403; body=%s", path, insufficient, rec.Code, rec.Body.String())
			}
		}
		rec := serve(path, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
		if rec.Code != http.StatusServiceUnavailable ||
			!strings.Contains(rec.Body.String(), `"code":"campaign_compat_schedule_unavailable"`) {
			t.Errorf("%s response=(%d,%s), want stable disabled schedule response", path, rec.Code, rec.Body.String())
		}
	}
	if store.campaignActionCalls != 0 {
		t.Fatalf("disabled compatibility schedule reached store %d times", store.campaignActionCalls)
	}
}

func TestMailchimpV3ContentAICompatibilityRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	gets := []string{
		"/3.0/content-studio",
		"/3.0/content-blocks",
	}
	for _, path := range gets {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	csvReq := httptest.NewRequest(http.MethodGet, "/3.0/reports/custom?metrics=sent&group_by=campaign&format=csv&channel=sms&device=mobile", nil)
	csvRec := httptest.NewRecorder()
	router.ServeHTTP(csvRec, csvReq)
	if csvRec.Code != http.StatusOK {
		t.Fatalf("csv report status = %d body=%s", csvRec.Code, csvRec.Body.String())
	}
	if got := csvRec.Header().Get("Content-Type"); !strings.Contains(got, "text/csv") {
		t.Fatalf("csv content-type = %q", got)
	}
	if body := csvRec.Body.String(); !strings.Contains(body, "campaign,sent") || !strings.Contains(body, "Launch,10.0000") {
		t.Fatalf("unexpected csv body: %s", body)
	}
	if store.customReportInput.Filters["channel"] != "sms" || store.customReportInput.Filters["device"] != "mobile" {
		t.Fatalf("custom report filters = %+v", store.customReportInput.Filters)
	}

	posts := []struct {
		path string
		body string
	}{
		{"/3.0/creative-assistant/generate", `{"goal":"launch","channel":"email"}`},
		{"/3.0/builder/ai", `{"mode":"rewrite","text":"Hello"}`},
		{"/3.0/videos/email-convert", `{"url":"https://youtu.be/abc","title":"Demo"}`},
		{"/3.0/templates/preview-mailchimp", `{"html":"Hi *|FNAME|* *|UNSUB|*","variables":{"FNAME":"Ada"}}`},
	}
	for _, tc := range posts {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", tc.path, rec.Code, rec.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodPatch, "/3.0/file-manager/files/file_1", strings.NewReader(`{"name":"Hero updated","alt_text":"Hero image"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch file status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMailchimpV3P0ProblemShape(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	req := httptest.NewRequest(http.MethodPost, "/3.0/file-manager/files", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/problem+json") {
		t.Fatalf("content-type = %q", got)
	}
	if !strings.Contains(rec.Body.String(), `"title":"Invalid Resource"`) {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestMailchimpV3P1CompatibilityRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	gets := []string{
		"/3.0/campaign-manager/calendar",
		"/3.0/campaigns/camp_1/multivariate",
		"/3.0/campaigns/camp_1/send-time-optimization",
		"/3.0/campaigns/camp_1/send-day-optimization",
		"/3.0/campaigns/camp_1/delivery-insights",
		"/3.0/campaigns/camp_1/inbox",
		"/3.0/reports/camp_1/click-map",
		"/3.0/reports/custom?metrics=sent,opened&group_by=campaign",
	}
	for _, path := range gets {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	posts := []struct {
		path string
		body string
	}{
		{"/3.0/campaigns/camp_1/multivariate", `{"variations":[{"label":"A","subject_line":"A"},{"label":"B","subject_line":"B"}]}`},
		{"/3.0/campaigns/camp_1/delivery-insights/cancel", `{}`},
		{"/3.0/reports/custom", `{"metrics":["sent","clicked"],"group_by":["campaign"]}`},
	}
	for _, tc := range posts {
		method := http.MethodPost
		if strings.Contains(tc.path, "/multivariate") {
			method = http.MethodPut
		}
		req := httptest.NewRequest(method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestMailchimpV3P2CompatibilityRoutes(t *testing.T) {
	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	gets := []string{
		"/3.0/growth/channels",
		"/3.0/provider-connections",
		"/3.0/social-posts",
		"/3.0/social-posts/social_1/report",
		"/3.0/ads",
		"/3.0/ads/ad_1/report",
		"/3.0/postcards",
		"/3.0/surveys",
		"/3.0/surveys/survey_1/report",
		"/3.0/email/poll-merge-tags?survey_id=survey_1&question_id=q_1&choices=Yes,No",
		"/3.0/website-builder",
		"/3.0/landing-pages/parity",
		"/3.0/lists/demo/interest-categories",
		"/3.0/lists/demo/interest-categories/cat_1/interests",
		"/3.0/lists/demo/members/hash/rating",
		"/3.0/lists/demo/members/hash/profile",
		"/3.0/lists/demo/audience-insights",
		"/3.0/lists/demo/segments/advanced/schema",
		"/3.0/segments/advanced/schema",
	}
	for _, path := range gets {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	posts := []struct {
		path string
		body string
		want int
	}{
		{"/3.0/social-posts", `{"network":"facebook","text":"Launch"}`, http.StatusOK},
		{"/3.0/provider-connections", `{"provider":"meta_pages","account_id":"page_1","credentials":{"access_token":"token"}}`, http.StatusOK},
		{"/3.0/ads", `{"channel":"google_remarketing","name":"Remarketing","budget_cents":10000}`, http.StatusOK},
		{"/3.0/surveys", `{"name":"NPS","questions":[{"id":"q_1","type":"single_choice","label":"Recommend?","choices":["Yes","No"]}]}`, http.StatusOK},
		{"/3.0/surveys/survey_1/responses", `{"email":"reader@example.com","answers":{"q_1":"Yes"}}`, http.StatusAccepted},
		{"/3.0/email/poll-merge-tags", `{"survey_id":"survey_1","question_id":"q_1","choices":["Yes","No"]}`, http.StatusOK},
	}
	for _, tc := range posts {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d want %d body=%s", tc.path, rec.Code, tc.want, rec.Body.String())
		}
	}
}

func TestMailchimpV3P5LongTailCompatibilityRoutes(t *testing.T) {
	mailchimpCompatLongTailState.Lock()
	mailchimpCompatLongTailState.items = map[string]compatStateRecord{}
	mailchimpCompatLongTailState.Unlock()

	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	posts := []struct {
		path string
		body string
		want int
	}{
		{"/3.0/lists/demo/merge-fields", `{"tag":"BIRTHDAY","name":"Birthday","type":"date"}`, http.StatusCreated},
		{"/3.0/lists/demo/segments", `{"id":"seg_1","name":"VIP","type":"static"}`, http.StatusCreated},
		{"/3.0/lists/demo/segments/seg_1/members", `{"email_address":"vip@example.com"}`, http.StatusOK},
		{"/3.0/lists/demo/webhooks", `{"id":"wh_1","url":"https://example.com/mailchimp"}`, http.StatusCreated},
		{"/3.0/campaign-folders", `{"id":"folder_1","name":"Launches"}`, http.StatusCreated},
		{"/3.0/campaigns/camp_1/feedback", `{"id":"fb_1","message":"Tighten hero copy"}`, http.StatusCreated},
		{"/3.0/customer-journeys/journeys/j_1/steps/s_1/actions/trigger", `{"email_address":"reader@example.com"}`, http.StatusOK},
		{"/3.0/ecommerce/stores/store_1/customers", `{"id":"cust_1","email_address":"buyer@example.com"}`, http.StatusOK},
		{"/3.0/transactional/templates", `{"name":"Receipt","code":"<p>Thanks</p>"}`, http.StatusCreated},
		{"/3.0/transactional/messages/send-template", `{"template_name":"Receipt","to":[{"email":"buyer@example.com"}]}`, http.StatusAccepted},
	}
	for _, tc := range posts {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d want %d body=%s", tc.path, rec.Code, tc.want, rec.Body.String())
		}
	}

	gets := []struct {
		path string
		want string
	}{
		{"/3.0/lists/demo/merge-fields/BIRTHDAY", `"tag":"BIRTHDAY"`},
		{"/3.0/lists/demo/segments/seg_1/members", `"vip@example.com"`},
		{"/3.0/lists/demo/webhooks/wh_1", `"url":"https://example.com/mailchimp"`},
		{"/3.0/campaign-folders/folder_1", `"name":"Launches"`},
		{"/3.0/campaigns/camp_1/feedback/fb_1", `"message":"Tighten hero copy"`},
		{"/3.0/campaigns/camp_1/send-checklist", `"items"`},
		{"/3.0/ecommerce/stores/store_1/customers/cust_1", `"email_address":"buyer@example.com"`},
		{"/3.0/authorized-apps", `"postwave-mailchimp-compat"`},
		{"/3.0/transactional/catalog", `"foundation_ready_fail_closed"`},
		{"/3.0/transactional/templates", `"Receipt"`},
	}
	for _, tc := range gets {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body=%s", tc.path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("%s body missing %s: %s", tc.path, tc.want, rec.Body.String())
		}
	}
}

func TestMailchimpV3ParityWorkbenchRoutes(t *testing.T) {
	mailchimpCompatLongTailState.Lock()
	mailchimpCompatLongTailState.items = map[string]compatStateRecord{}
	mailchimpCompatLongTailState.Unlock()

	store := &fakeV3Store{member: &Member{ID: "hash", EmailAddress: "reader@example.com", LastChanged: time.Now()}}
	router := testV3Router(store)

	getReq := httptest.NewRequest(http.MethodGet, "/3.0/parity/workbench", nil)
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("workbench status = %d body=%s", getRec.Code, getRec.Body.String())
	}
	if body := getRec.Body.String(); !strings.Contains(body, `"tasks"`) || !strings.Contains(body, `"sms-mms-provider-program"`) {
		t.Fatalf("unexpected workbench body: %s", body)
	}
	if body := getRec.Body.String(); !strings.Contains(body, `"local_closures"`) || !strings.Contains(body, `"local_work_complete":true`) {
		t.Fatalf("workbench missing local closures: %s", body)
	}

	closuresReq := httptest.NewRequest(http.MethodGet, "/3.0/parity/local-closures", nil)
	closuresRec := httptest.NewRecorder()
	router.ServeHTTP(closuresRec, closuresReq)
	if closuresRec.Code != http.StatusOK {
		t.Fatalf("local closures status = %d body=%s", closuresRec.Code, closuresRec.Body.String())
	}
	if !strings.Contains(closuresRec.Body.String(), `"local_complete_count":8`) {
		t.Fatalf("unexpected local closures body: %s", closuresRec.Body.String())
	}

	applyReq := httptest.NewRequest(http.MethodPost, "/3.0/parity/local-closures/apply", strings.NewReader(`{}`))
	applyReq.Header.Set("Content-Type", "application/json")
	applyRec := httptest.NewRecorder()
	router.ServeHTTP(applyRec, applyReq)
	if applyRec.Code != http.StatusAccepted {
		t.Fatalf("local closure apply status = %d body=%s", applyRec.Code, applyRec.Body.String())
	}
	if !strings.Contains(applyRec.Body.String(), `"local_complete_external_gated"`) {
		t.Fatalf("unexpected local closure apply body: %s", applyRec.Body.String())
	}

	gateReq := httptest.NewRequest(http.MethodPatch, "/3.0/parity/provider-gates/sms_provider", strings.NewReader(`{"status":"configured","evidence":{"ticket":"sms-ok"}}`))
	gateReq.Header.Set("Content-Type", "application/json")
	gateRec := httptest.NewRecorder()
	router.ServeHTTP(gateRec, gateReq)
	if gateRec.Code != http.StatusOK {
		t.Fatalf("gate status = %d body=%s", gateRec.Code, gateRec.Body.String())
	}
	if !strings.Contains(gateRec.Body.String(), `"status":"configured"`) {
		t.Fatalf("unexpected gate body: %s", gateRec.Body.String())
	}

	taskReq := httptest.NewRequest(http.MethodPost, "/3.0/parity/tasks/sms-mms-provider-program/complete", strings.NewReader(`{"evidence":{"runbook":"approved"}}`))
	taskReq.Header.Set("Content-Type", "application/json")
	taskRec := httptest.NewRecorder()
	router.ServeHTTP(taskRec, taskReq)
	if taskRec.Code != http.StatusOK {
		t.Fatalf("task status = %d body=%s", taskRec.Code, taskRec.Body.String())
	}
	if !strings.Contains(taskRec.Body.String(), `"status":"complete"`) {
		t.Fatalf("unexpected task body: %s", taskRec.Body.String())
	}

	runReq := httptest.NewRequest(http.MethodPost, "/3.0/parity/activation-runs", strings.NewReader(`{"name":"Mailchimp final rehearsal"}`))
	runReq.Header.Set("Content-Type", "application/json")
	runRec := httptest.NewRecorder()
	router.ServeHTTP(runRec, runReq)
	if runRec.Code != http.StatusAccepted {
		t.Fatalf("activation status = %d body=%s", runRec.Code, runRec.Body.String())
	}
	if body := runRec.Body.String(); !strings.Contains(body, `"blocked_gates"`) || !strings.Contains(body, `"task_summary"`) {
		t.Fatalf("unexpected activation body: %s", body)
	}
}

func testV3Router(store Store) *chi.Mux {
	return testV3RouterWithMergeFields(store, newFakeMergeFieldSchemaStore())
}

func testV3RouterWithMergeFields(store Store, mergeFields MergeFieldSchemaStore) *chi.Mux {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t := &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001", Slug: "demo", Name: "Demo", Tier: "pro"}
			next.ServeHTTP(w, withV3TestPrincipal(r, t))
		})
	})
	Mount(router, &Deps{Store: store, MergeFields: mergeFields})
	return router
}
