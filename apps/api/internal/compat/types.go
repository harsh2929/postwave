package compat

import "time"

type Summary struct {
	Contacts    ContactSummary    `json:"contacts"`
	Campaigns   CampaignSummary   `json:"campaigns"`
	Reports     ReportSummary     `json:"reports"`
	Automations AutomationSummary `json:"automations"`
	Growth      GrowthSummary     `json:"growth"`
	Ecommerce   EcommerceSummary  `json:"ecommerce"`
}

type ContactSummary struct {
	Total             int            `json:"total"`
	ByMailchimpStatus map[string]int `json:"by_mailchimp_status"`
	Groups            int            `json:"groups"`
	ActivityEvents    int            `json:"activity_events"`
}

type CampaignSummary struct {
	Total            int            `json:"total"`
	ByType           map[string]int `json:"by_type"`
	Assets           int            `json:"assets"`
	ReusableSections int            `json:"reusable_sections"`
}

type ReportSummary struct {
	Events              int `json:"events"`
	ReportableCampaigns int `json:"reportable_campaigns"`
}

type AutomationSummary struct {
	Total    int            `json:"total"`
	ByStatus map[string]int `json:"by_status"`
}

type GrowthSummary struct {
	LandingPages int `json:"landing_pages"`
	Popups       int `json:"popups"`
	Views        int `json:"views"`
	Conversions  int `json:"conversions"`
}

type EcommerceSummary struct {
	Integrations      int `json:"integrations"`
	Customers         int `json:"customers"`
	Products          int `json:"products"`
	Orders            int `json:"orders"`
	RevenueCents      int `json:"revenue_cents"`
	AttributedRevenue int `json:"attributed_revenue_cents"`
}

type Group struct {
	ID           string    `json:"id"`
	Category     string    `json:"category"`
	Name         string    `json:"name"`
	Type         string    `json:"type"`
	DisplayOrder int       `json:"display_order"`
	SourceID     string    `json:"source_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type GroupInput struct {
	Category     string `json:"category"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	DisplayOrder int    `json:"display_order"`
	SourceID     string `json:"source_id"`
}

type Asset struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	AssetType string         `json:"asset_type"`
	URL       string         `json:"url"`
	AltText   string         `json:"alt_text,omitempty"`
	Metadata  map[string]any `json:"metadata"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

type AssetInput struct {
	Name      string         `json:"name"`
	AssetType string         `json:"asset_type"`
	URL       string         `json:"url"`
	AltText   string         `json:"alt_text"`
	Metadata  map[string]any `json:"metadata"`
}

type Section struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Category  string           `json:"category"`
	Blocks    []map[string]any `json:"blocks"`
	HTML      string           `json:"html,omitempty"`
	MJML      string           `json:"mjml,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

type SectionInput struct {
	Name     string           `json:"name"`
	Category string           `json:"category"`
	Blocks   []map[string]any `json:"blocks"`
	HTML     string           `json:"html"`
	MJML     string           `json:"mjml"`
}

type Journey struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Status      string           `json:"status"`
	Version     int              `json:"version"`
	Triggers    []map[string]any `json:"triggers"`
	Nodes       []map[string]any `json:"nodes"`
	Edges       []map[string]any `json:"edges"`
	Goals       []map[string]any `json:"goals"`
	Analytics   map[string]any   `json:"analytics"`
	PublishedAt *time.Time       `json:"published_at,omitempty"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

type JourneyInput struct {
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	Triggers  []map[string]any `json:"triggers"`
	Nodes     []map[string]any `json:"nodes"`
	Edges     []map[string]any `json:"edges"`
	Goals     []map[string]any `json:"goals"`
	Analytics map[string]any   `json:"analytics"`
}

type LandingPage struct {
	ID        string           `json:"id"`
	TenantID  string           `json:"tenant_id,omitempty"`
	Slug      string           `json:"slug"`
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	Domain    string           `json:"domain,omitempty"`
	Template  string           `json:"template"`
	Blocks    []map[string]any `json:"blocks"`
	SEO       map[string]any   `json:"seo"`
	Tracking  map[string]any   `json:"tracking"`
	Metrics   map[string]any   `json:"metrics"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
	// VariantToken is set on the PUBLIC serve response (LAND-037) when an A/B
	// variant was chosen; its Blocks are already swapped in. It is an OPAQUE,
	// signed token binding the chosen variant to this page — the raw variant id
	// is deliberately NOT exposed. The renderer echoes this token on conversion
	// so the event is attributed to the variant the visitor actually saw
	// without the client being able to forge or harvest arm ids. Empty = the
	// page's own content (control), or signing not configured.
	VariantToken string `json:"variant_token,omitempty"`
}

type LandingPageInput struct {
	Slug     string           `json:"slug"`
	Name     string           `json:"name"`
	Status   string           `json:"status"`
	Domain   string           `json:"domain"`
	Template string           `json:"template"`
	Blocks   []map[string]any `json:"blocks"`
	SEO      map[string]any   `json:"seo"`
	Tracking map[string]any   `json:"tracking"`
}

type PopupForm struct {
	ID        string           `json:"id"`
	TenantID  string           `json:"tenant_id,omitempty"`
	PublicKey string           `json:"public_key,omitempty"`
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	Trigger   map[string]any   `json:"trigger"`
	Targeting map[string]any   `json:"targeting"`
	Blocks    []map[string]any `json:"blocks"`
	FormID    string           `json:"form_id,omitempty"`
	Metrics   map[string]any   `json:"metrics"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

type PopupInput struct {
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	Trigger   map[string]any   `json:"trigger"`
	Targeting map[string]any   `json:"targeting"`
	Blocks    []map[string]any `json:"blocks"`
	FormID    string           `json:"form_id"`
}

type PopupSubmitInput struct {
	Email    string         `json:"email"`
	Metadata map[string]any `json:"metadata"`
}

type CommerceIntegration struct {
	ID           string         `json:"id"`
	Provider     string         `json:"provider"`
	ShopDomain   string         `json:"shop_domain,omitempty"`
	Status       string         `json:"status"`
	Scopes       []string       `json:"scopes"`
	Settings     map[string]any `json:"settings"`
	SyncCursor   string         `json:"sync_cursor,omitempty"`
	LastSyncAt   *time.Time     `json:"last_sync_at,omitempty"`
	ErrorMessage string         `json:"error_message,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
}

type CommerceIntegrationInput struct {
	Provider   string         `json:"provider"`
	ShopDomain string         `json:"shop_domain"`
	Status     string         `json:"status"`
	Scopes     []string       `json:"scopes"`
	Settings   map[string]any `json:"settings"`
}

type CommerceOAuthStart struct {
	AuthorizeURL string    `json:"authorize_url"`
	State        string    `json:"state"`
	ShopDomain   string    `json:"shop_domain"`
	Scopes       []string  `json:"scopes"`
	ExpiresAt    time.Time `json:"expires_at"`
	LocalDemo    bool      `json:"local_demo"`
}

type CommerceWebhookResult struct {
	Accepted      bool   `json:"accepted"`
	Provider      string `json:"provider"`
	Topic         string `json:"topic"`
	IntegrationID string `json:"integration_id,omitempty"`
	Customers     int    `json:"customers"`
	Products      int    `json:"products"`
	Orders        int    `json:"orders"`
}

type CampaignReport struct {
	CampaignID   string           `json:"campaign_id"`
	Sent         int              `json:"sent"`
	Delivered    int              `json:"delivered"`
	Opened       int              `json:"opened"`
	Clicked      int              `json:"clicked"`
	Bounced      int              `json:"bounced"`
	Complained   int              `json:"complained"`
	Unsubscribed int              `json:"unsubscribed"`
	Conversions  int              `json:"conversions"`
	RevenueCents int              `json:"revenue_cents"`
	OpenRate     float64          `json:"open_rate"`
	ClickRate    float64          `json:"click_rate"`
	TopLinks     []ReportCount    `json:"top_links"`
	Devices      []ReportCount    `json:"devices"`
	Clients      []ReportCount    `json:"clients"`
	Geography    []ReportCount    `json:"geography"`
	PerRecipient []RecipientStats `json:"per_recipient"`
}

type ReportCount struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

type RecipientStats struct {
	Email        string `json:"email"`
	Sent         int    `json:"sent"`
	Opened       int    `json:"opened"`
	Clicked      int    `json:"clicked"`
	Bounced      int    `json:"bounced"`
	Complained   int    `json:"complained"`
	Unsubscribed int    `json:"unsubscribed"`
	RevenueCents int    `json:"revenue_cents"`
}

type MailchimpProblem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail"`
	Instance string `json:"instance,omitempty"`
}

type ReportEventInput struct {
	SubscriberEmail string         `json:"subscriber_email"`
	EventType       string         `json:"event_type"`
	LinkURL         string         `json:"link_url"`
	UserAgent       string         `json:"user_agent"`
	IP              string         `json:"ip"`
	Country         string         `json:"country"`
	Region          string         `json:"region"`
	City            string         `json:"city"`
	Device          string         `json:"device"`
	Client          string         `json:"client"`
	RevenueCents    int            `json:"revenue_cents"`
	Metadata        map[string]any `json:"metadata"`
}
