// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"log/slog"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type ProviderIntegrationEnvelopeCipher interface {
	Encrypt(context.Context, []byte) ([]byte, error)
	Decrypt(context.Context, []byte, []byte) ([]byte, error)
}

type ProviderIntegrationSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type ProviderIntegrationsDeps struct {
	Pool               *db.Pool
	Cipher             ProviderIntegrationEnvelopeCipher
	SubscriberProfiles *subscribers.Repo
	ListMemberships    lists.MembershipWebhookFanout
	Secrets            ProviderIntegrationSecretResolver
	Config             config.Config
	Getenv             func(string) string
	Logger             *slog.Logger
}

type ProviderIntegrationsSurface struct {
	CommerceRepository    *commerce.Repo
	CommerceDependencies  *commerce.Deps
	CRMRepository         *crm_integrations.Repo
	CRMDependencies       *crm_integrations.Deps
	LeadRepository        *lead_integrations.Repo
	LeadDependencies      *lead_integrations.Deps
	MarketingRepository   *marketing_integrations.Repo
	MarketingDependencies *marketing_integrations.Deps
}

func NewProviderIntegrationsSurface(deps ProviderIntegrationsDeps) ProviderIntegrationsSurface {
	if deps.Pool == nil {
		return ProviderIntegrationsSurface{}
	}
	getenv := deps.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}

	commerceRepository := &commerce.Repo{Pool: deps.Pool, Cipher: deps.Cipher, LegacyKEK: deps.Config.SendingKEK}
	commerceRepository.CatalogBackfill = commerce.NewCatalogBackfillListener(commerceRepository, deps.Logger)
	commerceRepository.CadenceBackfill = commerce.NewCadenceBackfillListener(commerceRepository, deps.Logger)
	commerceDependencies := newCommerceProviderDependencies(deps, commerceRepository)

	crmRepository := &crm_integrations.Repo{Pool: deps.Pool, Cipher: deps.Cipher, LegacyKEK: deps.Config.SendingKEK}
	crmDependencies := newCRMProviderDependencies(deps, crmRepository, getenv)

	leadRepository := &lead_integrations.Repo{Pool: deps.Pool}
	leadDependencies := newLeadProviderDependencies(deps, leadRepository, getenv)

	marketingRepository := &marketing_integrations.Repo{Pool: deps.Pool, Cipher: deps.Cipher, LegacyKEK: deps.Config.SendingKEK}
	marketingDependencies := newMarketingProviderDependencies(deps, marketingRepository, getenv)

	return ProviderIntegrationsSurface{
		CommerceRepository:    commerceRepository,
		CommerceDependencies:  commerceDependencies,
		CRMRepository:         crmRepository,
		CRMDependencies:       crmDependencies,
		LeadRepository:        leadRepository,
		LeadDependencies:      leadDependencies,
		MarketingRepository:   marketingRepository,
		MarketingDependencies: marketingDependencies,
	}
}

func newCommerceProviderDependencies(deps ProviderIntegrationsDeps, repository *commerce.Repo) *commerce.Deps {
	return &commerce.Deps{
		Repo:                     repository,
		CredentialResolver:       commerce.NewWooCommerceSecretsCredentialResolver(deps.Secrets),
		BigCommerceCredentials:   commerce.NewBigCommerceSecretsCredentialResolver(deps.Secrets),
		StripeCredentials:        commerce.NewStripeSecretsCredentialResolver(deps.Secrets),
		SquareCredentials:        commerce.NewSquareSecretsCredentialResolver(deps.Secrets),
		PayPalCredentials:        commerce.NewPayPalSecretsCredentialResolver(deps.Secrets),
		RazorpayCredentials:      commerce.NewRazorpaySecretsCredentialResolver(deps.Secrets),
		AdobeCommerceCredentials: commerce.NewAdobeCommerceSecretsCredentialResolver(deps.Secrets),
		WixStoresCredentials:     commerce.NewWixStoresSecretsCredentialResolver(deps.Secrets),
		SquarespaceCredentials:   commerce.NewSquarespaceSecretsCredentialResolver(deps.Secrets),
		Config: commerce.Config{
			ShopifyClientID:              deps.Config.ShopifyClientID,
			ShopifyClientSecret:          deps.Config.ShopifyClientSecret,
			ShopifyScopes:                deps.Config.ShopifyScopes,
			ShopifyOAuthRedirectURL:      deps.Config.ShopifyOAuthRedirectURL,
			ShopifyStateSecret:           deps.Config.ShopifyStateSecret,
			ShopifyWebhookSecret:         deps.Config.ShopifyWebhookSecret,
			AllowUnsignedShopifyWebhooks: deps.Config.AllowUnsignedShopifyWebhooks,
		},
		Logger: deps.Logger,
	}
}

func newCRMProviderDependencies(deps ProviderIntegrationsDeps, repository *crm_integrations.Repo, getenv func(string) string) *crm_integrations.Deps {
	hubSpotCredentials := crm_integrations.NewHubSpotSecretsCredentialResolver(deps.Secrets)
	hubSpotCredentials.Store = repository
	hubSpotCredentials.OAuthClient = crm_integrations.HubSpotOAuthClient{
		OAuthBaseURL: getenv("HUBSPOT_OAUTH_BASE_URL"), UserAgent: "Moosewave HubSpot Integration",
	}
	salesforceCredentials := crm_integrations.NewSalesforceSecretsCredentialResolver(deps.Secrets)
	salesforceCredentials.Store = repository
	salesforceCredentials.OAuthClient = crm_integrations.SalesforceOAuthClient{
		LoginURL: getenv("SALESFORCE_OAUTH_LOGIN_URL"), UserAgent: "Moosewave Salesforce Integration",
	}
	pipedriveCredentials := crm_integrations.NewPipedriveSecretsCredentialResolver(deps.Secrets)
	pipedriveCredentials.Store = repository
	zohoCredentials := crm_integrations.NewZohoSecretsCredentialResolver(deps.Secrets)
	zohoCredentials.Store = repository
	zohoCredentials.OAuthClient = crm_integrations.ZohoOAuthClient{
		AccountsURL: getenv("ZOHO_OAUTH_ACCOUNTS_URL"), UserAgent: "Moosewave Zoho CRM Integration",
	}
	dynamics365Credentials := crm_integrations.NewDynamics365SecretsCredentialResolver(deps.Secrets)
	dynamics365Credentials.Store = repository
	dynamics365Credentials.OAuthClient = crm_integrations.Dynamics365OAuthClient{
		OAuthBaseURL: getenv("DYNAMICS365_OAUTH_BASE_URL"),
		TenantID:     getenv("DYNAMICS365_OAUTH_TENANT_ID"),
		UserAgent:    "Moosewave Dynamics 365 Integration",
	}
	keapCredentials := crm_integrations.NewKeapSecretsCredentialResolver(deps.Secrets)
	keapCredentials.Store = repository
	keapCredentials.OAuthClient = crm_integrations.KeapOAuthClient{
		TokenURL: getenv("KEAP_OAUTH_TOKEN_URL"), UserAgent: "Moosewave Keap Integration",
	}
	highLevelCredentials := crm_integrations.NewHighLevelSecretsCredentialResolver(deps.Secrets)
	highLevelCredentials.Store = repository
	highLevelCredentials.OAuthClient = crm_integrations.HighLevelOAuthClient{
		TokenURL: getenv("GOHIGHLEVEL_OAUTH_TOKEN_URL"), UserAgent: "Moosewave HighLevel Integration",
	}
	closeCredentials := crm_integrations.NewCloseSecretsCredentialResolver(deps.Secrets)
	copperCredentials := crm_integrations.NewCopperSecretsCredentialResolver(deps.Secrets)
	freshsalesCredentials := crm_integrations.NewFreshsalesSecretsCredentialResolver(deps.Secrets)
	postscriptCredentials := crm_integrations.NewPostscriptSecretsCredentialResolver(deps.Secrets)
	attentiveCredentials := crm_integrations.NewAttentiveSecretsCredentialResolver(deps.Secrets)
	hubSpotWebhooks := crm_integrations.HubSpotAppWebhookRegistrar{
		AppID:           getenv("HUBSPOT_APP_ID"),
		DeveloperAPIKey: getenv("HUBSPOT_DEVELOPER_API_KEY"),
		TargetURL:       strings.TrimRight(getenv("POSTWAVE_PUBLIC_BASE_URL"), "/") + "/api/public/crm-integrations/hubspot/webhooks",
	}

	return &crm_integrations.Deps{
		Repo: repository,
		Profiles: crm_integrations.SubscriberProfileSink{
			Repo:       deps.SubscriberProfiles,
			Identities: repository,
		},
		Events: crm_integrations.TrackEventSink{Repo: lifecycleIntegrationTrackRepo(Deps{Pool: deps.Pool})},
		ListMemberships: crm_integrations.NativeListMembershipSink{Repo: &lists.Repo{
			Pool:               deps.Pool,
			MembershipWebhooks: deps.ListMemberships,
		}},

		HubSpotCredentials: hubSpotCredentials,
		HubSpotBackfiller:  crm_integrations.HubSpotRESTBackfiller{Credentials: hubSpotCredentials},
		HubSpotWebhooks:    hubSpotWebhooks,
		HubSpotOAuth: crm_integrations.HubSpotOAuthConfig{
			ClientID:        getenv("HUBSPOT_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("HUBSPOT_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("HUBSPOT_OAUTH_REDIRECT_URL"),
			OAuthBaseURL:    getenv("HUBSPOT_OAUTH_BASE_URL"),
			SuccessRedirect: getenv("HUBSPOT_OAUTH_SUCCESS_REDIRECT"),
			Scopes:          crm_integrations.ParseHubSpotOAuthScopes(getenv("HUBSPOT_OAUTH_SCOPES")),
			AppID:           getenv("HUBSPOT_APP_ID"),
			DeveloperAPIKey: getenv("HUBSPOT_DEVELOPER_API_KEY"),
		},
		HubSpotOAuthClient: hubSpotCredentials.OAuthClient,

		SalesforceCredentials: salesforceCredentials,
		SalesforceBackfiller:  crm_integrations.SalesforceRESTBackfiller{Credentials: salesforceCredentials},
		SalesforceOAuth: crm_integrations.SalesforceOAuthConfig{
			ClientID:        getenv("SALESFORCE_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("SALESFORCE_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("SALESFORCE_OAUTH_REDIRECT_URL"),
			LoginURL:        getenv("SALESFORCE_OAUTH_LOGIN_URL"),
			SuccessRedirect: getenv("SALESFORCE_OAUTH_SUCCESS_REDIRECT"),
			Scopes:          crm_integrations.ParseSalesforceOAuthScopes(getenv("SALESFORCE_OAUTH_SCOPES")),
		},
		SalesforceOAuthClient: salesforceCredentials.OAuthClient,

		PipedriveCredentials: pipedriveCredentials,
		PipedriveBackfiller:  crm_integrations.PipedriveRESTBackfiller{Credentials: pipedriveCredentials},
		PipedriveWebhooks:    crm_integrations.PipedriveRESTWebhookRegistrar{Credentials: pipedriveCredentials},
		PipedriveOAuth: crm_integrations.PipedriveOAuthConfig{
			ClientID:        getenv("PIPEDRIVE_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("PIPEDRIVE_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("PIPEDRIVE_OAUTH_REDIRECT_URL"),
			OAuthBaseURL:    getenv("PIPEDRIVE_OAUTH_BASE_URL"),
			SuccessRedirect: getenv("PIPEDRIVE_OAUTH_SUCCESS_REDIRECT"),
			Scopes:          crm_integrations.ParsePipedriveOAuthScopes(getenv("PIPEDRIVE_OAUTH_SCOPES")),
		},

		ZohoCredentials: zohoCredentials,
		ZohoBackfiller:  crm_integrations.ZohoRESTBackfiller{Credentials: zohoCredentials},
		ZohoOAuth: crm_integrations.ZohoOAuthConfig{
			ClientID:        getenv("ZOHO_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("ZOHO_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("ZOHO_OAUTH_REDIRECT_URL"),
			AccountsURL:     getenv("ZOHO_OAUTH_ACCOUNTS_URL"),
			SuccessRedirect: getenv("ZOHO_OAUTH_SUCCESS_REDIRECT"),
			Scopes:          crm_integrations.ParseZohoOAuthScopes(getenv("ZOHO_OAUTH_SCOPES")),
		},
		ZohoOAuthClient: zohoCredentials.OAuthClient,

		Dynamics365Credentials: dynamics365Credentials,
		Dynamics365Backfiller:  crm_integrations.Dynamics365RESTBackfiller{Credentials: dynamics365Credentials},
		Dynamics365OAuth: crm_integrations.Dynamics365OAuthConfig{
			ClientID:        getenv("DYNAMICS365_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("DYNAMICS365_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("DYNAMICS365_OAUTH_REDIRECT_URL"),
			OAuthBaseURL:    getenv("DYNAMICS365_OAUTH_BASE_URL"),
			TenantID:        getenv("DYNAMICS365_OAUTH_TENANT_ID"),
			SuccessRedirect: getenv("DYNAMICS365_OAUTH_SUCCESS_REDIRECT"),
		},
		Dynamics365OAuthClient: dynamics365Credentials.OAuthClient,

		KeapCredentials: keapCredentials,
		KeapBackfiller:  crm_integrations.KeapRESTBackfiller{Credentials: keapCredentials},
		KeapOAuth: crm_integrations.KeapOAuthConfig{
			ClientID:        getenv("KEAP_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("KEAP_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("KEAP_OAUTH_REDIRECT_URL"),
			AuthorizeURL:    getenv("KEAP_OAUTH_AUTHORIZE_URL"),
			TokenURL:        getenv("KEAP_OAUTH_TOKEN_URL"),
			SuccessRedirect: getenv("KEAP_OAUTH_SUCCESS_REDIRECT"),
		},
		KeapOAuthClient: keapCredentials.OAuthClient,

		HighLevelCredentials: highLevelCredentials,
		HighLevelBackfiller:  crm_integrations.HighLevelRESTBackfiller{Credentials: highLevelCredentials},
		HighLevelOAuth: crm_integrations.HighLevelOAuthConfig{
			ClientID:        getenv("GOHIGHLEVEL_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("GOHIGHLEVEL_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("GOHIGHLEVEL_OAUTH_REDIRECT_URL"),
			AuthorizeURL:    getenv("GOHIGHLEVEL_OAUTH_AUTHORIZE_URL"),
			TokenURL:        getenv("GOHIGHLEVEL_OAUTH_TOKEN_URL"),
			SuccessRedirect: getenv("GOHIGHLEVEL_OAUTH_SUCCESS_REDIRECT"),
		},
		HighLevelOAuthClient: highLevelCredentials.OAuthClient,

		CloseCredentials:      closeCredentials,
		CloseBackfiller:       crm_integrations.CloseRESTBackfiller{Credentials: closeCredentials},
		CopperCredentials:     copperCredentials,
		CopperBackfiller:      crm_integrations.CopperRESTBackfiller{Credentials: copperCredentials},
		FreshsalesCredentials: freshsalesCredentials,
		FreshsalesBackfiller:  crm_integrations.FreshsalesRESTBackfiller{Credentials: freshsalesCredentials},
		PostscriptCredentials: postscriptCredentials,
		PostscriptBackfiller:  crm_integrations.PostscriptRESTBackfiller{Credentials: postscriptCredentials},
		AttentiveCredentials:  attentiveCredentials,
		AttentiveBackfiller:   crm_integrations.AttentiveRESTBackfiller{Credentials: attentiveCredentials},
		PublicBaseURL:         getenv("POSTWAVE_PUBLIC_BASE_URL"),
		Logger:                deps.Logger,
	}
}

func newLeadProviderDependencies(deps ProviderIntegrationsDeps, repository *lead_integrations.Repo, getenv func(string) string) *lead_integrations.Deps {
	typeform := lead_integrations.NewTypeformSecretsCredentialResolver(deps.Secrets)
	surveyMonkey := lead_integrations.NewSurveyMonkeySecretsCredentialResolver(deps.Secrets)
	unbounce := lead_integrations.NewUnbounceSecretsCredentialResolver(deps.Secrets)
	leadpages := lead_integrations.NewLeadpagesSecretsCredentialResolver(deps.Secrets)
	formBuilder123 := lead_integrations.NewFormBuilder123SecretsCredentialResolver(deps.Secrets)
	instapage := lead_integrations.NewInstapageSecretsCredentialResolver(deps.Secrets)
	wix := lead_integrations.NewWixSecretsCredentialResolver(deps.Secrets)
	jotform := lead_integrations.NewJotformSecretsCredentialResolver(deps.Secrets)
	webflow := lead_integrations.NewWebflowSecretsCredentialResolver(deps.Secrets)
	paperform := lead_integrations.NewPaperformSecretsCredentialResolver(deps.Secrets)
	formstack := lead_integrations.NewFormstackSecretsCredentialResolver(deps.Secrets)
	formsite := lead_integrations.NewFormsiteSecretsCredentialResolver(deps.Secrets)
	cognitoForms := lead_integrations.NewCognitoFormsSecretsCredentialResolver(deps.Secrets)
	gravityForms := lead_integrations.NewGravityFormsSecretsCredentialResolver(deps.Secrets)
	wpforms := lead_integrations.NewWPFormsSecretsCredentialResolver(deps.Secrets)
	formidableForms := lead_integrations.NewFormidableFormsSecretsCredentialResolver(deps.Secrets)
	feathery := lead_integrations.NewFeatherySecretsCredentialResolver(deps.Secrets)
	formaloo := lead_integrations.NewFormalooSecretsCredentialResolver(deps.Secrets)
	fillout := lead_integrations.NewFilloutSecretsCredentialResolver(deps.Secrets)
	tally := lead_integrations.NewTallySecretsCredentialResolver(deps.Secrets)
	googleForms := lead_integrations.NewGoogleFormsSecretsCredentialResolver(deps.Secrets)
	facebookLeadAds := lead_integrations.NewFacebookLeadAdsSecretsCredentialResolver(deps.Secrets)
	googleLeadForms := lead_integrations.NewGoogleLeadFormsSecretsCredentialResolver(deps.Secrets)

	return &lead_integrations.Deps{
		Repo:     repository,
		Profiles: lead_integrations.SubscriberProfileSink{Repo: deps.SubscriberProfiles},
		Events:   lead_integrations.TrackEventSink{Repo: &track.Repo{Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool}}},

		TypeformCredentials:       typeform,
		TypeformBackfiller:        lead_integrations.TypeformRESTBackfiller{Credentials: typeform},
		SurveyMonkeyCredentials:   surveyMonkey,
		SurveyMonkeyBackfiller:    lead_integrations.SurveyMonkeyRESTBackfiller{Credentials: surveyMonkey},
		UnbounceCredentials:       unbounce,
		UnbounceBackfiller:        lead_integrations.UnbounceRESTBackfiller{Credentials: unbounce},
		LeadpagesCredentials:      leadpages,
		LeadpagesBackfiller:       lead_integrations.LeadpagesRESTBackfiller{Credentials: leadpages},
		FormBuilder123Credentials: formBuilder123,
		FormBuilder123Backfiller:  lead_integrations.FormBuilder123RESTBackfiller{Credentials: formBuilder123},
		InstapageCredentials:      instapage,
		InstapageBackfiller:       lead_integrations.InstapageRESTBackfiller{Credentials: instapage},

		CarrdCredentials:        lead_integrations.NewCarrdSecretsCredentialResolver(deps.Secrets),
		OptinMonsterCredentials: lead_integrations.NewOptinMonsterSecretsCredentialResolver(deps.Secrets),
		PrivyCredentials:        lead_integrations.NewPrivySecretsCredentialResolver(deps.Secrets),
		ConvertFlowCredentials:  lead_integrations.NewConvertFlowSecretsCredentialResolver(deps.Secrets),
		SleeknoteCredentials:    lead_integrations.NewSleeknoteSecretsCredentialResolver(deps.Secrets),
		WisepopsCredentials:     lead_integrations.NewWisepopsSecretsCredentialResolver(deps.Secrets),
		PoptinCredentials:       lead_integrations.NewPoptinSecretsCredentialResolver(deps.Secrets),
		HelloBarCredentials:     lead_integrations.NewHelloBarSecretsCredentialResolver(deps.Secrets),
		LandingiCredentials:     lead_integrations.NewLandingiSecretsCredentialResolver(deps.Secrets),
		KickoffLabsCredentials:  lead_integrations.NewKickoffLabsSecretsCredentialResolver(deps.Secrets),
		NinjaFormsCredentials:   lead_integrations.NewNinjaFormsSecretsCredentialResolver(deps.Secrets),
		OutgrowCredentials:      lead_integrations.NewOutgrowSecretsCredentialResolver(deps.Secrets),
		ShortStackCredentials:   lead_integrations.NewShortStackSecretsCredentialResolver(deps.Secrets),
		RiddleCredentials:       lead_integrations.NewRiddleSecretsCredentialResolver(deps.Secrets),

		WixCredentials:                    wix,
		WixBackfiller:                     lead_integrations.WixRESTBackfiller{Credentials: wix},
		JotformCredentials:                jotform,
		JotformBackfiller:                 lead_integrations.JotformRESTBackfiller{Credentials: jotform},
		WebflowCredentials:                webflow,
		WebflowBackfiller:                 lead_integrations.WebflowRESTBackfiller{Credentials: webflow},
		PaperformCredentials:              paperform,
		PaperformBackfiller:               lead_integrations.PaperformRESTBackfiller{Credentials: paperform},
		FormstackCredentials:              formstack,
		FormstackBackfiller:               lead_integrations.FormstackRESTBackfiller{Credentials: formstack},
		FormsiteCredentials:               formsite,
		FormsiteBackfiller:                lead_integrations.FormsiteRESTBackfiller{Credentials: formsite},
		CognitoFormsCredentials:           cognitoForms,
		CognitoFormsBackfiller:            lead_integrations.CognitoFormsRESTBackfiller{Credentials: cognitoForms},
		GravityFormsCredentials:           gravityForms,
		GravityFormsBackfiller:            lead_integrations.GravityFormsRESTBackfiller{Credentials: gravityForms},
		WPFormsCredentials:                wpforms,
		WPFormsBackfiller:                 lead_integrations.WPFormsRESTBackfiller{Credentials: wpforms},
		FormidableFormsCredentials:        formidableForms,
		FormidableFormsBackfiller:         lead_integrations.FormidableFormsRESTBackfiller{Credentials: formidableForms},
		FeatheryCredentials:               feathery,
		FeatheryBackfiller:                lead_integrations.FeatheryRESTBackfiller{Credentials: feathery},
		FormalooCredentials:               formaloo,
		FormalooBackfiller:                lead_integrations.FormalooRESTBackfiller{Credentials: formaloo},
		FilloutCredentials:                fillout,
		FilloutBackfiller:                 lead_integrations.FilloutRESTBackfiller{Credentials: fillout},
		TallyCredentials:                  tally,
		TallyBackfiller:                   lead_integrations.TallyRESTBackfiller{Credentials: tally},
		GoogleFormsCredentials:            googleForms,
		GoogleFormsBackfiller:             lead_integrations.GoogleFormsRESTBackfiller{Credentials: googleForms},
		FacebookLeadAdsCredentials:        facebookLeadAds,
		FacebookLeadAdsBackfiller:         lead_integrations.FacebookLeadAdsRESTBackfiller{Credentials: facebookLeadAds},
		FacebookLeadAdsPageSubscriptions:  lead_integrations.FacebookLeadAdsRESTPageSubscriptionRegistrar{Credentials: facebookLeadAds},
		FacebookLeadAdsWebhookVerifyToken: getenv("FACEBOOK_LEAD_ADS_WEBHOOK_VERIFY_TOKEN"),
		GoogleLeadFormsCredentials:        googleLeadForms,
		GoogleLeadFormsBackfiller:         lead_integrations.GoogleLeadFormsRESTBackfiller{Credentials: googleLeadForms},
		PublicBaseURL:                     getenv("POSTWAVE_PUBLIC_BASE_URL"),
		Logger:                            deps.Logger,
	}
}

func newMarketingProviderDependencies(deps ProviderIntegrationsDeps, repository *marketing_integrations.Repo, getenv func(string) string) *marketing_integrations.Deps {
	credentials := marketing_integrations.NewKlaviyoSecretsCredentialResolver(deps.Secrets)
	credentials.Store = repository
	credentials.OAuthClient = marketing_integrations.KlaviyoOAuthClient{
		OAuthBaseURL: getenv("KLAVIYO_OAUTH_BASE_URL"), UserAgent: "Moosewave Klaviyo Integration",
	}
	return &marketing_integrations.Deps{
		Repo:               repository,
		KlaviyoCredentials: credentials,
		KlaviyoPuller:      &marketing_integrations.KlaviyoNativePuller{Credentials: credentials},
		KlaviyoWebhooks: marketing_integrations.KlaviyoRESTWebhookRegistrar{
			Credentials: credentials, WebhookSecrets: deps.Secrets,
		},
		KlaviyoOAuth: marketing_integrations.KlaviyoOAuthConfig{
			ClientID:        getenv("KLAVIYO_OAUTH_CLIENT_ID"),
			ClientSecret:    getenv("KLAVIYO_OAUTH_CLIENT_SECRET"),
			RedirectURL:     getenv("KLAVIYO_OAUTH_REDIRECT_URL"),
			OAuthBaseURL:    getenv("KLAVIYO_OAUTH_BASE_URL"),
			AuthorizeURL:    getenv("KLAVIYO_OAUTH_AUTHORIZE_URL"),
			SuccessRedirect: getenv("KLAVIYO_OAUTH_SUCCESS_REDIRECT"),
			Scopes:          marketing_integrations.ParseKlaviyoOAuthScopes(getenv("KLAVIYO_OAUTH_SCOPES")),
		},
		KlaviyoOAuthClient: credentials.OAuthClient,
		WebhookSecrets:     deps.Secrets,
		PublicBaseURL:      getenv("POSTWAVE_PUBLIC_BASE_URL"),
		Logger:             deps.Logger,
	}
}

func MountAuthenticatedProviderIntegrationRoutes(router chi.Router, surface ProviderIntegrationsSurface) {
	if router == nil || surface.CommerceDependencies == nil || surface.CRMDependencies == nil || surface.LeadDependencies == nil || surface.MarketingDependencies == nil {
		return
	}
	commerce.Mount(router, surface.CommerceDependencies)
	crm_integrations.MountRoutes(router, surface.CRMDependencies)
	lead_integrations.MountRoutes(router, surface.LeadDependencies)
	marketing_integrations.MountRoutes(router, surface.MarketingDependencies)
}

func MountProviderOAuthCallbackRoutes(router chi.Router, surface ProviderIntegrationsSurface) {
	if router == nil || surface.CRMDependencies == nil {
		return
	}
	crm_integrations.MountOAuthCallbackRoutes(router, surface.CRMDependencies)
}

func MountPublicProviderIntegrationRoutes(router chi.Router, surface ProviderIntegrationsSurface) {
	if router == nil || surface.CRMDependencies == nil || surface.LeadDependencies == nil || surface.MarketingDependencies == nil {
		return
	}
	crm_integrations.MountPublicRoutes(router, surface.CRMDependencies)
	lead_integrations.MountPublicRoutes(router, surface.LeadDependencies)
	marketing_integrations.MountPublicRoutes(router, surface.MarketingDependencies)
}

func MountCommercePublicRoutes(router chi.Router, surface ProviderIntegrationsSurface) {
	if router == nil || surface.CommerceDependencies == nil {
		return
	}
	commerce.MountPublic(router, surface.CommerceDependencies)
}
