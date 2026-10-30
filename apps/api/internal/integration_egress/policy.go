// SPDX-License-Identifier: AGPL-3.0-only
package integration_egress

import (
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"net/url"
	"strings"
)

const (
	FamilyCommerce     = "commerce"
	FamilyReviews      = "reviews"
	FamilySupport      = "support"
	FamilySubscription = "subscription"
	FamilyLoyalty      = "loyalty"
	FamilyAnalytics    = "analytics"
	FamilyCRM          = "crm"
	FamilyMarketing    = "marketing"
	FamilyLeads        = "leads"
	FamilyVerification = "verification"
)

var (
	ErrUnknownProvider  = errors.New("outbound integration provider has no egress policy")
	ErrDestination      = errors.New("outbound integration destination is not allowed")
	ErrCrossOrigin      = errors.New("outbound integration redirect changed origin")
	ErrResponseTooLarge = errors.New("outbound integration response exceeds the configured limit")
)

type settingKind uint8

const (
	settingURL settingKind = iota + 1
	settingHost
	settingTenantLabelOrHost
)

type providerPolicy struct {
	exactHosts       []string
	hostSuffixes     []string
	allowAnyPublic   bool
	settings         map[string]settingKind
	settingOverrides map[string]hostPolicy
	maxResponseBytes int64
}

type hostPolicy struct {
	exactHosts     []string
	hostSuffixes   []string
	allowAnyPublic bool
}

type policyKey struct {
	family   string
	provider string
}

const defaultMaxResponseBytes int64 = 16 << 20

// policies is the checked-in inventory for every native integration provider
// that can make an authenticated outbound request. URL/domain settings are
// deliberately explicit: the inventory test fails if a provider catalog adds
// another URL-shaped setting without adding a policy here.
var policies = map[policyKey]providerPolicy{
	// Commerce.
	key(FamilyCommerce, "shopify"): {
		exactHosts:       []string{"storage.googleapis.com"},
		hostSuffixes:     []string{"myshopify.com", "shopify.com", "shopifycdn.com", "googleusercontent.com"},
		settings:         hosts("shop_domain"),
		maxResponseBytes: 512 << 20,
	},
	key(FamilyCommerce, "woocommerce"):          publicProvider(urls("store_url")),
	key(FamilyCommerce, "bigcommerce"):          fixedHosts([]string{"api.bigcommerce.com"}, nil),
	key(FamilyCommerce, "adobe-commerce"):       publicProvider(urls("base_url", "api_base_url")),
	key(FamilyCommerce, "stripe"):               fixedHosts([]string{"api.stripe.com"}, nil),
	key(FamilyCommerce, "square"):               withOverrides(fixedHosts([]string{"connect.squareup.com", "connect.squareupsandbox.com"}, urls("webhook_notification_url")), map[string]hostPolicy{"webhook_notification_url": publicHosts()}),
	key(FamilyCommerce, "paypal"):               fixedHosts([]string{"api-m.paypal.com", "api-m.sandbox.paypal.com"}, nil),
	key(FamilyCommerce, "razorpay"):             fixedHosts([]string{"api.razorpay.com"}, nil),
	key(FamilyCommerce, "wix-stores"):           fixedHosts([]string{"www.wixapis.com", "www.wix.com", "manage.wix.com"}, urls("api_base_url", "token_url")),
	key(FamilyCommerce, "squarespace-commerce"): withOverrides(fixedHosts([]string{"api.squarespace.com"}, urls("store_url", "api_base_url")), map[string]hostPolicy{"store_url": publicHosts()}),

	// Review platforms.
	key(FamilyReviews, "yotpo"):        fixedHosts([]string{"api.yotpo.com"}, urls("api_base_url")),
	key(FamilyReviews, "judge-me"):     withOverrides(fixedHosts([]string{"judge.me"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyReviews, "okendo"):       fixedHosts([]string{"api.okendo.io"}, nil),
	key(FamilyReviews, "loox"):         withOverrides(fixedHosts([]string{"loox.io"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyReviews, "stamped"):      fixedHosts([]string{"stamped.io"}, nil),
	key(FamilyReviews, "trustpilot"):   fixedHosts([]string{"api.trustpilot.com"}, nil),
	key(FamilyReviews, "reviews-io"):   fixedHosts([]string{"api.reviews.io"}, nil),
	key(FamilyReviews, "bazaarvoice"):  fixedHosts([]string{"api.bazaarvoice.com"}, nil),
	key(FamilyReviews, "powerreviews"): fixedHosts([]string{"readservices-b2c.powerreviews.com"}, nil),

	// Customer support. Account-scoped SaaS providers use suffix rules; fixed
	// APIs use exact hosts. Self-hosted customer endpoints are not silently
	// generalized here.
	key(FamilySupport, "zendesk"):                  fixedSuffixes([]string{"zendesk.com"}, mergeSettings(tenantHosts("subdomain"), urls("api_base_url"))),
	key(FamilySupport, "intercom"):                 fixedHosts([]string{"api.intercom.io"}, urls("api_base_url")),
	key(FamilySupport, "gorgias"):                  withOverrides(fixedSuffixes([]string{"gorgias.com"}, mergeSettings(hosts("account_domain", "shop_domain"), urls("api_base_url"))), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilySupport, "freshdesk"):                fixedSuffixes([]string{"freshdesk.com"}, mergeSettings(hosts("account_domain"), urls("api_base_url"))),
	key(FamilySupport, "help-scout"):               fixedHosts([]string{"api.helpscout.net"}, urls("api_base_url")),
	key(FamilySupport, "front"):                    fixedHosts([]string{"api2.frontapp.com"}, urls("api_base_url")),
	key(FamilySupport, "zoho-desk"):                fixedSuffixes([]string{"zoho.com", "zoho.eu", "zoho.in", "zoho.com.au", "zoho.jp", "zoho.ca", "zoho.sa"}, urls("api_base_url")),
	key(FamilySupport, "kustomer"):                 fixedHosts([]string{"api.kustomerapp.com"}, urls("api_base_url")),
	key(FamilySupport, "freshchat"):                fixedSuffixes([]string{"freshchat.com", "freshworks.com"}, mergeSettings(hosts("account_domain"), urls("api_base_url"))),
	key(FamilySupport, "livechat"):                 fixedHosts([]string{"api.livechatinc.com"}, urls("api_base_url")),
	key(FamilySupport, "crisp"):                    fixedHosts([]string{"api.crisp.chat"}, urls("api_base_url")),
	key(FamilySupport, "tidio"):                    fixedHosts([]string{"api.tidio.com"}, urls("api_base_url")),
	key(FamilySupport, "olark"):                    fixedHosts([]string{"api.olark.com"}, urls("api_base_url")),
	key(FamilySupport, "drift"):                    fixedHosts([]string{"driftapi.com"}, urls("api_base_url")),
	key(FamilySupport, "ada"):                      fixedSuffixes([]string{"ada.support"}, mergeSettings(hosts("ai_agent_domain"), urls("api_base_url"))),
	key(FamilySupport, "gladly"):                   fixedSuffixes([]string{"gladly.com"}, mergeSettings(hosts("organization_domain"), urls("api_base_url"))),
	key(FamilySupport, "reamaze"):                  fixedSuffixes([]string{"reamaze.com"}, mergeSettings(hosts("account_domain"), urls("api_base_url"))),
	key(FamilySupport, "groove"):                   fixedHosts([]string{"api.groovehq.com"}, urls("api_base_url")),
	key(FamilySupport, "kayako"):                   fixedSuffixes([]string{"kayako.com"}, mergeSettings(hosts("account_domain"), urls("api_base_url"))),
	key(FamilySupport, "helpcrunch"):               fixedSuffixes([]string{"helpcrunch.com"}, urls("api_base_url")),
	key(FamilySupport, "hubspot-service-hub"):      fixedHosts([]string{"api.hubapi.com"}, urls("api_base_url")),
	key(FamilySupport, "salesforce-service-cloud"): fixedSuffixes([]string{"salesforce.com", "force.com"}, mergeSettings(urls("instance_url", "api_base_url"), nil)),
	key(FamilySupport, "jira-service-management"): {
		exactHosts:       []string{"api.atlassian.com"},
		hostSuffixes:     []string{"atlassian.net"},
		settings:         urls("site_url", "api_base_url"),
		maxResponseBytes: defaultMaxResponseBytes,
	},
	key(FamilySupport, "linear"):          fixedHosts([]string{"api.linear.app"}, urls("graphql_url", "api_base_url")),
	key(FamilySupport, "asana-support"):   fixedHosts([]string{"app.asana.com"}, urls("api_base_url")),
	key(FamilySupport, "clickup-support"): fixedHosts([]string{"api.clickup.com"}, urls("api_base_url")),

	// Subscription and shipping.
	key(FamilySubscription, "recharge"):           withOverrides(fixedHosts([]string{"api.rechargeapps.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": suffixHosts("myshopify.com")}),
	key(FamilySubscription, "skio"):               withOverrides(fixedHosts([]string{"graphql.skio.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": suffixHosts("myshopify.com")}),
	key(FamilySubscription, "aftership"):          fixedHosts([]string{"api.aftership.com"}, urls("api_base_url")),
	key(FamilySubscription, "shipstation"):        fixedHosts([]string{"ssapi.shipstation.com"}, urls("api_base_url")),
	key(FamilySubscription, "shippo"):             withOverrides(fixedHosts([]string{"api.goshippo.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "easyship"):           withOverrides(fixedHosts([]string{"api.easyship.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "shipbob"):            fixedHosts([]string{"api.shipbob.com"}, nil),
	key(FamilySubscription, "easypost"):           withOverrides(fixedHosts([]string{"api.easypost.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "narvar"):             withOverrides(fixedSuffixes([]string{"narvar.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "route"):              withOverrides(fixedSuffixes([]string{"route.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "malomo"):             fixedSuffixes([]string{"myshopify.com"}, hosts("shop_domain")),
	key(FamilySubscription, "wonderment"):         fixedSuffixes([]string{"myshopify.com"}, hosts("shop_domain")),
	key(FamilySubscription, "bold-subscriptions"): withOverrides(fixedHosts([]string{"api.boldcommerce.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "ordergroove"):        withOverrides(fixedSuffixes([]string{"ordergroove.com"}, hosts("store_domain")), map[string]hostPolicy{"store_domain": publicHosts()}),
	key(FamilySubscription, "loop-subscriptions"): withOverrides(fixedHosts([]string{"api.loopsubscriptions.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": suffixHosts("myshopify.com")}),
	key(FamilySubscription, "appstle"):            withOverrides(fixedHosts([]string{"subscription-admin.appstle.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": suffixHosts("myshopify.com")}),
	key(FamilySubscription, "seal-subscriptions"): withOverrides(fixedHosts([]string{"app.sealsubscriptions.com"}, mergeSettings(hosts("store_domain"), urls("api_base_url"))), map[string]hostPolicy{"store_domain": suffixHosts("myshopify.com")}),
	key(FamilySubscription, "chargebee"):          fixedSuffixes([]string{"chargebee.com"}, urls("api_base_url")),

	// Loyalty and referrals.
	key(FamilyLoyalty, "smile"):         withOverrides(fixedHosts([]string{"api.smile.io"}, mergeSettings(hosts("shop_domain"), urls("api_base_url"))), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyLoyalty, "loyaltylion"):   fixedHosts([]string{"api.loyaltylion.com"}, nil),
	key(FamilyLoyalty, "rivo"):          withOverrides(fixedHosts([]string{"developer-api.rivo.io"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyLoyalty, "referralcandy"): withOverrides(fixedHosts([]string{"my.referralcandy.com"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyLoyalty, "growave"):       fixedSuffixes([]string{"myshopify.com"}, hosts("shop_domain")),
	key(FamilyLoyalty, "marsello"):      fixedSuffixes([]string{"myshopify.com"}, hosts("shop_domain")),
	key(FamilyLoyalty, "antavo"):        fixedHosts([]string{"api.antavo.com"}, nil),
	key(FamilyLoyalty, "friendbuy"):     withOverrides(fixedHosts([]string{"mapi.fbot.me"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyLoyalty, "talkable"):      fixedHosts([]string{"www.talkable.com"}, nil),

	// Analytics. Explicit self-hosting providers permit any public HTTPS host;
	// all other providers remain pinned to their SaaS domains.
	key(FamilyAnalytics, "ga4"):                fixedHosts([]string{"www.google-analytics.com", "analyticsdata.googleapis.com"}, nil),
	key(FamilyAnalytics, "google-tag-manager"): withOverrides(fixedHosts([]string{"tagmanager.googleapis.com"}, urls("server_container_url")), map[string]hostPolicy{"server_container_url": publicHosts()}),
	key(FamilyAnalytics, "segment"):            fixedHosts([]string{"api.segment.io", "platform.segmentapis.com"}, nil),
	key(FamilyAnalytics, "rudderstack"):        publicProvider(urls("data_plane_url")),
	key(FamilyAnalytics, "mixpanel"):           fixedHosts([]string{"mixpanel.com", "eu.mixpanel.com", "in.mixpanel.com"}, urls("api_base_url")),
	key(FamilyAnalytics, "amplitude"):          fixedHosts([]string{"amplitude.com", "analytics.eu.amplitude.com"}, urls("api_base_url")),
	key(FamilyAnalytics, "posthog"):            publicProvider(urls("host", "api_base_url")),
	key(FamilyAnalytics, "heap"):               fixedSuffixes([]string{"heap.io"}, nil),
	key(FamilyAnalytics, "hotjar"):             fixedSuffixes([]string{"hotjar.com"}, nil),
	key(FamilyAnalytics, "fullstory"):          fixedSuffixes([]string{"fullstory.com"}, nil),
	key(FamilyAnalytics, "plausible"):          publicProvider(mergeSettings(hosts("site_domain"), urls("host"))),
	key(FamilyAnalytics, "fathom-analytics"):   withOverrides(fixedSuffixes([]string{"usefathom.com"}, hosts("site_domain")), map[string]hostPolicy{"site_domain": publicHosts()}),
	key(FamilyAnalytics, "matomo"):             publicProvider(urls("host")),
	key(FamilyAnalytics, "adobe-analytics"):    fixedSuffixes([]string{"adobe.io", "omtrdc.net"}, nil),
	key(FamilyAnalytics, "looker-studio"):      fixedSuffixes([]string{"googleapis.com"}, nil),
	key(FamilyAnalytics, "looker"):             publicProvider(urls("instance_url")),
	key(FamilyAnalytics, "tableau"):            publicProvider(urls("server_url")),
	key(FamilyAnalytics, "power-bi"):           fixedHosts([]string{"api.powerbi.com"}, nil),
	key(FamilyAnalytics, "mode"):               fixedHosts([]string{"app.mode.com"}, nil),
	key(FamilyAnalytics, "metabase"):           publicProvider(urls("instance_url")),
	key(FamilyAnalytics, "sisense"):            publicProvider(urls("instance_url")),
	key(FamilyAnalytics, "kissmetrics"):        fixedSuffixes([]string{"kissmetrics.io", "kissmetrics.com"}, nil),
	key(FamilyAnalytics, "woopra"):             withOverrides(fixedSuffixes([]string{"woopra.com"}, hosts("domain")), map[string]hostPolicy{"domain": publicHosts()}),
	key(FamilyAnalytics, "chartmogul"):         fixedHosts([]string{"api.chartmogul.com"}, nil),
	key(FamilyAnalytics, "baremetrics"):        fixedHosts([]string{"api.baremetrics.com"}, nil),
	key(FamilyAnalytics, "profitwell"):         fixedSuffixes([]string{"profitwell.com"}, nil),
	key(FamilyAnalytics, "triple-whale"):       withOverrides(fixedHosts([]string{"api.triplewhale.com"}, mergeSettings(hosts("shop_domain"), urls("api_base_url", "endpoint"))), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),
	key(FamilyAnalytics, "northbeam"):          fixedSuffixes([]string{"northbeam.io"}, hosts("shop_domain")),
	key(FamilyAnalytics, "daasity"):            fixedSuffixes([]string{"daasity.com"}, hosts("shop_domain")),
	key(FamilyAnalytics, "glew"):               withOverrides(fixedSuffixes([]string{"glew.io"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": publicHosts()}),
	key(FamilyAnalytics, "peel-insights"):      withOverrides(fixedSuffixes([]string{"peelinsights.com"}, hosts("shop_domain")), map[string]hostPolicy{"shop_domain": suffixHosts("myshopify.com")}),

	// CRM.
	key(FamilyCRM, "hubspot"):    withOverrides(fixedHosts([]string{"api.hubapi.com", "app.hubspot.com"}, mergeSettings(urls("api_base_url"), hosts("hubspot_hub_domain"))), map[string]hostPolicy{"hubspot_hub_domain": publicHosts()}),
	key(FamilyCRM, "salesforce"): fixedSuffixes([]string{"salesforce.com", "force.com"}, urls("instance_url")),
	key(FamilyCRM, "pipedrive"):  fixedSuffixes([]string{"pipedrive.com"}, mergeSettings(tenantHosts("company_domain", "pipedrive_company_domain"), urls("api_base_url"))),
	key(FamilyCRM, "zoho-crm"): fixedHosts([]string{
		"www.zohoapis.com", "www.zohoapis.eu", "www.zohoapis.in", "www.zohoapis.com.au", "www.zohoapis.jp", "www.zohoapis.com.cn", "www.zohoapis.ca",
		"accounts.zoho.com", "accounts.zoho.eu", "accounts.zoho.in", "accounts.zoho.com.au", "accounts.zoho.jp", "accounts.zohocloud.ca",
	}, urls("api_base_url")),
	key(FamilyCRM, "microsoft-dynamics-365"): fixedSuffixes([]string{"dynamics.com", "microsoft.com", "microsoftonline.com"}, urls("environment_url")),
	key(FamilyCRM, "keap"):                   fixedHosts([]string{"api.infusionsoft.com", "accounts.infusionsoft.com"}, urls("api_base_url")),
	key(FamilyCRM, "close"):                  fixedHosts([]string{"api.close.com"}, urls("api_base_url")),
	key(FamilyCRM, "copper"):                 fixedHosts([]string{"api.copper.com"}, urls("api_base_url")),
	key(FamilyCRM, "freshsales"):             fixedSuffixes([]string{"freshsales.io", "freshworks.com"}, mergeSettings(hosts("account_domain"), urls("api_base_url"))),
	key(FamilyCRM, "highlevel"):              fixedHosts([]string{"services.leadconnectorhq.com", "marketplace.leadconnectorhq.com"}, urls("api_base_url")),
	key(FamilyCRM, "postscript"):             fixedHosts([]string{"api.postscript.io"}, urls("api_base_url")),
	key(FamilyCRM, "attentive"):              fixedHosts([]string{"api.attentivemobile.com"}, urls("api_base_url")),

	// Marketing integrations. Most are push-only today, but their catalog URL
	// settings are still validated before persistence.
	key(FamilyMarketing, "klaviyo"):          fixedHosts([]string{"a.klaviyo.com", "www.klaviyo.com"}, nil),
	key(FamilyMarketing, "mailchimp"):        fixedSuffixes([]string{"api.mailchimp.com"}, nil),
	key(FamilyMarketing, "activecampaign"):   publicProvider(urls("api_url")),
	key(FamilyMarketing, "customerio"):       fixedSuffixes([]string{"customer.io"}, nil),
	key(FamilyMarketing, "brevo"):            fixedHosts([]string{"api.brevo.com"}, nil),
	key(FamilyMarketing, "convertkit"):       fixedHosts([]string{"api.convertkit.com"}, nil),
	key(FamilyMarketing, "substack"):         fixedSuffixes([]string{"substack.com"}, urls("publication_url")),
	key(FamilyMarketing, "beehiiv"):          fixedHosts([]string{"api.beehiiv.com"}, nil),
	key(FamilyMarketing, "mailerlite"):       fixedHosts([]string{"connect.mailerlite.com"}, nil),
	key(FamilyMarketing, "sendy"):            publicProvider(nil),
	key(FamilyMarketing, "constant-contact"): fixedHosts([]string{"api.cc.email"}, nil),
	key(FamilyMarketing, "aweber"):           fixedHosts([]string{"api.aweber.com"}, nil),
	key(FamilyMarketing, "drip"):             fixedHosts([]string{"api.getdrip.com"}, nil),
	key(FamilyMarketing, "campaign-monitor"): fixedHosts([]string{"api.createsend.com"}, nil),
	key(FamilyMarketing, "omnisend"):         fixedHosts([]string{"api.omnisend.com"}, nil),
	key(FamilyMarketing, "loops"):            fixedHosts([]string{"app.loops.so"}, nil),

	// Lead capture and form providers.
	key(FamilyLeads, "typeform"):                    fixedHosts([]string{"api.typeform.com", "api.eu.typeform.com"}, nil),
	key(FamilyLeads, "jotform"):                     fixedHosts([]string{"api.jotform.com", "eu-api.jotform.com", "hipaa-api.jotform.com"}, urls("api_base_url")),
	key(FamilyLeads, "google-forms"):                fixedHosts([]string{"forms.googleapis.com"}, urls("api_base_url")),
	key(FamilyLeads, "microsoft-forms"):             fixedHosts([]string{"graph.microsoft.com"}, nil),
	key(FamilyLeads, "surveymonkey"):                fixedHosts([]string{"api.surveymonkey.com"}, urls("api_base_url")),
	key(FamilyLeads, "facebook-lead-ads"):           fixedHosts([]string{"graph.facebook.com"}, nil),
	key(FamilyLeads, "linkedin-lead-gen"):           fixedHosts([]string{"api.linkedin.com"}, nil),
	key(FamilyLeads, "google-lead-form-extensions"): fixedHosts([]string{"googleads.googleapis.com"}, nil),
	key(FamilyLeads, "tiktok-lead-generation"):      fixedHosts([]string{"business-api.tiktok.com"}, nil),
	key(FamilyLeads, "snap-lead-ads"):               fixedHosts([]string{"adsapi.snapchat.com"}, nil),
	key(FamilyLeads, "reddit-lead-gen"):             fixedHosts([]string{"ads-api.reddit.com"}, nil),
	key(FamilyLeads, "pinterest-lead-ads"):          fixedHosts([]string{"api.pinterest.com"}, nil),
	key(FamilyLeads, "unbounce"):                    fixedHosts([]string{"api.unbounce.com"}, urls("api_base_url")),
	key(FamilyLeads, "leadpages"):                   fixedHosts([]string{"api.leadpages.net"}, urls("api_base_url")),
	key(FamilyLeads, "instapage"):                   fixedHosts([]string{"api.instapage.com"}, urls("api_base_url")),
	key(FamilyLeads, "carrd"):                       fixedSuffixes([]string{"carrd.co"}, nil),
	key(FamilyLeads, "paperform"):                   fixedHosts([]string{"api.paperform.co"}, urls("api_base_url")),
	key(FamilyLeads, "formstack"):                   fixedHosts([]string{"www.formstack.com"}, urls("api_base_url")),
	key(FamilyLeads, "fillout"):                     fixedHosts([]string{"api.fillout.com", "eu-api.fillout.com"}, urls("api_base_url")),
	key(FamilyLeads, "optinmonster"):                fixedSuffixes([]string{"optinmonster.com"}, nil),
	key(FamilyLeads, "privy"):                       fixedSuffixes([]string{"privy.com"}, nil),
	key(FamilyLeads, "convertflow"):                 fixedSuffixes([]string{"convertflow.com"}, nil),
	key(FamilyLeads, "sleeknote"):                   fixedSuffixes([]string{"sleeknote.com"}, nil),
	key(FamilyLeads, "wisepops"):                    fixedSuffixes([]string{"wisepops.com"}, nil),
	key(FamilyLeads, "poptin"):                      fixedSuffixes([]string{"popt.in", "poptin.com"}, nil),
	key(FamilyLeads, "hello-bar"):                   fixedSuffixes([]string{"hellobar.com"}, nil),
	key(FamilyLeads, "unstack"):                     fixedSuffixes([]string{"unstack.com"}, nil),
	key(FamilyLeads, "landingi"):                    fixedSuffixes([]string{"landingi.com"}, nil),
	key(FamilyLeads, "kickofflabs"):                 fixedSuffixes([]string{"kickofflabs.com"}, nil),
	key(FamilyLeads, "shortstack"):                  fixedSuffixes([]string{"shortstack.com"}, nil),
	key(FamilyLeads, "formsite"):                    fixedSuffixes([]string{"formsite.com"}, urls("api_base_url")),
	key(FamilyLeads, "cognito-forms"):               fixedHosts([]string{"www.cognitoforms.com"}, urls("api_base_url", "odata_base_url")),
	key(FamilyLeads, "ninja-forms"):                 publicProvider(urls("site_url")),
	key(FamilyLeads, "formidable-forms"):            publicProvider(urls("site_url")),
	key(FamilyLeads, "interact"):                    fixedSuffixes([]string{"tryinteract.com"}, nil),
	key(FamilyLeads, "outgrow"):                     fixedSuffixes([]string{"outgrow.co"}, nil),
	key(FamilyLeads, "riddle"):                      fixedSuffixes([]string{"riddle.com"}, nil),
	key(FamilyLeads, "qualtrics-forms"):             fixedSuffixes([]string{"qualtrics.com"}, nil),
	key(FamilyLeads, "feathery"):                    fixedHosts([]string{"api.feathery.io"}, urls("api_base_url")),
	key(FamilyLeads, "formaloo"):                    fixedHosts([]string{"api.formaloo.me"}, urls("api_base_url")),
	key(FamilyLeads, "123formbuilder"):              fixedHosts([]string{"api.123formbuilder.com"}, urls("api_base_url")),
	key(FamilyLeads, "gravity-forms"):               publicProvider(urls("site_url")),
	key(FamilyLeads, "wpforms"):                     publicProvider(urls("site_url")),
	key(FamilyLeads, "wordpress"):                   publicProvider(urls("site_url")),
	key(FamilyLeads, "webflow"):                     fixedHosts([]string{"api.webflow.com"}, urls("api_base_url")),
	key(FamilyLeads, "wix"):                         fixedHosts([]string{"www.wixapis.com", "www.wix.com"}, urls("api_base_url", "token_url")),
	key(FamilyLeads, "squarespace"):                 fixedHosts([]string{"api.squarespace.com"}, nil),
	key(FamilyLeads, "tally"):                       fixedHosts([]string{"api.tally.so"}, urls("api_base_url")),

	// Email-verification vendors. These APIs receive billable tenant keys in
	// query strings or request bodies, so their runtime destinations are fixed
	// to the vendors' official origins and never come from tenant settings.
	key(FamilyVerification, "zerobounce"): fixedHosts([]string{"api.zerobounce.net"}, nil),
	key(FamilyVerification, "kickbox"):    fixedHosts([]string{"api.kickbox.com"}, nil),
}

func key(family, provider string) policyKey {
	return policyKey{family: family, provider: provider}
}

func urls(keys ...string) map[string]settingKind  { return settingsOf(settingURL, keys...) }
func hosts(keys ...string) map[string]settingKind { return settingsOf(settingHost, keys...) }
func tenantHosts(keys ...string) map[string]settingKind {
	return settingsOf(settingTenantLabelOrHost, keys...)
}

func settingsOf(kind settingKind, keys ...string) map[string]settingKind {
	out := make(map[string]settingKind, len(keys))
	for _, key := range keys {
		out[key] = kind
	}
	return out
}

func mergeSettings(groups ...map[string]settingKind) map[string]settingKind {
	out := map[string]settingKind{}
	for _, group := range groups {
		for key, kind := range group {
			out[key] = kind
		}
	}
	return out
}

func fixedHosts(exact []string, settings map[string]settingKind) providerPolicy {
	return providerPolicy{exactHosts: exact, settings: settings, maxResponseBytes: defaultMaxResponseBytes}
}

func fixedSuffixes(suffixes []string, settings map[string]settingKind) providerPolicy {
	return providerPolicy{hostSuffixes: suffixes, settings: settings, maxResponseBytes: defaultMaxResponseBytes}
}

func publicProvider(settings map[string]settingKind) providerPolicy {
	return providerPolicy{allowAnyPublic: true, settings: settings, maxResponseBytes: defaultMaxResponseBytes}
}

func withOverrides(policy providerPolicy, overrides map[string]hostPolicy) providerPolicy {
	policy.settingOverrides = overrides
	return policy
}

func publicHosts() hostPolicy                   { return hostPolicy{allowAnyPublic: true} }
func suffixHosts(suffixes ...string) hostPolicy { return hostPolicy{hostSuffixes: suffixes} }

func lookupPolicy(family, provider string) (providerPolicy, bool) {
	p, ok := policies[key(strings.ToLower(strings.TrimSpace(family)), strings.ToLower(strings.TrimSpace(provider)))]
	return p, ok
}

// HasSettingPolicy is used by the catalog inventory guard. It is exported so
// the guard can remain in an external test package without creating import
// cycles between this package and the integration packages.
func HasSettingPolicy(family, provider, setting string) bool {
	p, ok := lookupPolicy(family, provider)
	if !ok {
		return false
	}
	_, ok = p.settings[strings.ToLower(strings.TrimSpace(setting))]
	return ok
}

// HasProviderPolicy reports whether a native integration provider has an
// explicit outbound policy, even if it currently has no URL settings.
func HasProviderPolicy(family, provider string) bool {
	_, ok := lookupPolicy(family, provider)
	return ok
}

// IsURLLikeSettingKey is the single definition used by both request-time
// validation and the static catalog guard.
func IsURLLikeSettingKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return key == "host" || key == "domain" || key == "subdomain" ||
		strings.HasSuffix(key, "_url") || strings.HasSuffix(key, "_host") || strings.HasSuffix(key, "_domain")
}

// ValidateSettings rejects undeclared URL-shaped settings and validates every
// declared URL/domain before an integration can be persisted or auto-backfill
// can be scheduled.
func ValidateSettings(family, provider string, settings map[string]any) error {
	p, ok := lookupPolicy(family, provider)
	if !ok {
		return fmt.Errorf("%w: %s/%s", ErrUnknownProvider, family, provider)
	}
	for rawKey, rawValue := range settings {
		setting := strings.ToLower(strings.TrimSpace(rawKey))
		if !IsURLLikeSettingKey(setting) {
			continue
		}
		kind, declared := p.settings[setting]
		if !declared {
			return fmt.Errorf("%w: %s/%s setting %q has no egress policy", ErrDestination, family, provider, setting)
		}
		value := strings.TrimSpace(stringSetting(rawValue))
		if value == "" {
			continue
		}
		hosts := hostPolicy{exactHosts: p.exactHosts, hostSuffixes: p.hostSuffixes, allowAnyPublic: p.allowAnyPublic}
		if override, exists := p.settingOverrides[setting]; exists {
			hosts = override
		}
		var err error
		switch kind {
		case settingURL:
			err = validateURLAgainstHostPolicy(value, hosts)
		case settingHost:
			err = validateHostSetting(value, hosts)
		case settingTenantLabelOrHost:
			err = validateTenantLabelOrHost(value, hosts)
		default:
			err = ErrDestination
		}
		if err != nil {
			return fmt.Errorf("%w: %s/%s setting %q: %v", ErrDestination, family, provider, setting, err)
		}
	}
	return nil
}

// ValidateURL validates the final request URL against a provider's runtime
// allowlist. Credential payload overrides therefore cannot bypass the settings
// validator.
func ValidateURL(family, provider, raw string) error {
	p, ok := lookupPolicy(family, provider)
	if !ok {
		return fmt.Errorf("%w: %s/%s", ErrUnknownProvider, family, provider)
	}
	return validateURLAgainstHostPolicy(raw, hostPolicy{
		exactHosts:     p.exactHosts,
		hostSuffixes:   p.hostSuffixes,
		allowAnyPublic: p.allowAnyPublic,
	})
}

func validateURLAgainstHostPolicy(raw string, policy hostPolicy) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return errors.New("URL is empty or too long")
	}
	u, err := url.Parse(raw)
	if testDestinationAllowed(u, raw) {
		return nil
	}
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Hostname() == "" || u.User != nil {
		return errors.New("URL must be an absolute HTTPS URL without embedded credentials")
	}
	if u.Fragment != "" {
		return errors.New("URL fragments are not allowed")
	}
	if unsafeLiteralHost(u.Hostname()) {
		return errors.New("URL targets localhost or a private/reserved address")
	}
	if !hostAllowed(u.Hostname(), policy) {
		return errors.New("host is outside the provider allowlist")
	}
	return nil
}

func validateHostSetting(raw string, policy hostPolicy) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 253 || strings.ContainsAny(raw, "/?#@") {
		return errors.New("host must be a bare DNS name")
	}
	if strings.Contains(raw, ":") {
		return errors.New("host must not include a scheme or port")
	}
	host := strings.TrimSuffix(strings.ToLower(raw), ".")
	if runningUnderGoTest() && strings.HasSuffix(host, ".test") {
		return nil
	}
	if unsafeLiteralHost(host) {
		return errors.New("host targets localhost or a private/reserved address")
	}
	if !hostAllowed(host, policy) {
		return errors.New("host is outside the provider allowlist")
	}
	return nil
}

func validateTenantLabelOrHost(raw string, policy hostPolicy) error {
	value := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	if value != "" && !strings.Contains(value, ".") && validDNSLabel(value) {
		return nil
	}
	return validateHostSetting(value, policy)
}

func validDNSLabel(value string) bool {
	if value == "" || len(value) > 63 || value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

// Test binaries need to exercise OAuth callbacks and provider setup against
// httptest listeners. The Go test flag is registered only in test executables;
// production binaries cannot enable this compatibility path with an
// environment variable. The production transport still blocks private DNS and
// dial targets independently.
func testDestinationAllowed(u *url.URL, raw string) bool {
	if !runningUnderGoTest() || u == nil || u.User != nil || u.Hostname() == "" {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if u.Scheme == "https" && strings.HasSuffix(host, ".test") {
		return true
	}
	if u.Scheme == "http" && strings.HasPrefix(strings.TrimSpace(raw), "http://") {
		if addr, err := netip.ParseAddr(host); err == nil && addr.IsLoopback() {
			return true
		}
		return host == "localhost" || strings.HasSuffix(host, ".localhost")
	}
	return false
}

func runningUnderGoTest() bool {
	return flag.Lookup("test.v") != nil
}

func hostAllowed(raw string, policy hostPolicy) bool {
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	if host == "" {
		return false
	}
	for _, allowed := range policy.exactHosts {
		if host == strings.TrimSuffix(strings.ToLower(allowed), ".") {
			return true
		}
	}
	for _, suffix := range policy.hostSuffixes {
		suffix = strings.Trim(strings.ToLower(suffix), ".")
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return policy.allowAnyPublic
}

func unsafeLiteralHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && blockedIP(addr)
}

func stringSetting(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return ""
	}
}
