// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"strings"
)

// Catalog surface predicates shared by the health, lifecycle and contract
// handlers.

func isCommerceFoundation(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug != "shopify" && item.Slug != "woocommerce" && item.Slug != "bigcommerce" && item.Slug != "adobe-commerce" && item.Slug != "wix-stores" && item.Slug != "squarespace-commerce" && item.Slug != "stripe" && item.Slug != "square" && item.Slug != "paypal" && item.Slug != "razorpay"
}

func isShopifyCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "shopify"
}

func isWixStoresSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "wix-stores"
}

func isWooCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "woocommerce"
}

func isBigCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "bigcommerce"
}

func isAdobeCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "adobe-commerce"
}

func isSquarespaceCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "squarespace-commerce"
}

func isStripeCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "stripe"
}

func isSquareCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "square"
}

func isPayPalCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "paypal"
}

func isRazorpayCommerceSurface(item CatalogItem) bool {
	return hasSource(item, "commerce") && item.Slug == "razorpay"
}

func isHubSpotCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "hubspot"
}

func isSalesforceCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "salesforce"
}

func isKlaviyoMigrationSurface(item CatalogItem) bool {
	return hasSource(item, "migration") && item.Slug == "klaviyo-migration"
}

func isKlaviyoNativeSurface(item CatalogItem) bool {
	return hasSource(item, "marketing_integration") && item.Slug == "klaviyo"
}

func isMarketingNativeSurface(item CatalogItem) bool {
	return hasSource(item, "marketing_integration")
}

func isMarketingMigrationSurface(item CatalogItem) bool {
	return hasSource(item, "migration") && strings.HasSuffix(item.Slug, "-migration")
}

func isPipedriveCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "pipedrive"
}

func isCloseCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "close"
}

func isZohoCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "zoho-crm"
}

func isDynamics365CRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "microsoft-dynamics-365"
}

func isKeapCRMSurface(item CatalogItem) bool {
	return hasSource(item, "crm") && item.Slug == "keap"
}

func isWixLeadSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "wix"
}

func isFilloutLeadSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "fillout"
}

func isJotformLeadSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "jotform"
}

func isWebflowLeadSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "webflow"
}

func isFacebookLeadAdsSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "facebook-lead-ads"
}

func isGoogleLeadFormsSurface(item CatalogItem) bool {
	return hasSource(item, "lead_capture") && item.Slug == "google-lead-form-extensions"
}

func isManagedIngestFoundation(item CatalogItem) bool {
	if hasSource(item, "commerce") {
		return false
	}
	meta, ok := managedProviderMetadataForItem(item)
	return ok && isPostwaveIngestSyncModel(meta.SyncModel)
}

func isRechargeSubscriptionSurface(item CatalogItem) bool {
	return item.Slug == "recharge" && hasSource(item, "subscription_integration")
}

func isYotpoReviewSurface(item CatalogItem) bool {
	return item.Slug == "yotpo" && hasSource(item, "review_integration")
}

func isSmileLoyaltySurface(item CatalogItem) bool {
	return item.Slug == "smile" && hasSource(item, "loyalty_integration")
}

func isZendeskSupportSurface(item CatalogItem) bool {
	return item.Slug == "zendesk" && hasSource(item, "support_integration")
}

func isIntercomSupportSurface(item CatalogItem) bool {
	return item.Slug == "intercom" && hasSource(item, "support_integration")
}

func isHelpScoutSupportSurface(item CatalogItem) bool {
	return item.Slug == "help-scout" && hasSource(item, "support_integration")
}

func isFreshdeskSupportSurface(item CatalogItem) bool {
	return item.Slug == "freshdesk" && hasSource(item, "support_integration")
}

func isGorgiasSupportSurface(item CatalogItem) bool {
	return item.Slug == "gorgias" && hasSource(item, "support_integration")
}

func isSnowflakeWarehouseSurface(item CatalogItem) bool {
	return item.Slug == "snowflake" && hasSource(item, "warehouse")
}

func isTypeformLeadSurface(item CatalogItem) bool {
	return item.Slug == "typeform" && hasSource(item, "lead_capture")
}
