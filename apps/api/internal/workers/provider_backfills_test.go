// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/track"
)

func TestProviderBackfillInventoriesPreserveExactOrderNamesAndTypes(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	commerceStore := &commerce.Repo{}
	commerceDeps := &commerce.Deps{}
	commerceLaunches := commerceProviderBackfillLaunches(CommerceProviderBackfillDeps{
		Dependencies: commerceDeps, Store: commerceStore, Logger: logger,
	})
	assertProviderBackfillInventory(t, commerceLaunches, []string{
		"shopify-backfill-worker|shopify backfill worker exited|*commerce.ShopifyBackfillWorker",
		"woocommerce-backfill-worker|woocommerce backfill worker exited|*commerce.WooCommerceBackfillWorker",
		"bigcommerce-backfill-worker|bigcommerce backfill worker exited|*commerce.BigCommerceBackfillWorker",
		"stripe-backfill-worker|stripe backfill worker exited|*commerce.StripeBackfillWorker",
		"square-backfill-worker|square backfill worker exited|*commerce.SquareBackfillWorker",
		"paypal-backfill-worker|paypal backfill worker exited|*commerce.PayPalBackfillWorker",
		"razorpay-backfill-worker|razorpay backfill worker exited|*commerce.RazorpayBackfillWorker",
		"adobe-commerce-backfill-worker|adobe commerce backfill worker exited|*commerce.AdobeCommerceBackfillWorker",
		"wix-backfill-worker|wix backfill worker exited|*commerce.WixStoresBackfillWorker",
		"squarespace-backfill-worker|squarespace backfill worker exited|*commerce.SquarespaceBackfillWorker",
	})
	assertProviderWorkerGraphIdentity(t, commerceLaunches, commerceStore, nil, logger)

	crmStore := &crm_integrations.Repo{}
	crmDeps := &crm_integrations.Deps{
		CloseBackfiller:      crm_integrations.CloseRESTBackfiller{},
		CopperBackfiller:     crm_integrations.CopperRESTBackfiller{},
		FreshsalesBackfiller: crm_integrations.FreshsalesRESTBackfiller{},
	}
	crmLaunches := crmProviderBackfillLaunches(CRMProviderBackfillDeps{
		Dependencies: crmDeps, Store: crmStore, Logger: logger,
	})
	assertProviderBackfillInventory(t, crmLaunches, []string{
		"pipedrive-backfill-worker|pipedrive backfill worker exited|*crm_integrations.PipedriveBackfillWorker",
		"hubspot-backfill-worker|hubspot backfill worker exited|*crm_integrations.HubSpotBackfillWorker",
		"salesforce-backfill-worker|salesforce backfill worker exited|*crm_integrations.SalesforceBackfillWorker",
		"zoho-backfill-worker|zoho backfill worker exited|*crm_integrations.ZohoBackfillWorker",
		"dynamics365-backfill-worker|dynamics365 backfill worker exited|*crm_integrations.Dynamics365BackfillWorker",
		"keap-backfill-worker|keap backfill worker exited|*crm_integrations.KeapBackfillWorker",
		"gohighlevel-backfill-worker|gohighlevel backfill worker exited|*crm_integrations.HighLevelBackfillWorker",
		"close-backfill-worker|close backfill worker exited|*crm_integrations.CRMStaticBackfillWorker",
		"copper-backfill-worker|copper backfill worker exited|*crm_integrations.CRMStaticBackfillWorker",
		"freshsales-backfill-worker|freshsales backfill worker exited|*crm_integrations.CRMStaticBackfillWorker",
		"postscript-backfill-worker|postscript backfill worker exited|*crm_integrations.PostscriptBackfillWorker",
		"attentive-backfill-worker|attentive backfill worker exited|*crm_integrations.AttentiveBackfillWorker",
	})
	assertProviderWorkerGraphIdentity(t, crmLaunches, crmStore, crmDeps, logger)
	for index, provider := range []string{crm_integrations.ProviderClose, crm_integrations.ProviderCopper, crm_integrations.ProviderFreshsales} {
		worker, ok := crmLaunches[index+7].worker.(*crm_integrations.CRMStaticBackfillWorker)
		if !ok {
			t.Fatalf("CRM static worker[%d] type = %T", index, crmLaunches[index+7].worker)
		}
		if worker.Provider != provider {
			t.Fatalf("CRM static worker[%d] provider = %q, want %q", index, worker.Provider, provider)
		}
	}

	leadStore := &lead_integrations.Repo{}
	leadDeps := &lead_integrations.Deps{}
	leadLaunches := leadProviderBackfillLaunches(LeadProviderBackfillDeps{
		Dependencies: leadDeps, Store: leadStore, Logger: logger,
	})
	assertProviderBackfillInventory(t, leadLaunches, []string{
		"typeform-backfill-worker|typeform backfill worker exited|*lead_integrations.TypeformBackfillWorker",
		"surveymonkey-backfill-worker|surveymonkey backfill worker exited|*lead_integrations.SurveyMonkeyBackfillWorker",
		"unbounce-backfill-worker|unbounce backfill worker exited|*lead_integrations.UnbounceBackfillWorker",
		"leadpages-backfill-worker|leadpages backfill worker exited|*lead_integrations.LeadpagesBackfillWorker",
		"123formbuilder-backfill-worker|123FormBuilder backfill worker exited|*lead_integrations.FormBuilder123BackfillWorker",
		"instapage-backfill-worker|instapage backfill worker exited|*lead_integrations.InstapageBackfillWorker",
		"jotform-backfill-worker|jotform backfill worker exited|*lead_integrations.JotformBackfillWorker",
		"webflow-backfill-worker|webflow backfill worker exited|*lead_integrations.WebflowBackfillWorker",
		"fillout-backfill-worker|fillout backfill worker exited|*lead_integrations.FilloutBackfillWorker",
		"paperform-backfill-worker|paperform backfill worker exited|*lead_integrations.PaperformBackfillWorker",
		"formstack-backfill-worker|formstack backfill worker exited|*lead_integrations.FormstackBackfillWorker",
		"formsite-backfill-worker|formsite backfill worker exited|*lead_integrations.FormsiteBackfillWorker",
		"cognito-forms-backfill-worker|Cognito Forms backfill worker exited|*lead_integrations.CognitoFormsBackfillWorker",
		"gravity-forms-backfill-worker|gravity forms backfill worker exited|*lead_integrations.GravityFormsBackfillWorker",
		"wpforms-backfill-worker|WPForms backfill worker exited|*lead_integrations.WPFormsBackfillWorker",
		"formidable-forms-backfill-worker|Formidable Forms backfill worker exited|*lead_integrations.FormidableFormsBackfillWorker",
		"feathery-backfill-worker|feathery backfill worker exited|*lead_integrations.FeatheryBackfillWorker",
		"formaloo-backfill-worker|formaloo backfill worker exited|*lead_integrations.FormalooBackfillWorker",
		"tally-backfill-worker|tally backfill worker exited|*lead_integrations.TallyBackfillWorker",
		"google-forms-backfill-worker|google forms backfill worker exited|*lead_integrations.GoogleFormsBackfillWorker",
		"facebook-lead-ads-backfill-worker|facebook lead ads backfill worker exited|*lead_integrations.FacebookLeadAdsBackfillWorker",
		"google-lead-forms-backfill-worker|google lead form extensions backfill worker exited|*lead_integrations.GoogleLeadFormsBackfillWorker",
		"wix-lead-backfill-worker|wix lead backfill worker exited|*lead_integrations.WixBackfillWorker",
	})
	assertProviderWorkerGraphIdentity(t, leadLaunches, leadStore, leadDeps, logger)
}

func TestProviderBackfillSurfacesPreserveStructuralAndSharedDependencies(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	pool := &db.Pool{}
	store := &commerce.Repo{Pool: pool}
	deps := CommerceProviderBackfillDeps{
		Pool: pool, Dependencies: &commerce.Deps{}, Store: store,
		AutomationServiceURL: "https://automation.example", Logger: logger,
	}
	surface := NewCommerceProviderBackfillSurface(deps)
	if surface.Lifecycle == nil || surface.FlowRuns != nil || len(surface.Backfills) != 10 {
		t.Fatal("commerce provider surface is incomplete")
	}
	if surface.FlowRuntime.ExecutionEnabled || surface.FlowRuntime.RuntimeStatus != "unavailable" {
		t.Fatalf("flow runtime = %+v, want unavailable", surface.FlowRuntime)
	}
	if surface.Lifecycle.Repo != store || surface.Lifecycle.Logger != logger {
		t.Fatal("commerce provider surface changed shared dependency identity")
	}
	trackRepo, ok := surface.Lifecycle.Events.(*track.Repo)
	if !ok || trackRepo.Pool != pool || trackRepo.FlowRuns == nil {
		t.Fatal("commerce lifecycle event graph changed pool identity")
	}
	flowRepo, ok := trackRepo.FlowRuns.(*flowbuilder.Repo)
	if !ok || flowRepo.Pool != pool {
		t.Fatal("commerce lifecycle flow-run graph changed pool identity")
	}
	for _, incomplete := range []CommerceProviderBackfillDeps{
		{Dependencies: deps.Dependencies, Store: store},
		{Pool: pool, Store: store},
		{Pool: pool, Dependencies: deps.Dependencies},
	} {
		got := NewCommerceProviderBackfillSurface(incomplete)
		if got.Lifecycle != nil || got.FlowRuns != nil || got.Backfills != nil {
			t.Fatal("structurally incomplete commerce dependencies returned a partial surface")
		}
		if got.FlowRuntime.ExecutionEnabled || got.FlowRuntime.RuntimeStatus != "unavailable" {
			t.Fatalf("incomplete surface runtime = %+v, want explicitly unavailable", got.FlowRuntime)
		}
	}
	if got := marketingIntegrationBackfillLaunches(MarketingIntegrationBackfillDeps{}); got != nil {
		t.Fatal("incomplete marketing dependencies returned launches")
	}
	if got := crmProviderBackfillLaunches(CRMProviderBackfillDeps{}); got != nil {
		t.Fatal("incomplete CRM dependencies returned launches")
	}
	if got := leadProviderBackfillLaunches(LeadProviderBackfillDeps{}); got != nil {
		t.Fatal("incomplete lead dependencies returned launches")
	}
	marketingDeps := &marketing_integrations.Deps{}
	marketingStore := &marketing_integrations.Repo{}
	marketing := marketingIntegrationBackfillLaunches(MarketingIntegrationBackfillDeps{Dependencies: marketingDeps, Store: marketingStore, Logger: logger})
	assertProviderWorkerGraphIdentity(t, marketing, marketingStore, marketingDeps, logger)
}

func TestProviderBackfillsMainPlacementAndOwnership(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	// run() starts the outbox drain first and the sending deprovision worker
	// last, with every provider backfill in between. e8d23a62d moved both
	// safego.Go starts into helpers, so the order is pinned at the helpers' call
	// sites in run(), and each start is pinned inside its helper.
	assertProviderSourceOrder(t, root.main, []string{
		"startOutboxDrainWorkers(logger, outboxWorker, outboxCtx,",
		"apiworkers.StartMarketingIntegrationBackfills(outboxCtx,",
		"apiworkers.StartIntelligentRetryWorker(outboxCtx, logger, intelligentRetryQueue)",
		"apiworkers.StartCommerceProviderBackfills(outboxCtx,",
		"apiworkers.StartCRMProviderBackfills(outboxCtx,",
		"apiworkers.StartLeadProviderBackfills(outboxCtx,",
		"startSendingMaintenanceWorkers(logger, outboxCtx,",
	})
	for _, start := range []struct{ function, marker string }{
		{function: "startOutboxDrainWorkers", marker: "safego.Go(logger, \"outbox-worker\""},
		{function: "startSendingMaintenanceWorkers", marker: "safego.Go(logger, \"sending-deprovision-worker\""},
	} {
		if !strings.Contains(root.function(t, start.function), start.marker) {
			t.Fatalf("%s no longer holds %q, whose position in run() the provider backfills are ordered against",
				start.function, start.marker)
		}
	}
	for _, forbidden := range []string{
		"klaviyoBackfillWorker :=",
		"commerceLifecycleWorker :=",
		"pipedriveBackfillWorker :=",
		"typeformBackfillWorker :=",
		"hubspot-webhook-reconcile",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated provider-worker composition %q", forbidden)
		}
	}
}

func TestCommerceProviderStartupDoesNotOwnFlowRuntime(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("provider_backfills.go")
	if err != nil {
		t.Fatalf("read provider_backfills.go: %v", err)
	}
	source := string(sourceBytes)
	for _, forbidden := range []string{
		`safego.Go(deps.Logger, "flow-runs-drainer"`,
		`surface.FlowRuns.Run(ctx`,
		`FlowRuns: &flowbuilder.Drainer{`,
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("commerce provider startup still owns unsafe flow runtime %q", forbidden)
		}
	}
	if !strings.Contains(source, `logger.Info("flow-runs drainer disabled"`) {
		t.Fatal("commerce provider startup does not report the contained flow runtime")
	}
}

func assertProviderBackfillInventory(t *testing.T, got []providerBackfillLaunch, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("provider launch count = %d, want %d", len(got), len(want))
	}
	for index, launch := range got {
		identity := fmt.Sprintf("%s|%s|%T", launch.name, launch.exitMessage, launch.worker)
		if identity != want[index] {
			t.Fatalf("provider launch[%d] = %q, want %q", index, identity, want[index])
		}
	}
}

func assertProviderWorkerGraphIdentity(t *testing.T, launches []providerBackfillLaunch, store, deps any, logger *slog.Logger) {
	t.Helper()
	for index, launch := range launches {
		worker := reflect.ValueOf(launch.worker)
		if worker.Kind() != reflect.Pointer || worker.IsNil() {
			t.Fatalf("provider launch[%d] has invalid worker %T", index, launch.worker)
		}
		worker = worker.Elem()
		for fieldName, want := range map[string]any{"Store": store, "Deps": deps, "Logger": logger} {
			field := worker.FieldByName(fieldName)
			if !field.IsValid() || want == nil {
				continue
			}
			if field.Interface() != want {
				t.Fatalf("provider launch[%d] %s changed identity", index, fieldName)
			}
		}
		if field := worker.FieldByName("Backfiller"); launch.name != "shopify-backfill-worker" && field.IsValid() && field.Kind() == reflect.Interface && field.IsNil() {
			t.Fatalf("provider launch[%d] has a nil backfiller", index)
		}
	}
}

func assertProviderSourceOrder(t *testing.T, source string, markers []string) {
	t.Helper()
	position := -1
	for _, marker := range markers {
		next := strings.Index(source[position+1:], marker)
		if next < 0 {
			t.Fatalf("source is missing marker %q", marker)
		}
		position += next + 1
	}
}
