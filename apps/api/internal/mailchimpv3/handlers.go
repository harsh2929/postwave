package mailchimpv3

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// EditLeaseGuard refuses a write while ANOTHER editor holds the campaign.
//
// A port, because this is a compatibility surface that must not grow a
// dependency on the campaigns package. The implementation lives there and takes
// the request, so "who is asking" has one definition across every guarded
// route rather than one per package.
//
// Nil means unguarded — an unwired composition must not make the compatibility
// surface unwritable.
type EditLeaseGuard interface {
	AssertRequestEditable(r *http.Request, tenantID, campaignID string) error
}

type Deps struct {
	Store       Store
	MergeFields MergeFieldSchemaStore

	// EditLease guards the content write below.
	//
	// This surface updates body_html, plain_text, body_mjml and content_blocks —
	// the campaign body itself — and its own header notes it is "reachable by
	// anyone holding an API key". It was outside the single-writer rule that
	// covers the first-party PATCH, so the compatibility route was the way
	// around the lease.
	EditLease EditLeaseGuard
}

const mailchimpCompatJSONMaxBodyBytes int64 = 512 << 10 // 512 KiB

func Mount(r chi.Router, d *Deps) {
	mountBase(r, "/3.0", d)
	mountBase(r, "/api/mailchimp/3.0", d)
	mountBase(r, "/api/v1/mailchimp/3.0", d)
}

func mountBase(r chi.Router, base string, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base, d.Root)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists", d.Lists)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}", d.GetList)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/members", d.ListMembers)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/members", d.CreateMember)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/members/{subscriber_hash}", d.GetMember)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/members/{subscriber_hash}/rating", d.ContactRating)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/members/{subscriber_hash}/profile", d.ContactProfile)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Put(base+"/lists/{list_id}/members/{subscriber_hash}", d.UpsertMember)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch(base+"/lists/{list_id}/members/{subscriber_hash}", d.UpsertMember)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/members/{subscriber_hash}/tags", d.ListMemberTags)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/members/{subscriber_hash}/tags", d.UpdateMemberTags)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/merge-fields", d.ListMergeFields)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/merge-fields", d.CreateMergeField)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/merge-fields/{merge_id}", d.GetMergeField)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch(base+"/lists/{list_id}/merge-fields/{merge_id}", d.UpdateMergeField)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete(base+"/lists/{list_id}/merge-fields/{merge_id}", d.DeleteMergeField)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/interest-categories", d.ListInterestCategories)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/interest-categories/{category_id}/interests", d.ListInterests)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/segments", d.ListSegments)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/segments", d.CreateSegment)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/lists/{list_id}/segments/advanced/schema", d.AdvancedSegmentSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/segments/{segment_id}", d.GetSegment)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch(base+"/lists/{list_id}/segments/{segment_id}", d.UpdateSegment)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/segments/{segment_id}", d.BatchUpdateSegmentMembers)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete(base+"/lists/{list_id}/segments/{segment_id}", d.DeleteSegment)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/segments/{segment_id}/members", d.ListSegmentMembers)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/segments/{segment_id}/members", d.AddSegmentMember)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete(base+"/lists/{list_id}/segments/{segment_id}/members/{subscriber_hash}", d.RemoveSegmentMember)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/webhooks", d.ListListWebhooks)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post(base+"/lists/{list_id}/webhooks", d.CreateListWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(base+"/lists/{list_id}/webhooks/{webhook_id}", d.GetListWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch(base+"/lists/{list_id}/webhooks/{webhook_id}", d.UpdateListWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete(base+"/lists/{list_id}/webhooks/{webhook_id}", d.DeleteListWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/lists/{list_id}/audience-insights", d.AudienceInsights)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaign-folders", d.ListCampaignFolders)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/campaign-folders", d.CreateCampaignFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaign-folders/{folder_id}", d.GetCampaignFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/campaign-folders/{folder_id}", d.UpdateCampaignFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/campaign-folders/{folder_id}", d.DeleteCampaignFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns", d.ListCampaigns)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/campaigns", d.CreateCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaign-manager/calendar", d.CampaignPlanner)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaign-manager/insights", d.CampaignPlanner)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/growth/channels", d.MultiChannelReadiness)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/audience/insights", d.AudienceInsights)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/provider-connections", d.ListSocialProviderConnections)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(base+"/provider-connections", d.UpsertSocialProviderConnection)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/social-posts", d.ListSocialPosts)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/social-posts", d.CreateSocialPost)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/social-posts/{post_id}/report", d.SocialPostReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/ads", d.ListAdCampaigns)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ads", d.CreateAdCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ads/{ad_id}/report", d.AdCampaignReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/facebook-ads", d.ListFacebookAds)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/facebook-ads", d.CreateFacebookAd)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/facebook-ads/{ad_id}/report", d.FacebookAdReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reporting/facebook-ads", d.ListFacebookAds)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reporting/facebook-ads/{ad_id}", d.FacebookAdReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/postcards", d.DirectMailStatus)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/surveys", d.ListSurveys)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/surveys", d.CreateSurvey)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/surveys/{survey_id}/report", d.SurveyReport)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/surveys/{survey_id}/responses", d.RecordSurveyResponse)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/email/poll-merge-tags", d.PollMergeTags)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/email/poll-merge-tags", d.PollMergeTags)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/website-builder", d.WebsiteBuilderStatus)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/segments/advanced/schema", d.AdvancedSegmentSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}", d.GetCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/content", d.CampaignContent)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/campaigns/{campaign_id}/content", d.UpdateCampaignContent)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/campaigns/{campaign_id}/content", d.UpdateCampaignContent)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/feedback", d.ListCampaignFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/campaigns/{campaign_id}/feedback", d.CreateCampaignFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/feedback/{feedback_id}", d.GetCampaignFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/campaigns/{campaign_id}/feedback/{feedback_id}", d.UpdateCampaignFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/campaigns/{campaign_id}/feedback/{feedback_id}", d.DeleteCampaignFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/send-checklist", d.CampaignSendChecklist)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/multivariate", d.GetMultivariateTest)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/campaigns/{campaign_id}/multivariate", d.UpsertMultivariateTest)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/send-time-optimization", d.SendTimeOptimization)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/campaigns/{campaign_id}/send-day-optimization", d.SendDayOptimization)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/campaigns/{campaign_id}/delivery-insights", d.DeliveryInsights)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/campaigns/{campaign_id}/delivery-insights/cancel", d.CancelDelivery)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/campaigns/{campaign_id}/inbox", d.CampaignInbox)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/campaigns/{campaign_id}/actions/{action}", d.CampaignAction)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/templates", d.ListTemplates)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/templates/{template_id}", d.GetTemplate)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/automations", d.ListAutomations)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/automations/{workflow_id}", d.GetAutomation)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/customer-journeys/journeys/{journey_id}/steps/{step_id}/actions/trigger", d.TriggerCustomerJourneyStep)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/landing-pages", d.ListLandingPages)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/landing-pages/parity", d.LandingPageParity)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/landing-pages", d.CreateLandingPage)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/landing-pages/{page_id}", d.GetLandingPage)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/landing-pages/{page_id}", d.PatchLandingPage)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/landing-pages/{page_id}/content", d.LandingPageContent)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/landing-pages/{page_id}/content", d.UpdateLandingPageContent)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/landing-pages/{page_id}/actions/{action}", d.LandingPageAction)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/content-studio", d.ContentStudio)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/content-blocks", d.ContentBlockCatalog)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/creative-assistant/generate", d.CreativeAssistant)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/builder/ai", d.InlineAI)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/videos/email-convert", d.ConvertVideo)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/templates/preview-mailchimp", d.PreviewMailchimpTemplate)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/template-language/preview", d.PreviewMailchimpTemplate)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/file-manager/files", d.ListFileManagerFiles)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/file-manager/files", d.CreateFileManagerFile)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/file-manager/files/{file_id}/usage", d.FileManagerFileUsage)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/file-manager/files/{file_id}", d.GetFileManagerFile)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/file-manager/files/{file_id}", d.UpdateFileManagerFile)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/file-manager/files/{file_id}", d.DeleteFileManagerFile)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/file-manager/folders", d.ListFileManagerFolders)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/file-manager/folders", d.CreateFileManagerFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/file-manager/folders/{folder_id}", d.GetFileManagerFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/file-manager/folders/{folder_id}", d.DeleteFileManagerFolder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores", d.ListEcommerceStores)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}", d.GetEcommerceStore)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/customers", d.ListEcommerceCustomers)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ecommerce/stores/{store_id}/customers", d.UpsertEcommerceCustomer)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/customers/{customer_id}", d.GetEcommerceCustomer)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/ecommerce/stores/{store_id}/customers/{customer_id}", d.UpsertEcommerceCustomer)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/ecommerce/stores/{store_id}/customers/{customer_id}", d.DeleteEcommerceCustomer)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/products", d.ListEcommerceProducts)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ecommerce/stores/{store_id}/products", d.UpsertEcommerceProduct)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/products/{product_id}", d.GetEcommerceProduct)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/ecommerce/stores/{store_id}/products/{product_id}", d.UpsertEcommerceProduct)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/ecommerce/stores/{store_id}/products/{product_id}", d.DeleteEcommerceProduct)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/orders", d.ListEcommerceOrders)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ecommerce/stores/{store_id}/orders", d.UpsertEcommerceOrder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/orders/{order_id}", d.GetEcommerceOrder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/ecommerce/stores/{store_id}/orders/{order_id}", d.UpsertEcommerceOrder)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/ecommerce/stores/{store_id}/orders/{order_id}", d.DeleteEcommerceOrder)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/carts", d.ListEcommerceCarts)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ecommerce/stores/{store_id}/carts", d.UpsertEcommerceCart)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/carts/{cart_id}", d.GetEcommerceCart)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/ecommerce/stores/{store_id}/carts/{cart_id}", d.UpsertEcommerceCart)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/ecommerce/stores/{store_id}/carts/{cart_id}", d.DeleteEcommerceCart)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/promo-rules", d.ListEcommercePromoRules)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/ecommerce/stores/{store_id}/promo-rules", d.UpsertEcommercePromoRule)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/ecommerce/stores/{store_id}/promo-rules/{rule_id}", d.GetEcommercePromoRule)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Put(base+"/ecommerce/stores/{store_id}/promo-rules/{rule_id}", d.UpsertEcommercePromoRule)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/ecommerce/stores/{store_id}/promo-rules/{rule_id}", d.DeleteEcommercePromoRule)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/custom", d.CustomReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post(base+"/reports/custom", d.CustomReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}", d.CampaignReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/email-activity", d.EmailActivity)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/click-details", d.ClickDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/click-map", d.ClickMap)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/click-details/{link_id}/members", d.ClickDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/open-details", d.OpenDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/sent-to", d.SentToDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/unsubscribed", d.UnsubscribedDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/abuse-reports", d.AbuseReportDetails)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/locations", d.ReportLocations)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/domain-performance", d.ReportDomainPerformance)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/eepurl", d.ReportEepURL)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/reports/{campaign_id}/advice", d.ReportAdvice)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/batches", d.ListBatches)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/batches", d.CreateBatch)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/batches/{batch_id}", d.GetBatch)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/batches/{batch_id}/response-body", d.BatchResponseBody)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/batches/{batch_id}", d.DeleteBatch)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/batch-webhooks", d.ListBatchWebhooks)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/batch-webhooks", d.CreateBatchWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/batch-webhooks/{webhook_id}", d.GetBatchWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/batch-webhooks/{webhook_id}", d.DeleteBatchWebhook)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/authorized-apps", d.ListAuthorizedApps)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/authorized-apps/{app_id}", d.GetAuthorizedApp)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/account-exports", d.ListAccountExports)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/account-exports", d.CreateAccountExport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/account-exports/{export_id}", d.GetAccountExport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/account-exports/{export_id}/download", d.DownloadAccountExport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/connected-sites", d.ListConnectedSites)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/connected-sites", d.CreateConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/connected-sites/{site_id}", d.GetConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/connected-sites/{site_id}", d.PatchConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/connected-sites/{site_id}/actions/verify-script", d.VerifyConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/connected-sites/{site_id}/actions/verify-script-installation", d.VerifyConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/connected-sites/{site_id}", d.DeleteConnectedSite)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/verified-domains", d.ListVerifiedDomains)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/verified-domains", d.CreateVerifiedDomain)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/verified-domains/{domain_id}", d.GetVerifiedDomain)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/verified-domains/{domain_id}/actions/verify", d.VerifyDomain)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete(base+"/verified-domains/{domain_id}", d.DeleteVerifiedDomain)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/integration-marketplace", d.IntegrationMarketplace)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/integrations", d.IntegrationMarketplace)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/agency-ecosystem", d.AgencyEcosystem)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/experts", d.AgencyEcosystem)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/parity/workbench", d.MailchimpParityWorkbench)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/parity/local-closures", d.MailchimpLocalClosures)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/parity/local-closures/apply", d.ApplyMailchimpLocalClosures)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/parity/tasks", d.UpsertMailchimpParityTask)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch(base+"/parity/tasks/{task_id}", d.UpsertMailchimpParityTask)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/parity/tasks/{task_id}/complete", d.CompleteMailchimpParityTask)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/parity/provider-gates", d.MailchimpProviderGates)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch(base+"/parity/provider-gates/{gate_id}", d.UpsertMailchimpProviderGate)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(base+"/parity/activation-runs", d.ListMailchimpActivationRuns)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(base+"/parity/activation-runs", d.CreateMailchimpActivationRun)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/transactional/catalog", d.TransactionalCatalog)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(base+"/transactional/templates", d.ListTransactionalTemplates)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/transactional/templates", d.UpsertTransactionalTemplate)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(base+"/transactional/messages/send-template", d.SendTransactionalTemplate)
}

func (d *Deps) Root(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id": "postwave",
		"login_id":   "postwave",
		"role":       "owner",
		"links": []map[string]string{
			{"rel": "lists", "href": "/api/mailchimp/3.0/lists", "method": "GET"},
			{"rel": "reports", "href": "/api/mailchimp/3.0/reports/{campaign_id}", "method": "GET"},
			{"rel": "campaign-manager", "href": "/api/mailchimp/3.0/campaign-manager/calendar", "method": "GET"},
			{"rel": "custom-reports", "href": "/api/mailchimp/3.0/reports/custom", "method": "POST"},
			{"rel": "multi-channel-readiness", "href": "/api/mailchimp/3.0/growth/channels", "method": "GET"},
			{"rel": "surveys", "href": "/api/mailchimp/3.0/surveys", "method": "GET"},
			{"rel": "audience-insights", "href": "/api/mailchimp/3.0/lists/{list_id}/audience-insights", "method": "GET"},
			{"rel": "content-studio", "href": "/api/mailchimp/3.0/content-studio", "method": "GET"},
			{"rel": "creative-assistant", "href": "/api/mailchimp/3.0/creative-assistant/generate", "method": "POST"},
			{"rel": "content-blocks", "href": "/api/mailchimp/3.0/content-blocks", "method": "GET"},
			{"rel": "batches", "href": "/api/mailchimp/3.0/batches", "method": "POST"},
			{"rel": "account-exports", "href": "/api/mailchimp/3.0/account-exports", "method": "POST"},
			{"rel": "connected-sites", "href": "/api/mailchimp/3.0/connected-sites", "method": "GET"},
			{"rel": "verified-domains", "href": "/api/mailchimp/3.0/verified-domains", "method": "GET"},
			{"rel": "integration-marketplace", "href": "/api/mailchimp/3.0/integration-marketplace", "method": "GET"},
			{"rel": "parity-workbench", "href": "/api/mailchimp/3.0/parity/workbench", "method": "GET"},
		},
	})
}

func (d *Deps) Lists(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListAudiences(r.Context(), t)
	if err != nil {
		writeProblem(w, http.StatusInternalServerError, "ListError", "an internal error occurred")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetList(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListAudiences(r.Context(), t)
	if err != nil {
		writeProblem(w, http.StatusInternalServerError, "ListError", "an internal error occurred")
		return
	}
	listID := chi.URLParam(r, "list_id")
	for _, l := range out.Lists {
		if listMatchesTenant(t, listID) && (l.ID == t.Slug || l.ID == listID || listID == "default") {
			writeJSON(w, http.StatusOK, l)
			return
		}
	}
	writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested list could not be found.")
}

func (d *Deps) ListMembers(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	q := MemberQuery{
		Offset: intQuery(r, "offset", 0),
		Count:  intQuery(r, "count", 10),
		Status: strings.TrimSpace(r.URL.Query().Get("status")),
	}
	out, err := d.Store.ListMembers(r.Context(), t, chi.URLParam(r, "list_id"), q)
	if err != nil {
		writeStoreError(w, err, "members")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateMember(w http.ResponseWriter, r *http.Request) {
	t, in, ok := d.decodeMemberWrite(w, r, true)
	if !ok {
		return
	}
	out, err := d.Store.CreateMember(r.Context(), t, chi.URLParam(r, "list_id"), in)
	if err != nil {
		writeStoreError(w, err, "member")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetMember(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetMember(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"))
	if err != nil {
		writeStoreError(w, err, "member")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpsertMember retains the historical route-handler name, but its contract is
// deliberately update-only: subscriber_hash identifies the locked target and
// a missing target returns 404. Collection creation lives in CreateMember.
func (d *Deps) UpsertMember(w http.ResponseWriter, r *http.Request) {
	t, in, ok := d.decodeMemberWrite(w, r, false)
	if !ok {
		return
	}
	out, err := d.Store.UpdateMember(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"), in)
	if err != nil {
		writeStoreError(w, err, "member")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) decodeMemberWrite(w http.ResponseWriter, r *http.Request, create bool) (*middleware.Tenant, MemberInput, bool) {
	t, ok := tenant(w, r)
	if !ok {
		return nil, MemberInput{}, false
	}
	var in MemberInput
	if err := httpbody.DecodeJSON(w, r, mailchimpCompatJSONMaxBodyBytes, &in); err != nil {
		status := httpbody.StatusCode(err)
		title := "JSONParseError"
		if status == http.StatusRequestEntityTooLarge {
			title = "Payload Too Large"
		}
		writeProblem(w, status, title, httpbody.PublicMessage(err))
		return nil, MemberInput{}, false
	}
	if strings.TrimSpace(in.EmailAddress) != "" {
		addr, err := mail.ParseAddress(in.EmailAddress)
		if err != nil || strings.TrimSpace(addr.Address) == "" {
			writeProblem(w, http.StatusBadRequest, "Invalid Resource", "email_address must be valid")
			return nil, MemberInput{}, false
		}
		// ParseAddress accepts the compatibility-friendly `Display Name
		// <address>` shape. Persist only the mailbox, never the display wrapper.
		in.EmailAddress = strings.ToLower(strings.TrimSpace(addr.Address))
	} else if create {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "email_address is required")
		return nil, MemberInput{}, false
	}
	statusRaw := in.Status
	if create {
		statusRaw = firstNonEmpty(in.Status, in.StatusIfNew)
	}
	status := normalizeMailchimpStatus(statusRaw)
	if status != "" && !validMailchimpStatus(status) {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "status must be subscribed, unsubscribed, non_subscribed, cleaned, pending, transactional, archived, or deleted")
		return nil, MemberInput{}, false
	}
	return t, in, true
}

func (d *Deps) ListMemberTags(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListMemberTags(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"))
	if err != nil {
		writeStoreError(w, err, "tags")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateMemberTags(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in TagsInput
	if err := httpbody.DecodeJSON(w, r, mailchimpCompatJSONMaxBodyBytes, &in); err != nil {
		status := httpbody.StatusCode(err)
		title := "JSONParseError"
		if status == http.StatusRequestEntityTooLarge {
			title = "Payload Too Large"
		}
		writeProblem(w, status, title, httpbody.PublicMessage(err))
		return
	}
	for _, op := range in.Tags {
		status := strings.ToLower(strings.TrimSpace(op.Status))
		if strings.TrimSpace(op.Name) == "" || (status != "active" && status != "inactive") {
			writeProblem(w, http.StatusBadRequest, "Invalid Resource", "each tag requires name and status active/inactive")
			return
		}
	}
	out, err := d.Store.UpdateMemberTags(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"), in)
	if err != nil {
		writeStoreError(w, err, "tags")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CampaignReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.CampaignReport(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "report")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListCampaigns(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListCampaigns(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "campaigns")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in CampaignInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.CreateCampaign(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "campaign")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetCampaign(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "campaign")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CampaignContent(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.CampaignContent(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "campaign content")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateCampaignContent(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	campaignID := chi.URLParam(r, "campaign_id")
	if d.EditLease != nil {
		if err := d.EditLease.AssertRequestEditable(r, t.ID, campaignID); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": map[string]any{"code": "edit_lease_held", "message": err.Error()},
			})
			return
		}
	}
	var in CampaignContent
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpdateCampaignContent(r.Context(), t, campaignID, in)
	if err != nil {
		writeStoreError(w, err, "campaign content")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CampaignAction(w http.ResponseWriter, r *http.Request) {
	action := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "action")))
	switch action {
	case "schedule":
		if _, ok := tenant(w, r); !ok {
			return
		}
		writeCampaignScheduleUnavailable(w)
	case "send", "unschedule", "test", "cancel-send":
		d.simpleCampaignAction(w, r, action)
	case "replicate":
		d.replicateCampaign(w, r, false)
	case "create-resend":
		d.replicateCampaign(w, r, true)
	default:
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested campaign action could not be found.")
	}
}

func (d *Deps) simpleCampaignAction(w http.ResponseWriter, r *http.Request, action string) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	payload := map[string]any{}
	if !decodeOptionalMailchimpJSON(w, r, &payload) {
		return
	}
	out, err := d.Store.CampaignAction(r.Context(), t, chi.URLParam(r, "campaign_id"), action, payload)
	if err != nil {
		writeStoreError(w, err, "campaign")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) replicateCampaign(w http.ResponseWriter, r *http.Request, resend bool) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ReplicateCampaign(r.Context(), t, chi.URLParam(r, "campaign_id"), resend)
	if err != nil {
		writeStoreError(w, err, "campaign")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) EmailActivity(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	offset := intQuery(r, "offset", 0)
	count := intQuery(r, "count", 10)
	out, err := d.Store.EmailActivity(r.Context(), t, chi.URLParam(r, "campaign_id"), offset, count)
	if err != nil {
		writeStoreError(w, err, "email activity")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ClickDetails(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "clicked")
}

func (d *Deps) OpenDetails(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "opened")
}

func (d *Deps) UnsubscribedDetails(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "unsubscribed")
}

func (d *Deps) AbuseReportDetails(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "complained")
}

func (d *Deps) reportEventDetails(w http.ResponseWriter, r *http.Request, eventType string) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ReportEventDetails(r.Context(), t, chi.URLParam(r, "campaign_id"), eventType, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "report details")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListTemplates(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListTemplates(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "templates")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetTemplate(r.Context(), t, chi.URLParam(r, "template_id"))
	if err != nil {
		writeStoreError(w, err, "template")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListAutomations(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListAutomations(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "automations")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetAutomation(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetAutomation(r.Context(), t, chi.URLParam(r, "workflow_id"))
	if err != nil {
		writeStoreError(w, err, "automation")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListEcommerceStores(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListEcommerceStores(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "ecommerce stores")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommerceStore(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetEcommerceStore(r.Context(), t, chi.URLParam(r, "store_id"))
	if err != nil {
		writeStoreError(w, err, "ecommerce store")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func tenant(w http.ResponseWriter, r *http.Request) (*middleware.Tenant, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeProblem(w, http.StatusUnauthorized, "API Key Missing", "Your request did not include a resolved Moosewave tenant.")
		return nil, false
	}
	return t, true
}

func writeStoreError(w http.ResponseWriter, err error, resource string) {
	if errors.Is(err, ErrCampaignSchedulingUnavailable) {
		writeCampaignScheduleUnavailable(w)
		return
	}
	if errors.Is(err, ErrCampaignDispatching) {
		writeProblem(w, http.StatusConflict, "Invalid Resource",
			"This campaign has started sending; its content can no longer be changed. "+
				"Duplicate it to send a revised version.")
		return
	}
	if errors.Is(err, ErrInvalidMember) {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "The member payload is invalid.")
		return
	}
	if errors.Is(err, ErrErasureBlocked) {
		writeProblem(w, http.StatusConflict, "Invalid Resource", "This address was permanently erased by a contact deletion or privacy request and can't be re-added.")
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "PW001":
			writeProblem(w, http.StatusBadRequest, "Invalid Resource", pgErr.Message)
			return
		case "PW002":
			writeProblem(w, http.StatusConflict, "Invalid Resource", "This merge field has stored subscriber values.")
			return
		}
	}
	if errors.Is(err, ErrNotFound) {
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested "+resource+" could not be found.")
		return
	}
	if errors.Is(err, ErrConflict) {
		writeProblem(w, http.StatusConflict, "Invalid Resource", "The requested "+resource+" is not in a state that allows this operation.")
		return
	}
	// Log before sanitising. Everything above this line is a CLASSIFIED failure
	// with a specific status; reaching here means the error was not recognised,
	// which is exactly the case an operator needs to see. The reply is
	// deliberately generic -- the Mailchimp problem writer must not leak
	// upstream or persistence detail -- so without this the cause existed
	// nowhere at all: no log line, and a body that says only "an internal error
	// occurred".
	//
	// This is the same silence that hid a broken API-key mint until a logger
	// was added there; this writer bypasses httperror.WriteInternal, so it
	// needed its own.
	slog.Default().Error("mailchimpv3.unclassified_store_error",
		slog.String("resource", resource),
		slog.String("err", errString(err)))
	writeProblem(w, http.StatusInternalServerError, "Internal Server Error", "an internal error occurred")
}

// errString is nil-safe: writeStoreError is reachable with a nil error from a
// caller that checked the wrong variable, and a panic in the error path would
// be a strictly worse outcome than a vague log line.
func errString(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func writeProblem(w http.ResponseWriter, status int, title, detail string) {
	httperror.WriteProblemJSON(w, httperror.Problem{
		Type:   "https://mailchimp.com/developer/marketing/docs/errors/",
		Title:  title,
		Status: status,
		Detail: detail,
		Extras: map[string]any{"instance": ""},
	})
}

// writeCampaignScheduleUnavailable is a fixed public policy response. It is
// intentionally separate from the generic problem writer, which sanitizes all
// unknown 5xx fields to internal_error. Every value below is a compile-time,
// operator-authored constant; no upstream or persistence detail can leak.
func writeCampaignScheduleUnavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", httperror.ContentTypeProblemJSON)
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":     "https://mailchimp.com/developer/marketing/docs/errors/",
		"title":    "Campaign Scheduling Unavailable",
		"status":   http.StatusServiceUnavailable,
		"detail":   "The Mailchimp-compatible schedule action is disabled until it delegates to Moosewave's governed campaign scheduling lifecycle.",
		"code":     "campaign_compat_schedule_unavailable",
		"instance": "",
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func intQuery(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func validMailchimpStatus(status string) bool {
	switch normalizeMailchimpStatus(status) {
	case "", "subscribed", "unsubscribed", "cleaned", "non_subscribed", "pending", "transactional", "archived", "deleted":
		return true
	default:
		return false
	}
}
