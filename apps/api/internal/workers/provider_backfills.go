// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type errorRunningWorker interface {
	Run(context.Context) error
}

type providerBackfillLaunch struct {
	name        string
	exitMessage string
	worker      errorRunningWorker
}

func startProviderBackfillLaunches(ctx context.Context, logger *slog.Logger, launches []providerBackfillLaunch) {
	for _, launch := range launches {
		launch := launch
		safego.Go(logger, launch.name, func() {
			if err := launch.worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn(launch.exitMessage, "err", err.Error())
			}
		})
	}
}

type MarketingIntegrationBackfillDeps struct {
	Dependencies *marketing_integrations.Deps
	Store        *marketing_integrations.Repo
	Logger       *slog.Logger
}

func marketingIntegrationBackfillLaunches(deps MarketingIntegrationBackfillDeps) []providerBackfillLaunch {
	if deps.Dependencies == nil || deps.Store == nil {
		return nil
	}
	return []providerBackfillLaunch{{
		name:        "klaviyo-backfill-worker",
		exitMessage: "klaviyo backfill worker exited",
		worker: &marketing_integrations.KlaviyoBackfillWorker{
			Deps:   deps.Dependencies,
			Store:  deps.Store,
			Logger: deps.Logger,
		},
	}}
}

func StartMarketingIntegrationBackfills(ctx context.Context, deps MarketingIntegrationBackfillDeps) {
	startProviderBackfillLaunches(ctx, deps.Logger, marketingIntegrationBackfillLaunches(deps))
}

func StartIntelligentRetryWorker(ctx context.Context, logger *slog.Logger, queue *intelligent_retry.Queue) {
	if queue == nil {
		return
	}
	worker := intelligent_retry.NewWorker(queue)
	worker.Logger = logger
	safego.Go(logger, "intelligent-retry-worker", func() {
		worker.Run(ctx)
	})
}

type CommerceProviderBackfillDeps struct {
	Pool                 *db.Pool
	Dependencies         *commerce.Deps
	Store                *commerce.Repo
	AutomationServiceURL string
	// RunFailureNotify fans terminal flow-run failures to tenant operators
	// via the unified notification fanout. Optional.
	RunFailureNotify flowbuilder.RunFailureNotifier
	Logger           *slog.Logger
}

type CommerceProviderBackfillSurface struct {
	Lifecycle *commerce.Worker
	// FlowRuns is intentionally nil while the legacy cross-tenant drainer is
	// unqualified. Retained in the shape so diagnostics/tests cannot confuse
	// omission with an accidentally relocated worker.
	FlowRuns    *flowbuilder.Drainer
	FlowRuntime runtimecapability.Descriptor
	Backfills   []providerBackfillLaunch
}

func NewCommerceProviderBackfillSurface(deps CommerceProviderBackfillDeps) CommerceProviderBackfillSurface {
	if deps.Pool == nil || deps.Dependencies == nil || deps.Store == nil {
		return CommerceProviderBackfillSurface{FlowRuntime: flowbuilder.RuntimeDescriptor()}
	}
	return CommerceProviderBackfillSurface{
		Lifecycle: &commerce.Worker{
			Repo:   deps.Store,
			Logger: deps.Logger,
			Events: &track.Repo{Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool}},
		},
		FlowRuns:    nil,
		FlowRuntime: flowbuilder.RuntimeDescriptor(),
		Backfills:   commerceProviderBackfillLaunches(deps),
	}
}

func commerceProviderBackfillLaunches(deps CommerceProviderBackfillDeps) []providerBackfillLaunch {
	if deps.Dependencies == nil || deps.Store == nil {
		return nil
	}
	return []providerBackfillLaunch{
		{
			name:        "shopify-backfill-worker",
			exitMessage: "shopify backfill worker exited",
			worker:      &commerce.ShopifyBackfillWorker{Store: deps.Store, Logger: deps.Logger},
		},
		{
			name:        "woocommerce-backfill-worker",
			exitMessage: "woocommerce backfill worker exited",
			worker: &commerce.WooCommerceBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.WooCommerceRESTBackfiller{
					Credentials: deps.Dependencies.CredentialResolver,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "bigcommerce-backfill-worker",
			exitMessage: "bigcommerce backfill worker exited",
			worker: &commerce.BigCommerceBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.BigCommerceRESTBackfiller{
					Credentials: deps.Dependencies.BigCommerceCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "stripe-backfill-worker",
			exitMessage: "stripe backfill worker exited",
			worker: &commerce.StripeBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.StripeRESTBackfiller{
					Credentials: deps.Dependencies.StripeCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "square-backfill-worker",
			exitMessage: "square backfill worker exited",
			worker: &commerce.SquareBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.SquareRESTBackfiller{
					Credentials: deps.Dependencies.SquareCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "paypal-backfill-worker",
			exitMessage: "paypal backfill worker exited",
			worker: &commerce.PayPalBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.PayPalRESTBackfiller{
					Credentials: deps.Dependencies.PayPalCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "razorpay-backfill-worker",
			exitMessage: "razorpay backfill worker exited",
			worker: &commerce.RazorpayBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.RazorpayRESTBackfiller{
					Credentials: deps.Dependencies.RazorpayCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "adobe-commerce-backfill-worker",
			exitMessage: "adobe commerce backfill worker exited",
			worker: &commerce.AdobeCommerceBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.AdobeCommerceRESTBackfiller{
					Credentials: deps.Dependencies.AdobeCommerceCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "wix-backfill-worker",
			exitMessage: "wix backfill worker exited",
			worker: &commerce.WixStoresBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.WixStoresRESTBackfiller{
					Credentials: deps.Dependencies.WixStoresCredentials,
				},
				Logger: deps.Logger,
			},
		},
		{
			name:        "squarespace-backfill-worker",
			exitMessage: "squarespace backfill worker exited",
			worker: &commerce.SquarespaceBackfillWorker{
				Store: deps.Store,
				Backfiller: commerce.SquarespaceRESTBackfiller{
					Credentials: deps.Dependencies.SquarespaceCredentials,
				},
				Logger: deps.Logger,
			},
		},
	}
}

func StartCommerceProviderBackfills(ctx context.Context, deps CommerceProviderBackfillDeps) CommerceProviderBackfillSurface {
	surface := NewCommerceProviderBackfillSurface(deps)
	if surface.Lifecycle == nil {
		return surface
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("flow-runs drainer disabled",
		"runtime_status", surface.FlowRuntime.RuntimeStatus,
		"code", surface.FlowRuntime.Code)
	safego.Go(deps.Logger, "commerce-lifecycle-worker", func() {
		if err := surface.Lifecycle.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			deps.Logger.Warn("commerce lifecycle worker exited", "err", err.Error())
		}
	})
	startProviderBackfillLaunches(ctx, deps.Logger, surface.Backfills)
	return surface
}

type CRMProviderBackfillDeps struct {
	Dependencies             *crm_integrations.Deps
	Store                    *crm_integrations.Repo
	ReconcileHubSpotWebhooks bool
	Logger                   *slog.Logger
}

func crmProviderBackfillLaunches(deps CRMProviderBackfillDeps) []providerBackfillLaunch {
	if deps.Dependencies == nil || deps.Store == nil {
		return nil
	}
	return []providerBackfillLaunch{
		{
			name:        "pipedrive-backfill-worker",
			exitMessage: "pipedrive backfill worker exited",
			worker: &crm_integrations.PipedriveBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.PipedriveRESTBackfiller{Credentials: deps.Dependencies.PipedriveCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "hubspot-backfill-worker",
			exitMessage: "hubspot backfill worker exited",
			worker: &crm_integrations.HubSpotBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.HubSpotRESTBackfiller{Credentials: deps.Dependencies.HubSpotCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "salesforce-backfill-worker",
			exitMessage: "salesforce backfill worker exited",
			worker: &crm_integrations.SalesforceBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.SalesforceRESTBackfiller{Credentials: deps.Dependencies.SalesforceCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "zoho-backfill-worker",
			exitMessage: "zoho backfill worker exited",
			worker: &crm_integrations.ZohoBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.ZohoRESTBackfiller{Credentials: deps.Dependencies.ZohoCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "dynamics365-backfill-worker",
			exitMessage: "dynamics365 backfill worker exited",
			worker: &crm_integrations.Dynamics365BackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.Dynamics365RESTBackfiller{Credentials: deps.Dependencies.Dynamics365Credentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "keap-backfill-worker",
			exitMessage: "keap backfill worker exited",
			worker: &crm_integrations.KeapBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.KeapRESTBackfiller{Credentials: deps.Dependencies.KeapCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "gohighlevel-backfill-worker",
			exitMessage: "gohighlevel backfill worker exited",
			worker: &crm_integrations.HighLevelBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.HighLevelRESTBackfiller{Credentials: deps.Dependencies.HighLevelCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "close-backfill-worker",
			exitMessage: "close backfill worker exited",
			worker: &crm_integrations.CRMStaticBackfillWorker{
				Provider: crm_integrations.ProviderClose, Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: deps.Dependencies.CloseBackfiller, Logger: deps.Logger,
			},
		},
		{
			name:        "copper-backfill-worker",
			exitMessage: "copper backfill worker exited",
			worker: &crm_integrations.CRMStaticBackfillWorker{
				Provider: crm_integrations.ProviderCopper, Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: deps.Dependencies.CopperBackfiller, Logger: deps.Logger,
			},
		},
		{
			name:        "freshsales-backfill-worker",
			exitMessage: "freshsales backfill worker exited",
			worker: &crm_integrations.CRMStaticBackfillWorker{
				Provider: crm_integrations.ProviderFreshsales, Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: deps.Dependencies.FreshsalesBackfiller, Logger: deps.Logger,
			},
		},
		{
			name:        "postscript-backfill-worker",
			exitMessage: "postscript backfill worker exited",
			worker: &crm_integrations.PostscriptBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.PostscriptRESTBackfiller{Credentials: deps.Dependencies.PostscriptCredentials},
				Logger:     deps.Logger,
			},
		},
		{
			name:        "attentive-backfill-worker",
			exitMessage: "attentive backfill worker exited",
			worker: &crm_integrations.AttentiveBackfillWorker{
				Deps: deps.Dependencies, Store: deps.Store,
				Backfiller: crm_integrations.AttentiveRESTBackfiller{Credentials: deps.Dependencies.AttentiveCredentials},
				Logger:     deps.Logger,
			},
		},
	}
}

func StartCRMProviderBackfills(ctx context.Context, deps CRMProviderBackfillDeps) {
	startProviderBackfillLaunches(ctx, deps.Logger, crmProviderBackfillLaunches(deps))
	if !deps.ReconcileHubSpotWebhooks || deps.Dependencies == nil || deps.Dependencies.HubSpotWebhooks == nil {
		return
	}
	safego.Go(deps.Logger, "hubspot-webhook-reconcile", func() {
		summary, err := deps.Dependencies.HubSpotWebhooks.ReconcileSubscriptions(ctx)
		if err != nil {
			deps.Logger.Warn("hubspot webhook subscription reconcile failed", "err", err.Error())
			return
		}
		deps.Logger.Info("hubspot webhook subscriptions reconciled", "created", summary.Created, "existing", summary.Existing)
	})
}

type LeadProviderBackfillDeps struct {
	Dependencies *lead_integrations.Deps
	Store        *lead_integrations.Repo
	Logger       *slog.Logger
}

func leadProviderBackfillLaunches(deps LeadProviderBackfillDeps) []providerBackfillLaunch {
	if deps.Dependencies == nil || deps.Store == nil {
		return nil
	}
	d := deps.Dependencies
	store := deps.Store
	logger := deps.Logger
	return []providerBackfillLaunch{
		{name: "typeform-backfill-worker", exitMessage: "typeform backfill worker exited", worker: &lead_integrations.TypeformBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.TypeformRESTBackfiller{Credentials: d.TypeformCredentials}, Logger: logger}},
		{name: "surveymonkey-backfill-worker", exitMessage: "surveymonkey backfill worker exited", worker: &lead_integrations.SurveyMonkeyBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.SurveyMonkeyRESTBackfiller{Credentials: d.SurveyMonkeyCredentials}, Logger: logger}},
		{name: "unbounce-backfill-worker", exitMessage: "unbounce backfill worker exited", worker: &lead_integrations.UnbounceBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.UnbounceRESTBackfiller{Credentials: d.UnbounceCredentials}, Logger: logger}},
		{name: "leadpages-backfill-worker", exitMessage: "leadpages backfill worker exited", worker: &lead_integrations.LeadpagesBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.LeadpagesRESTBackfiller{Credentials: d.LeadpagesCredentials}, Logger: logger}},
		{name: "123formbuilder-backfill-worker", exitMessage: "123FormBuilder backfill worker exited", worker: &lead_integrations.FormBuilder123BackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FormBuilder123RESTBackfiller{Credentials: d.FormBuilder123Credentials}, Logger: logger}},
		{name: "instapage-backfill-worker", exitMessage: "instapage backfill worker exited", worker: &lead_integrations.InstapageBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.InstapageRESTBackfiller{Credentials: d.InstapageCredentials}, Logger: logger}},
		{name: "jotform-backfill-worker", exitMessage: "jotform backfill worker exited", worker: &lead_integrations.JotformBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.JotformRESTBackfiller{Credentials: d.JotformCredentials}, Logger: logger}},
		{name: "webflow-backfill-worker", exitMessage: "webflow backfill worker exited", worker: &lead_integrations.WebflowBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.WebflowRESTBackfiller{Credentials: d.WebflowCredentials}, Logger: logger}},
		{name: "fillout-backfill-worker", exitMessage: "fillout backfill worker exited", worker: &lead_integrations.FilloutBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FilloutRESTBackfiller{Credentials: d.FilloutCredentials}, Logger: logger}},
		{name: "paperform-backfill-worker", exitMessage: "paperform backfill worker exited", worker: &lead_integrations.PaperformBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.PaperformRESTBackfiller{Credentials: d.PaperformCredentials}, Logger: logger}},
		{name: "formstack-backfill-worker", exitMessage: "formstack backfill worker exited", worker: &lead_integrations.FormstackBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FormstackRESTBackfiller{Credentials: d.FormstackCredentials}, Logger: logger}},
		{name: "formsite-backfill-worker", exitMessage: "formsite backfill worker exited", worker: &lead_integrations.FormsiteBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FormsiteRESTBackfiller{Credentials: d.FormsiteCredentials}, Logger: logger}},
		{name: "cognito-forms-backfill-worker", exitMessage: "Cognito Forms backfill worker exited", worker: &lead_integrations.CognitoFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.CognitoFormsRESTBackfiller{Credentials: d.CognitoFormsCredentials}, Logger: logger}},
		{name: "gravity-forms-backfill-worker", exitMessage: "gravity forms backfill worker exited", worker: &lead_integrations.GravityFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.GravityFormsRESTBackfiller{Credentials: d.GravityFormsCredentials}, Logger: logger}},
		{name: "wpforms-backfill-worker", exitMessage: "WPForms backfill worker exited", worker: &lead_integrations.WPFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.WPFormsRESTBackfiller{Credentials: d.WPFormsCredentials}, Logger: logger}},
		{name: "formidable-forms-backfill-worker", exitMessage: "Formidable Forms backfill worker exited", worker: &lead_integrations.FormidableFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FormidableFormsRESTBackfiller{Credentials: d.FormidableFormsCredentials}, Logger: logger}},
		{name: "feathery-backfill-worker", exitMessage: "feathery backfill worker exited", worker: &lead_integrations.FeatheryBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FeatheryRESTBackfiller{Credentials: d.FeatheryCredentials}, Logger: logger}},
		{name: "formaloo-backfill-worker", exitMessage: "formaloo backfill worker exited", worker: &lead_integrations.FormalooBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FormalooRESTBackfiller{Credentials: d.FormalooCredentials}, Logger: logger}},
		{name: "tally-backfill-worker", exitMessage: "tally backfill worker exited", worker: &lead_integrations.TallyBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.TallyRESTBackfiller{Credentials: d.TallyCredentials}, Logger: logger}},
		{name: "google-forms-backfill-worker", exitMessage: "google forms backfill worker exited", worker: &lead_integrations.GoogleFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.GoogleFormsRESTBackfiller{Credentials: d.GoogleFormsCredentials}, Logger: logger}},
		{name: "facebook-lead-ads-backfill-worker", exitMessage: "facebook lead ads backfill worker exited", worker: &lead_integrations.FacebookLeadAdsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.FacebookLeadAdsRESTBackfiller{Credentials: d.FacebookLeadAdsCredentials}, Logger: logger}},
		{name: "google-lead-forms-backfill-worker", exitMessage: "google lead form extensions backfill worker exited", worker: &lead_integrations.GoogleLeadFormsBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.GoogleLeadFormsRESTBackfiller{Credentials: d.GoogleLeadFormsCredentials}, Logger: logger}},
		{name: "wix-lead-backfill-worker", exitMessage: "wix lead backfill worker exited", worker: &lead_integrations.WixBackfillWorker{Deps: d, Store: store, Backfiller: lead_integrations.WixRESTBackfiller{Credentials: d.WixCredentials}, Logger: logger}},
	}
}

func StartLeadProviderBackfills(ctx context.Context, deps LeadProviderBackfillDeps) {
	startProviderBackfillLaunches(ctx, deps.Logger, leadProviderBackfillLaunches(deps))
}
