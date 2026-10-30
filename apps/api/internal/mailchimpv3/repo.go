package mailchimpv3

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/socialads"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

var (
	ErrNotFound                      = errors.New("mailchimp compatibility resource not found")
	ErrErasureBlocked                = errors.New("mailchimp compatibility member was previously erased")
	ErrInvalidMember                 = errors.New("mailchimp compatibility member input is invalid")
	ErrCampaignSchedulingUnavailable = errors.New("mailchimp compatibility campaign scheduling is unavailable")
	// ErrCampaignDispatching mirrors campaigns.ErrCampaignDispatching on this
	// compatibility surface: the campaign has begun sending, so its delivered
	// content is frozen.
	ErrCampaignDispatching = errors.New("mailchimp compatibility campaign content is frozen once sending has started")
)

type Store interface {
	ListAudiences(context.Context, *middleware.Tenant) (*ListResponse, error)
	ListMembers(context.Context, *middleware.Tenant, string, MemberQuery) (*MembersResponse, error)
	GetMember(context.Context, *middleware.Tenant, string, string) (*Member, error)
	CreateMember(context.Context, *middleware.Tenant, string, MemberInput) (*Member, error)
	UpdateMember(context.Context, *middleware.Tenant, string, string, MemberInput) (*Member, error)
	ListMemberTags(context.Context, *middleware.Tenant, string, string) (*TagsResponse, error)
	UpdateMemberTags(context.Context, *middleware.Tenant, string, string, TagsInput) (*TagsResponse, error)
	ListCampaigns(context.Context, *middleware.Tenant, int, int) (*CampaignsResponse, error)
	CreateCampaign(context.Context, *middleware.Tenant, CampaignInput) (*Campaign, error)
	GetCampaign(context.Context, *middleware.Tenant, string) (*Campaign, error)
	CampaignContent(context.Context, *middleware.Tenant, string) (*CampaignContent, error)
	UpdateCampaignContent(context.Context, *middleware.Tenant, string, CampaignContent) (*CampaignContent, error)
	CampaignAction(context.Context, *middleware.Tenant, string, string, map[string]any) (*CampaignActionResponse, error)
	ReplicateCampaign(context.Context, *middleware.Tenant, string, bool) (*Campaign, error)
	CampaignReport(context.Context, *middleware.Tenant, string) (*Report, error)
	EmailActivity(context.Context, *middleware.Tenant, string, int, int) (*EmailActivityResponse, error)
	ReportEventDetails(context.Context, *middleware.Tenant, string, string, int, int) (*ReportEventDetailsResponse, error)
	ListTemplates(context.Context, *middleware.Tenant, int, int) (*TemplatesResponse, error)
	GetTemplate(context.Context, *middleware.Tenant, string) (*Template, error)
	ListAutomations(context.Context, *middleware.Tenant, int, int) (*AutomationsResponse, error)
	GetAutomation(context.Context, *middleware.Tenant, string) (*Automation, error)
	ListEcommerceStores(context.Context, *middleware.Tenant, int, int) (*EcommerceStoresResponse, error)
	GetEcommerceStore(context.Context, *middleware.Tenant, string) (*EcommerceStore, error)
	ListLandingPages(context.Context, *middleware.Tenant, int, int) (*LandingPagesResponse, error)
	CreateLandingPage(context.Context, *middleware.Tenant, LandingPageInput) (*LandingPage, error)
	GetLandingPage(context.Context, *middleware.Tenant, string) (*LandingPage, error)
	LandingPageContent(context.Context, *middleware.Tenant, string) (*LandingPageContent, error)
	UpdateLandingPageContent(context.Context, *middleware.Tenant, string, LandingPageContent) (*LandingPageContent, error)
	SetLandingPageStatus(context.Context, *middleware.Tenant, string, string) (*LandingPage, error)
	ListFileManagerFiles(context.Context, *middleware.Tenant, int, int) (*FileManagerFilesResponse, error)
	CreateFileManagerFile(context.Context, *middleware.Tenant, FileManagerFileInput) (*FileManagerFile, error)
	GetFileManagerFile(context.Context, *middleware.Tenant, string) (*FileManagerFile, error)
	UpdateFileManagerFile(context.Context, *middleware.Tenant, string, FileManagerFileUpdate) (*FileManagerFile, error)
	FileManagerFileUsage(context.Context, *middleware.Tenant, string) (*FileManagerFileUsageResponse, error)
	DeleteFileManagerFile(context.Context, *middleware.Tenant, string) error
	ListFileManagerFolders(context.Context, *middleware.Tenant, int, int) (*FileManagerFoldersResponse, error)
	CreateFileManagerFolder(context.Context, *middleware.Tenant, FileManagerFolderInput) (*FileManagerFolder, error)
	GetFileManagerFolder(context.Context, *middleware.Tenant, string) (*FileManagerFolder, error)
	DeleteFileManagerFolder(context.Context, *middleware.Tenant, string) error
	ListEcommerceProducts(context.Context, *middleware.Tenant, string, int, int) (*EcommerceProductsResponse, error)
	UpsertEcommerceProduct(context.Context, *middleware.Tenant, string, string, EcommerceProductInput) (*EcommerceProduct, error)
	GetEcommerceProduct(context.Context, *middleware.Tenant, string, string) (*EcommerceProduct, error)
	DeleteEcommerceProduct(context.Context, *middleware.Tenant, string, string) error
	ListEcommerceOrders(context.Context, *middleware.Tenant, string, int, int) (*EcommerceOrdersResponse, error)
	UpsertEcommerceOrder(context.Context, *middleware.Tenant, string, string, EcommerceOrderInput) (*EcommerceOrder, error)
	GetEcommerceOrder(context.Context, *middleware.Tenant, string, string) (*EcommerceOrder, error)
	DeleteEcommerceOrder(context.Context, *middleware.Tenant, string, string) error
	ListEcommerceCarts(context.Context, *middleware.Tenant, string, int, int) (*EcommerceCartsResponse, error)
	UpsertEcommerceCart(context.Context, *middleware.Tenant, string, string, EcommerceCartInput) (*EcommerceCart, error)
	GetEcommerceCart(context.Context, *middleware.Tenant, string, string) (*EcommerceCart, error)
	DeleteEcommerceCart(context.Context, *middleware.Tenant, string, string) error
	ListEcommercePromoRules(context.Context, *middleware.Tenant, string, int, int) (*EcommercePromoRulesResponse, error)
	UpsertEcommercePromoRule(context.Context, *middleware.Tenant, string, string, EcommercePromoRuleInput) (*EcommercePromoRule, error)
	GetEcommercePromoRule(context.Context, *middleware.Tenant, string, string) (*EcommercePromoRule, error)
	DeleteEcommercePromoRule(context.Context, *middleware.Tenant, string, string) error
	CampaignPlanner(context.Context, *middleware.Tenant, PlannerQuery) (*CampaignPlannerResponse, error)
	GetMultivariateTest(context.Context, *middleware.Tenant, string) (*MultivariateTest, error)
	UpsertMultivariateTest(context.Context, *middleware.Tenant, string, MultivariateTestInput) (*MultivariateTest, error)
	SendTimeOptimization(context.Context, *middleware.Tenant, string) (*SendTimeOptimizationResponse, error)
	SendDayOptimization(context.Context, *middleware.Tenant, string) (*SendDayOptimizationResponse, error)
	ClickMap(context.Context, *middleware.Tenant, string) (*ClickMapResponse, error)
	CustomReport(context.Context, *middleware.Tenant, CustomReportInput) (*CustomReportResponse, error)
	DeliveryInsights(context.Context, *middleware.Tenant, string) (*DeliveryInsightsResponse, error)
	CancelDelivery(context.Context, *middleware.Tenant, string) (*DeliveryInsightsResponse, error)
	CampaignInbox(context.Context, *middleware.Tenant, string, int, int) (*CampaignInboxResponse, error)
	MultiChannelReadiness(context.Context, *middleware.Tenant) (*MultiChannelReadinessResponse, error)
	ListSocialProviderConnections(context.Context, *middleware.Tenant) (*SocialProviderConnectionsResponse, error)
	UpsertSocialProviderConnection(context.Context, *middleware.Tenant, SocialProviderConnectionInput) (*SocialProviderConnection, error)
	ListSocialPosts(context.Context, *middleware.Tenant, int, int) (*SocialPostsResponse, error)
	CreateSocialPost(context.Context, *middleware.Tenant, SocialPostInput) (*SocialPost, error)
	SocialPostReport(context.Context, *middleware.Tenant, string) (*SocialPostReport, error)
	ListAdCampaigns(context.Context, *middleware.Tenant, int, int) (*AdCampaignsResponse, error)
	CreateAdCampaign(context.Context, *middleware.Tenant, AdCampaignInput) (*AdCampaign, error)
	AdCampaignReport(context.Context, *middleware.Tenant, string) (*AdCampaignReport, error)
	DirectMailStatus(context.Context, *middleware.Tenant) (*DirectMailStatusResponse, error)
	ListSurveys(context.Context, *middleware.Tenant, int, int) (*SurveysResponse, error)
	CreateSurvey(context.Context, *middleware.Tenant, SurveyInput) (*Survey, error)
	SurveyReport(context.Context, *middleware.Tenant, string) (*SurveyReport, error)
	RecordSurveyResponse(context.Context, *middleware.Tenant, string, SurveyResponseInput) (*SurveyResponseReceipt, error)
	PollMergeTags(context.Context, *middleware.Tenant, PollMergeTagInput) (*PollMergeTagResponse, error)
	LandingPageParity(context.Context, *middleware.Tenant) (*LandingPageParityResponse, error)
	WebsiteBuilderStatus(context.Context, *middleware.Tenant) (*WebsiteBuilderStatusResponse, error)
	ListInterestCategories(context.Context, *middleware.Tenant, string) (*InterestCategoriesResponse, error)
	ListInterests(context.Context, *middleware.Tenant, string, string) (*InterestsResponse, error)
	ContactRating(context.Context, *middleware.Tenant, string, string) (*ContactRatingResponse, error)
	ContactProfile(context.Context, *middleware.Tenant, string, string) (*ContactProfile, error)
	AudienceInsights(context.Context, *middleware.Tenant, string) (*AudienceInsightsResponse, error)
	AdvancedSegmentSchema(context.Context, *middleware.Tenant, string) (*AdvancedSegmentSchemaResponse, error)
	ContentStudio(context.Context, *middleware.Tenant) (*ContentStudioResponse, error)
	CreativeAssistant(context.Context, *middleware.Tenant, CreativeAssistantInput) (*CreativeAssistantResponse, error)
	InlineAI(context.Context, *middleware.Tenant, InlineAIInput) (*InlineAIResponse, error)
	ConvertVideo(context.Context, *middleware.Tenant, VideoConvertInput) (*VideoConvertResponse, error)
	ContentBlockCatalog(context.Context, *middleware.Tenant) (*MailchimpBlockCatalogResponse, error)
	PreviewMailchimpTemplate(context.Context, *middleware.Tenant, TemplateLanguagePreviewInput) (*TemplateLanguagePreviewResponse, error)
}

type MemberQuery struct {
	Offset int
	Count  int
	Status string
}

type Repo struct {
	Pool         *db.Pool
	SocialAds    *socialads.Registry
	SecretCipher SecretCipher
	LegacyKEK    []byte
}

type SecretCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

func (r *Repo) ListAudiences(ctx context.Context, tenant *middleware.Tenant) (*ListResponse, error) {
	stats, err := r.audienceStats(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	list := audienceFromTenant(tenant, stats)
	return &ListResponse{Lists: []AudienceList{list}, TotalItems: 1}, nil
}

func (r *Repo) ListMembers(ctx context.Context, tenant *middleware.Tenant, listID string, q MemberQuery) (*MembersResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	q = normalizeMemberQuery(q)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenant.ID}
	where := ` WHERE tenant_id = $1::uuid`
	if q.Status != "" {
		args = append(args, q.Status)
		where += fmt.Sprintf(` AND mailchimp_status = $%d`, len(args))
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers`+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	args = append(args, q.Count, q.Offset)
	rows, err := tx.Query(ctx, memberSelectSQL+where+fmt.Sprintf(`
	ORDER BY updated_at DESC
	LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, err
	}
	members, err := scanMembers(rows, tenant)
	if err != nil {
		return nil, err
	}
	return &MembersResponse{Members: members, ListID: tenant.Slug, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) GetMember(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string) (*Member, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, memberSelectSQL+`
	WHERE tenant_id = $1::uuid
	  AND (md5(lower(email::text)) = lower($2) OR lower(email::text) = lower($2))
	LIMIT 1`, tenant.ID, subscriberHash)
	m, err := scanMember(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return m, tx.Commit(ctx)
}

// CreateMember implements the collection POST contract. Unlike a path write,
// it never treats a body email as an instruction to update an existing member.
// A missing status is intentionally non-sendable and carries no fabricated
// consent evidence; an authenticated caller must explicitly request a
// Mailchimp lifecycle status to create a subscribed member.
func (r *Repo) CreateMember(ctx context.Context, tenant *middleware.Tenant, listID string, in MemberInput) (*Member, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	email, err := normalizeMemberEmail(in.EmailAddress)
	if err != nil || email == "" {
		return nil, ErrInvalidMember
	}
	statusRaw := firstNonEmpty(in.Status, in.StatusIfNew)
	mcStatus := "non_subscribed"
	status := "unconfirmed"
	if strings.TrimSpace(statusRaw) != "" {
		mcStatus = normalizeMailchimpStatus(statusRaw)
		status = postwaveStatus(mcStatus)
	}
	decision := reviewMemberActivation(statusRaw, email, in.PostwaveConsent)
	if decision.Requested {
		// Persist the useful profile and requested membership, but never let a
		// Mailchimp status string cross the canonical activation boundary.
		status = "unconfirmed"
		mcStatus = "pending"
	}
	var consentAt *time.Time
	consentSource := "unknown"
	now := time.Now().UTC()
	merge, _ := json.Marshal(nonNilMap(in.MergeFields))
	groups, _ := json.Marshal(interestsToGroups(in.Interests))
	activity, _ := json.Marshal(memberConsentActivity(decision, statusRaw))
	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := rejectErasedMemberEmail(ctx, tx, tenant.ID, email); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
	INSERT INTO subscribers (
	    tenant_id, email, primary_email, status, mailchimp_status,
	    consent_timestamp, consent_source, custom_fields, merge_fields, tags,
	    groups, gdpr_permissions, signup_ip, mailchimp_last_changed,
	    activity_summary, source_platform
	)
	VALUES (
	    $1::uuid, $2, $2, $3, $4, $5, $6, '{}'::jsonb, $7::jsonb, $8,
	    $9::jsonb, '[]'::jsonb, NULLIF($10, '')::inet, $11, $12::jsonb,
	    'mailchimp_api'
	)
	RETURNING `+memberColumns,
		tenant.ID, email, status, mcStatus, consentAt, consentSource,
		string(merge), tags, string(groups), firstNonEmpty(in.IPOpt, in.IPSignup),
		now, string(activity))
	m, err := scanMember(row, tenant)
	if memberConflict(err) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if !decision.Activate {
		return m, nil
	}
	if err := r.activateReviewedMember(ctx, tenant.ID, m.ContactID, decision.Evidence); err != nil {
		// The profile is already committed in a non-sendable pending state.
		// Return that precise state so retries cannot accidentally become an
		// upsert/reactivation and so operators know a reviewed retry is needed.
		m.Status = "pending"
		m.Sendable = false
		m.ConsentReviewStatus = "review_required"
		m.ConsentReviewReason = "canonical_consent_activation_failed_review_required"
		m.ConsentPurpose = mailchimpConsentPurpose
		return m, nil
	}
	return r.GetMember(ctx, tenant, listID, email)
}

// UpdateMember implements PUT/PATCH member semantics. subscriberHash is the
// sole target selector. email_address, when present, is a rotation of that
// locked target; it can never redirect the operation into an INSERT or an
// upsert of a different member.
func (r *Repo) UpdateMember(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string, in MemberInput) (*Member, error) {
	if !listMatchesTenant(tenant, listID) || strings.TrimSpace(subscriberHash) == "" {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// An explicit email_address can rotate canonical identity. Take the
	// exclusive fence before locking the member row so queue admission's shared
	// fence and this compatibility path have one deadlock-free order.
	if strings.TrimSpace(in.EmailAddress) != "" {
		if err := subscriberidentitylock.Tenant(ctx, tx, tenant.ID); err != nil {
			return nil, err
		}
	}

	row := tx.QueryRow(ctx, memberSelectSQL+`
	 WHERE tenant_id = $1::uuid
	   AND (md5(lower(email::text)) = lower($2) OR lower(email::text) = lower($2))
	 LIMIT 1
	 FOR UPDATE`, tenant.ID, subscriberHash)
	current, err := scanMember(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	email := current.EmailAddress
	if strings.TrimSpace(in.EmailAddress) != "" {
		email, err = normalizeMemberEmail(in.EmailAddress)
		if err != nil || email == "" {
			return nil, ErrInvalidMember
		}
	}
	if err := rejectErasedMemberEmail(ctx, tx, tenant.ID, email); err != nil {
		return nil, err
	}
	if !strings.EqualFold(current.EmailAddress, email) {
		var occupied bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscribers
     WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
       AND id <> $3::uuid
    UNION ALL
    SELECT 1 FROM subscriber_emails
     WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
       AND subscriber_id <> $3::uuid
)`, tenant.ID, email, current.ContactID).Scan(&occupied); err != nil {
			return nil, err
		}
		if occupied {
			return nil, ErrConflict
		}
	}

	statusProvided := strings.TrimSpace(in.Status) != ""
	mcStatus := normalizeMailchimpStatus(in.Status)
	status := postwaveStatus(mcStatus)
	emailChanged := !strings.EqualFold(current.EmailAddress, email)
	decision := reviewMemberActivation(in.Status, email, in.PostwaveConsent)
	lifecycleProvided := statusProvided
	clearLegacyConsent := false
	if decision.Requested {
		// A subscribed request is parked pending before the canonical workflow
		// runs. Historical consent_timestamp is intentionally cleared and can
		// never satisfy this new exact-address review.
		lifecycleProvided = true
		mcStatus = "pending"
		switch current.CanonicalStatus {
		case "disabled", "blocklisted":
			status = current.CanonicalStatus
		default:
			status = "unconfirmed"
		}
		clearLegacyConsent = true
	} else if statusProvided {
		// Every explicit non-subscribed lifecycle request is immediately
		// fail-closed, including unsubscribe/cleaned/pending transitions.
		clearLegacyConsent = status != "enabled"
	}
	if emailChanged && !statusProvided && current.CanonicalStatus == "enabled" {
		// Consent is address-bound. Rotating an active profile without an
		// explicit reviewed subscribed request demotes it until the new exact
		// address is reviewed through this envelope or the subscriber API.
		lifecycleProvided = true
		status = "unconfirmed"
		mcStatus = "pending"
		clearLegacyConsent = true
		decision = memberConsentDecision{
			Requested: true,
			Status:    "review_required",
			Reason:    "new_email_address_requires_reviewed_consent",
			Purpose:   mailchimpConsentPurpose,
		}
	}
	now := time.Now().UTC()
	mergeFieldsProvided := in.MergeFields != nil
	groupsProvided := in.Interests != nil
	tagsProvided := in.Tags != nil
	merge, _ := json.Marshal(nonNilMap(in.MergeFields))
	groups, _ := json.Marshal(interestsToGroups(in.Interests))
	activity, _ := json.Marshal(memberConsentActivity(decision, in.Status))
	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}
	row = tx.QueryRow(ctx, `
	UPDATE subscribers SET
	  email = $3,
	  primary_email = CASE
	      WHEN primary_email IS NULL OR lower(primary_email::text) = lower(email::text) THEN $3
	      ELSE primary_email
	  END,
	  status = CASE
	      WHEN $12::boolean THEN $4
	      ELSE status
	  END,
	  mailchimp_status = CASE WHEN $12::boolean THEN $5 ELSE mailchimp_status END,
	  consent_timestamp = CASE WHEN $16::boolean THEN NULL ELSE consent_timestamp END,
	  consent_source = CASE WHEN $16::boolean THEN 'unknown' ELSE consent_source END,
	  merge_fields = CASE WHEN $11::boolean THEN $6::jsonb ELSE merge_fields END,
	  tags = CASE WHEN $14::boolean THEN $7 ELSE tags END,
	  groups = CASE WHEN $13::boolean THEN $8::jsonb ELSE groups END,
	  signup_ip = COALESCE(NULLIF($9, '')::inet, signup_ip),
	  mailchimp_last_changed = $10,
	  activity_summary = activity_summary || $15::jsonb,
	  updated_at = now()
	 WHERE tenant_id = $1::uuid AND id = $2::uuid
	 RETURNING `+memberColumns,
		tenant.ID, current.ContactID, email, status, mcStatus, string(merge), tags,
		string(groups), firstNonEmpty(in.IPOpt, in.IPSignup), now,
		mergeFieldsProvided, lifecycleProvided, groupsProvided, tagsProvided,
		string(activity), clearLegacyConsent)
	m, err := scanMember(row, tenant)
	if memberConflict(err) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if emailChanged {
		if err := rotateMemberAddress(ctx, tx, tenant.ID, current.ContactID, current.EmailAddress, email); err != nil {
			if memberConflict(err) {
				return nil, ErrConflict
			}
			return nil, err
		}
		if err := subscribers.RepointSubscriberEmail(ctx, tx, tenant.ID, current.EmailAddress, email); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if !decision.Activate {
		return m, nil
	}
	if err := r.activateReviewedMember(ctx, tenant.ID, m.ContactID, decision.Evidence); err != nil {
		// The profile/update transaction has already committed in a non-sendable
		// state. Surface that state explicitly: the compatibility request did not
		// activate sending and a reviewed retry is required.
		m.Status = "pending"
		m.Sendable = false
		m.ConsentReviewStatus = "review_required"
		m.ConsentReviewReason = "canonical_consent_activation_failed_review_required"
		m.ConsentPurpose = mailchimpConsentPurpose
		return m, nil
	}
	return r.GetMember(ctx, tenant, listID, email)
}

func normalizeMemberEmail(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil || strings.TrimSpace(addr.Address) == "" {
		return "", ErrInvalidMember
	}
	return strings.ToLower(strings.TrimSpace(addr.Address)), nil
}

// rejectErasedMemberEmail refuses to create a member at, or move one onto, an
// address an irreversible erasure tombstone protects. It asks the same
// predicate as every native subscriber writer, so the hash-only tombstone a
// privacy request leaves blocks the compatibility API exactly as a contact
// delete does.
func rejectErasedMemberEmail(ctx context.Context, tx pgx.Tx, tenantID, email string) error {
	erased, err := suppressions.ErasedAddresses(ctx, tx, tenantID, []string{email})
	if err != nil {
		return err
	}
	if len(erased) > 0 {
		return ErrErasureBlocked
	}
	return nil
}

func rotateMemberAddress(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, oldEmail, newEmail string) error {
	if strings.EqualFold(oldEmail, newEmail) {
		return nil
	}
	// Preserve a same-profile alias at the destination when present. Otherwise
	// replace the former primary address with an explicit unknown-consent row;
	// the subscriber-row status remains the lifecycle authority.
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary = false, updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND is_primary`, tenantID, subscriberID); err != nil {
		return err
	}
	var destinationID *string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
 LIMIT 1`, tenantID, subscriberID, newEmail).Scan(&destinationID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if destinationID != nil {
		if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET email = $3, is_primary = true, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, *destinationID, newEmail); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
DELETE FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriberID, oldEmail)
		return err
	}
	ct, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET email = $4, is_primary = true, consent_status = 'unknown', updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriberID, oldEmail, newEmail)
	if err != nil {
		return err
	}
	if ct.RowsAffected() > 0 {
		return nil
	}
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_emails
    (tenant_id, subscriber_id, email, is_primary, consent_status)
VALUES ($1::uuid, $2::uuid, $3, true, 'unknown')`, tenantID, subscriberID, newEmail)
	return err
}

func memberConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (r *Repo) ListMemberTags(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string) (*TagsResponse, error) {
	m, err := r.GetMember(ctx, tenant, listID, subscriberHash)
	if err != nil {
		return nil, err
	}
	return tagsResponse(m.Tags), nil
}

func (r *Repo) UpdateMemberTags(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string, in TagsInput) (*TagsResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	cur, err := r.GetMember(ctx, tenant, listID, subscriberHash)
	if err != nil {
		return nil, err
	}
	tags := applyTagOperations(tagNames(cur.Tags), in.Tags)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
	UPDATE subscribers
	   SET tags = $3,
	       updated_at = now()
	 WHERE tenant_id = $1::uuid
	   AND md5(lower(email::text)) = lower($2)`, tenant.ID, subscriberHash, tags)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 && strings.Contains(subscriberHash, "@") {
		tag, err = tx.Exec(ctx, `
		UPDATE subscribers
		   SET tags = $3,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND lower(email::text) = lower($2)`, tenant.ID, subscriberHash, tags)
		if err != nil {
			return nil, err
		}
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return tagsResponseFromStrings(tags), tx.Commit(ctx)
}

func (r *Repo) ListCampaigns(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*CampaignsResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaigns WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, campaignSelectSQL+`
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	campaigns, err := scanCampaigns(rows, tenant)
	if err != nil {
		return nil, err
	}
	return &CampaignsResponse{Campaigns: campaigns, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) GetCampaign(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*Campaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, campaignSelectSQL+`
WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, campaignID)
	c, err := scanCampaign(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, tx.Commit(ctx)
}

func (r *Repo) CampaignContent(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*CampaignContent, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var html, mjml, plain string
	var blocksRaw []byte
	err = tx.QueryRow(ctx, `
SELECT COALESCE(body_html, ''), COALESCE(body_mjml, ''), COALESCE(plain_text, ''), content_blocks
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, campaignID).
		Scan(&html, &mjml, &plain, &blocksRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var blocks []map[string]any
	_ = json.Unmarshal(blocksRaw, &blocks)
	if blocks == nil {
		blocks = []map[string]any{}
	}
	out := &CampaignContent{
		HTML:        html,
		PlainText:   plain,
		ArchiveHTML: html,
		Blocks:      blocks,
		Template:    map[string]any{"type": "postwave", "mjml": mjml},
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CampaignReport(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*Report, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var report Report
	var title, typ string
	var sentAt *time.Time
	if err := tx.QueryRow(ctx, `
	SELECT id::text, name, campaign_type, sent_at
	  FROM campaigns
	 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, campaignID).
		Scan(&report.ID, &title, &typ, &sentAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	report.CampaignTitle = title
	report.Type = defaulted(typ, "regular")
	report.ListID = tenant.Slug
	report.SendTime = sentAt
	var delivered, opened, clicked, bounced, complained, revenueCents int
	if err := tx.QueryRow(ctx, `
	SELECT
	  count(*) FILTER (WHERE event_type IN ('sent','delivered')),
	  count(*) FILTER (WHERE event_type = 'delivered'),
	  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened'),
	  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked'),
	  count(*) FILTER (WHERE event_type = 'bounced'),
	  count(*) FILTER (WHERE event_type = 'complained'),
	  count(*) FILTER (WHERE event_type = 'unsubscribed'),
	  count(*) FILTER (WHERE event_type = 'conversion'),
	  COALESCE(sum(revenue_cents), 0)
	FROM campaign_report_events
	WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenant.ID, campaignID).
		Scan(&report.EmailsSent, &delivered, &opened, &clicked, &bounced, &complained, &report.Unsubscribed, &report.Ecommerce.TotalOrders, &revenueCents); err != nil {
		return nil, err
	}
	denom := delivered
	if denom == 0 {
		denom = report.EmailsSent
	}
	report.Opens.UniqueOpens = opened
	report.Opens.OpensTotal = opened
	report.Clicks.UniqueClicks = clicked
	report.Clicks.ClicksTotal = clicked
	if denom > 0 {
		report.Opens.OpenRate = float64(opened) / float64(denom)
		report.Clicks.ClickRate = float64(clicked) / float64(denom)
	}
	report.Bounces.HardBounces = bounced
	report.AbuseReports = complained
	report.Ecommerce.TotalRevenue = float64(revenueCents) / 100
	report.Ecommerce.TotalSpent = report.Ecommerce.TotalRevenue
	report.Ecommerce.CurrencyCode = "USD"
	report.DeliveryStatus = map[string]any{"enabled": true, "can_cancel": false, "status": "delivered"}
	return &report, tx.Commit(ctx)
}

func (r *Repo) ReportEventDetails(ctx context.Context, tenant *middleware.Tenant, campaignID, eventType string, offset, count int) (*ReportEventDetailsResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if eventType == "" {
		eventType = "clicked"
	}
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND event_type = $3`, tenant.ID, campaignID, eventType).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT COALESCE(subscriber_email::text, ''), at, COALESCE(link_url, ''),
       COALESCE(host(ip), ''), COALESCE(country, ''), COALESCE(region, ''),
       COALESCE(city, ''), COALESCE(device, ''), COALESCE(client, '')
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND event_type = $3
 ORDER BY at DESC
 LIMIT $4 OFFSET $5`, tenant.ID, campaignID, eventType, count, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ReportEventDetail{}
	for rows.Next() {
		var item ReportEventDetail
		if err := rows.Scan(&item.EmailAddress, &item.Timestamp, &item.URL, &item.IP, &item.Country, &item.Region, &item.City, &item.Device, &item.Client); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &ReportEventDetailsResponse{CampaignID: campaignID, Items: items, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) EmailActivity(ctx context.Context, tenant *middleware.Tenant, campaignID string, offset, count int) (*EmailActivityResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2)`, tenant.ID, campaignID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	var total int
	if err := tx.QueryRow(ctx, `
	SELECT count(DISTINCT subscriber_email)
	  FROM campaign_report_events
	 WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND subscriber_email IS NOT NULL`, tenant.ID, campaignID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
	SELECT subscriber_email::text, event_type, COALESCE(link_url, ''), COALESCE(host(ip), ''), at
	  FROM campaign_report_events
	 WHERE tenant_id = $1::uuid
	   AND campaign_id::text = $2
	   AND subscriber_email IS NOT NULL
	 ORDER BY subscriber_email, at DESC
	 LIMIT $3 OFFSET $4`, tenant.ID, campaignID, count*20, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byEmail := map[string]*EmailActivity{}
	order := []string{}
	for rows.Next() {
		var email, action, link, ip string
		var at time.Time
		if err := rows.Scan(&email, &action, &link, &ip, &at); err != nil {
			return nil, err
		}
		if byEmail[email] == nil {
			byEmail[email] = &EmailActivity{EmailID: subscriberHash(email), EmailAddress: email}
			order = append(order, email)
		}
		byEmail[email].Activity = append(byEmail[email].Activity, EmailActivityEvent{
			Action: action, Timestamp: at, Type: action, URL: link, IP: ip,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []EmailActivity{}
	for _, email := range order {
		out = append(out, *byEmail[email])
		if len(out) >= count {
			break
		}
	}
	return &EmailActivityResponse{Emails: out, CampaignID: campaignID, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) ListTemplates(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*TemplatesResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_sections WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, templateSelectSQL+`
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	templates, err := scanTemplates(rows)
	if err != nil {
		return nil, err
	}
	return &TemplatesResponse{Templates: templates, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) GetTemplate(ctx context.Context, tenant *middleware.Tenant, templateID string) (*Template, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, templateSelectSQL+`
WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, templateID)
	tmpl, err := scanTemplate(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return tmpl, tx.Commit(ctx)
}

func (r *Repo) ListAutomations(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*AutomationsResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM automation_journeys WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, automationSelectSQL+`
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	automations, err := scanAutomations(rows, tenant)
	if err != nil {
		return nil, err
	}
	return &AutomationsResponse{Automations: automations, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) GetAutomation(ctx context.Context, tenant *middleware.Tenant, workflowID string) (*Automation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, automationSelectSQL+`
WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, workflowID)
	auto, err := scanAutomation(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return auto, tx.Commit(ctx)
}

func (r *Repo) ListEcommerceStores(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*EcommerceStoresResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM commerce_integrations WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, ecommerceStoreSelectSQL+`
WHERE ci.tenant_id = $1::uuid
ORDER BY ci.updated_at DESC
LIMIT $2 OFFSET $3`, tenant.ID, count, offset)
	if err != nil {
		return nil, err
	}
	stores, err := scanEcommerceStores(rows, tenant)
	if err != nil {
		return nil, err
	}
	return &EcommerceStoresResponse{Stores: stores, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) GetEcommerceStore(ctx context.Context, tenant *middleware.Tenant, storeID string) (*EcommerceStore, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, ecommerceStoreSelectSQL+`
WHERE ci.tenant_id = $1::uuid AND ci.id::text = $2`, tenant.ID, storeID)
	store, err := scanEcommerceStore(row, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return store, tx.Commit(ctx)
}

func (r *Repo) audienceStats(ctx context.Context, tenantID string) (AudienceStats, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return AudienceStats{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stats AudienceStats
	if err := tx.QueryRow(ctx, `
	SELECT
	  count(*) FILTER (WHERE mailchimp_status = 'subscribed'),
	  count(*) FILTER (WHERE mailchimp_status = 'unsubscribed'),
	  count(*) FILTER (WHERE mailchimp_status = 'cleaned'),
	  (SELECT count(*) FROM campaigns WHERE tenant_id = $1::uuid)
	FROM subscribers
	WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&stats.MemberCount, &stats.UnsubscribeCount, &stats.CleanedCount, &stats.CampaignCount); err != nil {
		return AudienceStats{}, err
	}
	return stats, tx.Commit(ctx)
}

const memberSelectSQL = `SELECT ` + memberColumns + ` FROM subscribers`
const memberColumns = `id::text, email::text, status, mailchimp_status, consent_timestamp, consent_source,
       merge_fields, tags, groups, COALESCE(host(signup_ip), ''), mailchimp_last_changed, created_at, updated_at,
       activity_summary`

const campaignSelectSQL = `SELECT id::text, name, subject, status, campaign_type, editor_mode,
       tracking_settings, delivery_settings, COALESCE(segment_id::text, ''), sent_at, created_at, updated_at,
       COALESCE(from_name, ''), COALESCE(reply_to::text, ''), COALESCE(preview_text, '')
  FROM campaigns `

const templateSelectSQL = `SELECT id::text, name, category, blocks, COALESCE(html, ''), created_at, updated_at
  FROM campaign_sections `

const automationSelectSQL = `SELECT id::text, name, status, triggers, analytics, published_at, created_at, updated_at
  FROM automation_journeys `

const ecommerceStoreSelectSQL = `SELECT ci.id::text, ci.provider, COALESCE(ci.shop_domain, ''), ci.status,
       ci.created_at, ci.updated_at,
       (SELECT count(*) FROM commerce_customers cc WHERE cc.tenant_id = ci.tenant_id AND cc.integration_id = ci.id),
       (SELECT count(*) FROM commerce_products cp WHERE cp.tenant_id = ci.tenant_id AND cp.integration_id = ci.id),
       (SELECT count(*) FROM commerce_orders co WHERE co.tenant_id = ci.tenant_id AND co.integration_id = ci.id),
       (SELECT COALESCE(sum(co.total_cents), 0) FROM commerce_orders co WHERE co.tenant_id = ci.tenant_id AND co.integration_id = ci.id)
  FROM commerce_integrations ci `

type memberScanner interface{ Scan(dest ...any) error }

func scanMembers(rows pgx.Rows, tenant *middleware.Tenant) ([]Member, error) {
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		m, err := scanMember(rows, tenant)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanMember(row memberScanner, tenant *middleware.Tenant) (*Member, error) {
	var id, email, status, mcStatus, consentSource, signupIP string
	var consentAt, mcChanged *time.Time
	var createdAt, updatedAt time.Time
	var mergeRaw, groupsRaw, activityRaw []byte
	var tags []string
	if err := row.Scan(&id, &email, &status, &mcStatus, &consentAt, &consentSource, &mergeRaw, &tags, &groupsRaw, &signupIP, &mcChanged, &createdAt, &updatedAt, &activityRaw); err != nil {
		return nil, err
	}
	merge := map[string]any{}
	_ = json.Unmarshal(mergeRaw, &merge)
	if tags == nil {
		tags = []string{}
	}
	hash := subscriberHash(email)
	changed := updatedAt
	if mcChanged != nil {
		changed = *mcChanged
	}
	rating, stats := memberEngagementFromSummary(activityRaw)
	member := &Member{
		ID:              hash,
		EmailAddress:    email,
		UniqueEmailID:   shortHash(hash),
		ContactID:       id,
		EmailType:       "html",
		Status:          normalizeMailchimpStatus(defaulted(mcStatus, mailchimpStatusFromPostwave(status))),
		MergeFields:     merge,
		Interests:       groupsToInterests(groupsRaw),
		Stats:           stats,
		IPSignup:        signupIP,
		IPOpt:           signupIP,
		TimestampSignup: consentAt,
		TimestampOpt:    consentAt,
		MemberRating:    rating,
		LastChanged:     changed,
		Language:        "",
		Location:        map[string]any{},
		Source:          consentSource,
		TagsCount:       len(tags),
		Tags:            tagsResponseFromStrings(tags).Tags,
		ListID:          tenant.Slug,
	}
	hydrateMemberConsentProjection(member, status, mcStatus, activityRaw)
	return member, nil
}

func scanCampaigns(rows pgx.Rows, tenant *middleware.Tenant) ([]Campaign, error) {
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		c, err := scanCampaign(rows, tenant)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanCampaign(row memberScanner, tenant *middleware.Tenant) (*Campaign, error) {
	var c Campaign
	var title, subject, status, campaignType, editorMode, segmentID, fromName, replyTo, preview string
	var sentAt *time.Time
	var updatedAt time.Time
	var trackingRaw, deliveryRaw []byte
	if err := row.Scan(&c.ID, &title, &subject, &status, &campaignType, &editorMode, &trackingRaw, &deliveryRaw, &segmentID, &sentAt, &c.CreateTime, &updatedAt, &fromName, &replyTo, &preview); err != nil {
		return nil, err
	}
	c.Type = defaulted(campaignType, "regular")
	c.Status = mailchimpCampaignStatus(status)
	c.ContentType = defaulted(editorMode, "template")
	c.SendTime = sentAt
	c.ArchiveURL = "/campaigns/" + c.ID
	c.LongArchiveURL = c.ArchiveURL
	c.Recipients = map[string]any{"list_id": tenant.Slug, "segment_opts": map[string]any{"saved_segment_id": segmentID}}
	c.Settings = map[string]any{
		"subject_line": subject,
		"title":        title,
		"from_name":    fromName,
		"reply_to":     replyTo,
		"preview_text": preview,
	}
	c.Tracking = map[string]any{}
	_ = json.Unmarshal(trackingRaw, &c.Tracking)
	c.ReportSummary = map[string]any{}
	_ = json.Unmarshal(deliveryRaw, &c.ReportSummary)
	return &c, nil
}

func scanTemplates(rows pgx.Rows) ([]Template, error) {
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanTemplate(row memberScanner) (*Template, error) {
	var t Template
	var blocksRaw []byte
	var updatedAt time.Time
	if err := row.Scan(&t.ID, &t.Name, &t.Category, &blocksRaw, &t.HTML, &t.DateCreated, &updatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(blocksRaw, &t.Sections)
	if t.Sections == nil {
		t.Sections = []map[string]any{}
	}
	t.Type = "user"
	t.DragAndDrop = true
	t.Responsive = true
	t.Active = true
	t.CreatedBy = "postwave"
	return &t, nil
}

func scanAutomations(rows pgx.Rows, tenant *middleware.Tenant) ([]Automation, error) {
	defer rows.Close()
	out := []Automation{}
	for rows.Next() {
		a, err := scanAutomation(rows, tenant)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanAutomation(row memberScanner, tenant *middleware.Tenant) (*Automation, error) {
	var a Automation
	var name string
	var triggersRaw, analyticsRaw []byte
	var updatedAt time.Time
	if err := row.Scan(&a.ID, &name, &a.Status, &triggersRaw, &analyticsRaw, &a.StartTime, &a.CreateTime, &updatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(triggersRaw, &a.Triggers)
	if a.Triggers == nil {
		a.Triggers = []map[string]any{}
	}
	analytics := map[string]any{}
	_ = json.Unmarshal(analyticsRaw, &analytics)
	a.Recipients = map[string]any{"list_id": tenant.Slug}
	a.Settings = map[string]any{"title": name, "from_name": tenant.Name}
	a.Tracking = map[string]any{"opens": true, "html_clicks": true, "analytics": analytics}
	if v, ok := analytics["emails_sent"].(float64); ok {
		a.EmailsSent = int(v)
	}
	return &a, nil
}

func scanEcommerceStores(rows pgx.Rows, tenant *middleware.Tenant) ([]EcommerceStore, error) {
	defer rows.Close()
	out := []EcommerceStore{}
	for rows.Next() {
		s, err := scanEcommerceStore(rows, tenant)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanEcommerceStore(row memberScanner, tenant *middleware.Tenant) (*EcommerceStore, error) {
	var s EcommerceStore
	var provider, status string
	var customers, products, orders, revenueCents int
	if err := row.Scan(&s.ID, &provider, &s.Domain, &status, &s.CreatedAt, &s.UpdatedAt, &customers, &products, &orders, &revenueCents); err != nil {
		return nil, err
	}
	s.ListID = tenant.Slug
	s.Name = defaulted(s.Domain, provider+" store")
	s.Platform = provider
	s.IsSyncing = status == "syncing"
	s.CurrencyCode = "USD"
	s.MoneyFormat = "${{amount}}"
	s.PrimaryLocale = "en"
	s.Timezone = "UTC"
	s.Stats = map[string]any{
		"customers":     customers,
		"products":      products,
		"orders":        orders,
		"revenue_cents": revenueCents,
	}
	return &s, nil
}

func audienceFromTenant(t *middleware.Tenant, stats AudienceStats) AudienceList {
	return AudienceList{
		ID:                 t.Slug,
		Name:               t.Name,
		Contact:            AudienceContact{Company: t.Name, Country: "US"},
		PermissionReminder: "You are receiving this because you opted in to this Moosewave audience.",
		UseArchiveBar:      true,
		CampaignDefaults:   CampaignDefaults{FromName: t.Name, Language: "en"},
		DateCreated:        time.Time{},
		ListRating:         3,
		EmailTypeOption:    false,
		Visibility:         "pub",
		Stats:              stats,
	}
}

func listMatchesTenant(t *middleware.Tenant, listID string) bool {
	listID = strings.TrimSpace(strings.ToLower(listID))
	return listID == "" || listID == "default" || listID == strings.ToLower(t.ID) || listID == strings.ToLower(t.Slug)
}

func normalizeMemberQuery(q MemberQuery) MemberQuery {
	q.Offset, q.Count = normalizeOffsetCount(q.Offset, q.Count)
	if strings.TrimSpace(q.Status) != "" {
		q.Status = normalizeMailchimpStatus(q.Status)
	}
	return q
}

func normalizeOffsetCount(offset, count int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if count <= 0 {
		count = 10
	}
	if count > 1000 {
		count = 1000
	}
	return offset, count
}

func normalizeMailchimpStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "", "subscribed":
		return "subscribed"
	case "unsubscribed":
		return "unsubscribed"
	case "cleaned":
		return "cleaned"
	case "archived":
		return "archived"
	case "deleted":
		return "deleted"
	case "pending", "transactional", "non_subscribed":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func postwaveStatus(mc string) string {
	switch normalizeMailchimpStatus(mc) {
	case "subscribed":
		return "enabled"
	case "cleaned":
		return "blocklisted"
	case "non_subscribed", "pending":
		return "unconfirmed"
	default:
		return "disabled"
	}
}

func mailchimpStatusFromPostwave(status string) string {
	switch status {
	case "enabled":
		return "subscribed"
	case "blocklisted":
		return "cleaned"
	case "unconfirmed":
		return "non_subscribed"
	default:
		return "unsubscribed"
	}
}

func mailchimpCampaignStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "sent":
		return "sent"
	case "scheduled":
		return "schedule"
	case "sending":
		return "sending"
	case "paused":
		return "paused"
	default:
		return "save"
	}
}

func interestsToGroups(interests map[string]bool) []map[string]any {
	out := []map[string]any{}
	for k, active := range interests {
		if strings.TrimSpace(k) == "" {
			continue
		}
		out = append(out, map[string]any{"id": k, "active": active})
	}
	return out
}

func groupsToInterests(raw []byte) map[string]bool {
	var groups []map[string]any
	_ = json.Unmarshal(raw, &groups)
	out := map[string]bool{}
	for _, g := range groups {
		id := strings.TrimSpace(fmt.Sprint(g["id"]))
		if id == "" {
			id = strings.TrimSpace(fmt.Sprint(g["name"]))
		}
		if id != "" {
			active, _ := g["active"].(bool)
			out[id] = active
		}
	}
	return out
}

func applyTagOperations(current []string, ops []TagOperation) []string {
	seen := map[string]string{}
	for _, tag := range current {
		name := strings.TrimSpace(tag)
		if name != "" {
			seen[strings.ToLower(name)] = name
		}
	}
	for _, op := range ops {
		name := strings.TrimSpace(op.Name)
		if name == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(op.Status)) {
		case "inactive", "removed", "delete":
			delete(seen, strings.ToLower(name))
		default:
			seen[strings.ToLower(name)] = name
		}
	}
	out := make([]string, 0, len(seen))
	for _, name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func tagNames(tags []Tag) []string {
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		out = append(out, tag.Name)
	}
	return out
}

func tagsResponse(m []Tag) *TagsResponse {
	if m == nil {
		m = []Tag{}
	}
	return &TagsResponse{Tags: m, TotalItems: len(m)}
}

func tagsResponseFromStrings(tags []string) *TagsResponse {
	out := make([]Tag, 0, len(tags))
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" {
			continue
		}
		out = append(out, Tag{ID: stableTagID(tag), Name: tag})
	}
	return tagsResponse(out)
}

func stableTagID(tag string) int {
	sum := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(tag))))
	return int(sum[0])<<16 | int(sum[1])<<8 | int(sum[2])
}

func subscriberHash(email string) string {
	sum := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}

func shortHash(hash string) string {
	if len(hash) <= 10 {
		return hash
	}
	return hash[:10]
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
