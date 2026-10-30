// Package reportstore persists and aggregates Inbox Reality observations.
package reportstore

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

var (
	ErrNotFound       = errors.New("campaign report not found")
	ErrTenantRequired = errors.New("tenant id required")
)

// MemoryStore is the local/dev implementation used when Postgres is not
// configured. It is process-local and intentionally deterministic for tests.
type MemoryStore struct {
	mu              sync.RWMutex
	defaultTenantID string
	reports         map[string][]domain.InboxReport
}

// NewMemoryStore returns an empty local store. defaultTenantID is used only
// when a local caller does not supply X-Tenant-ID.
func NewMemoryStore(defaultTenantID string) *MemoryStore {
	return &MemoryStore{
		defaultTenantID: strings.TrimSpace(defaultTenantID),
		reports:         make(map[string][]domain.InboxReport),
	}
}

// WriteReport implements seedlist.ReportSink.
func (s *MemoryStore) WriteReport(_ context.Context, r domain.InboxReport) error {
	if r.CampaignID == "" {
		return errors.New("campaign id required")
	}
	r.TenantID = s.tenantOrDefault(r.TenantID)
	if r.CheckedAt.IsZero() {
		r.CheckedAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := storeKey(r.TenantID, r.CampaignID)
	s.reports[key] = append(s.reports[key], r)
	return nil
}

// Get implements handlers.CampaignReportStore.
func (s *MemoryStore) Get(_ context.Context, tenantID string, campaignID string) (domain.CampaignReport, error) {
	tenantID = s.tenantOrDefault(tenantID)
	s.mu.RLock()
	reports := append([]domain.InboxReport(nil), s.reports[storeKey(tenantID, campaignID)]...)
	s.mu.RUnlock()
	if len(reports) == 0 {
		return domain.CampaignReport{}, ErrNotFound
	}
	return Aggregate(campaignID, reports, time.Now().UTC()), nil
}

func (s *MemoryStore) tenantOrDefault(tenantID string) string {
	tenantID = strings.TrimSpace(tenantID)
	if tenantID != "" {
		return tenantID
	}
	if s.defaultTenantID != "" {
		return s.defaultTenantID
	}
	return "local"
}

// Aggregate turns raw inbox rows into the public CampaignReport shape. If a
// mailbox has multiple observations for the same campaign, the newest wins.
func Aggregate(campaignID string, reports []domain.InboxReport, generatedAt time.Time) domain.CampaignReport {
	latest := make(map[string]domain.InboxReport)
	for _, r := range reports {
		if r.CampaignID == "" {
			r.CampaignID = campaignID
		}
		key := r.MailboxID
		if key == "" {
			key = string(r.Provider) + "|" + r.CheckedAt.Format(time.RFC3339Nano)
		}
		if prev, ok := latest[key]; !ok || r.CheckedAt.After(prev.CheckedAt) {
			latest[key] = r
		}
	}

	collapsed := make([]domain.InboxReport, 0, len(latest))
	for _, r := range latest {
		collapsed = append(collapsed, r)
	}
	sort.Slice(collapsed, func(i, j int) bool {
		if collapsed[i].Provider == collapsed[j].Provider {
			return collapsed[i].MailboxID < collapsed[j].MailboxID
		}
		return collapsed[i].Provider < collapsed[j].Provider
	})

	providerCounts := map[domain.Provider]map[domain.Placement]int{}
	overallCounts := map[domain.Placement]int{}
	for _, r := range collapsed {
		if providerCounts[r.Provider] == nil {
			providerCounts[r.Provider] = map[domain.Placement]int{}
		}
		providerCounts[r.Provider][r.Placement]++
		overallCounts[r.Placement]++
	}

	providers := make([]domain.Provider, 0, len(providerCounts))
	for provider := range providerCounts {
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i] < providers[j] })

	breakdowns := make([]domain.ProviderBreakdown, 0, len(providers))
	for _, provider := range providers {
		counts := providerCounts[provider]
		total := 0
		for _, n := range counts {
			total += n
		}
		breakdowns = append(breakdowns, domain.ProviderBreakdown{
			Provider:   provider,
			Total:      total,
			Placements: counts,
		})
	}

	total := len(collapsed)
	overall := make(map[domain.Placement]float64, len(overallCounts))
	for placement, n := range overallCounts {
		if total > 0 {
			overall[placement] = float64(n) / float64(total)
		}
	}
	return domain.CampaignReport{
		CampaignID:   campaignID,
		Providers:    breakdowns,
		Overall:      overall,
		TotalInboxes: total,
		GeneratedAt:  generatedAt,
		Reports:      collapsed,
	}
}

func storeKey(tenantID, campaignID string) string {
	return strings.TrimSpace(tenantID) + "|" + strings.TrimSpace(campaignID)
}
