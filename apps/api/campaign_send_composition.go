// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigndelivery"
	"github.com/postwave/postwave/apps/api/internal/campaignsendruntime"
	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementhoneypot"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

const (
	campaignBoundSendTransportName = "sesv2_raw_mime"
	campaignBoundSendLeaseTTL      = 30 * time.Second
)

// campaignBoundSendComposition is immutable after construction. main.go
// installs Dispatcher on the send guard before starting either of its worker
// goroutines, avoiding a live pointer mutation while Loop reads the guard.
type campaignBoundSendComposition struct {
	Dispatcher       sending.AssuranceBoundDispatcher
	ReplyCorrelation *replycorrelation.Service
	LeaseOwner       string
	Transport        string
}

func (c campaignBoundSendComposition) enabled() bool {
	return c.Dispatcher != nil
}

type campaignBoundSendStartupDependencies struct {
	Enabled          bool
	Pool             *db.Pool
	Objects          uploads.Store
	Mailer           mailer.Mailer
	Gate             campaignassurancegate.BoundAuthorizer
	Polls            campaignsendruntime.PollLinkMinter
	Honeypot         campaignsendruntime.HoneypotDecoyMinter
	VerifySchema     func(context.Context, *db.Pool) error
	NewLeaseOwner    func() string
	ReplyCorrelation *replycorrelation.Service
}

// initializeCampaignBoundSendRuntime keeps the raw-MIME convergence path
// default-off with the Campaign Assurance queue gate. Once enabled, startup
// fails unless exact artifacts, the plural override ledger, encrypted object
// storage, and a receipt-bearing raw provider are all available. It never
// enables receiptless delivery or claims SES provider idempotency/dedicated
// messenger support.
func initializeCampaignBoundSendRuntime(
	ctx context.Context,
	enabled bool,
	pool *db.Pool,
	objects uploads.Store,
	outboundMailer mailer.Mailer,
	gate campaignassurancegate.BoundAuthorizer,
	pollLinks campaignsendruntime.PollLinkMinter,
	honeypot campaignsendruntime.HoneypotDecoyMinter,
) (campaignBoundSendComposition, error) {
	replyCorrelation, err := campaignReplyCorrelationFromEnv(enabled)
	if err != nil {
		return campaignBoundSendComposition{}, err
	}
	return initializeCampaignBoundSendRuntimeWithDependencies(ctx, campaignBoundSendStartupDependencies{
		Enabled:          enabled,
		Pool:             pool,
		Objects:          objects,
		Mailer:           outboundMailer,
		Gate:             gate,
		Polls:            pollLinks,
		Honeypot:         honeypot,
		VerifySchema:     verifyCampaignBoundSendSchema,
		NewLeaseOwner:    uuid.NewString,
		ReplyCorrelation: replyCorrelation,
	})
}

func initializeCampaignBoundSendRuntimeWithDependencies(
	ctx context.Context,
	dependencies campaignBoundSendStartupDependencies,
) (campaignBoundSendComposition, error) {
	if !dependencies.Enabled {
		return campaignBoundSendComposition{}, nil
	}
	if dependencies.Pool == nil || dependencies.Objects == nil || dependencies.Mailer == nil || dependencies.Gate == nil {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime requires database, tenant object store, outbound mailer, and the shared Campaign Assurance gate")
	}
	if dependencies.ReplyCorrelation == nil {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime requires a versioned reply-correlation keyring and inbound domain")
	}
	// The transport must be told the SAME bounce domain the send guard mints
	// into, or the two disagree in the worst possible direction: the guard stamps
	// a VERP return path and the transport refuses the message as having a
	// mismatched envelope, so every bound send fails at the last step.
	//
	// Read from one environment variable in both places rather than passed
	// between them, because a single source is the only arrangement in which they
	// cannot drift apart.
	transport := campaigntransport.RawMailerTransport{Mailer: dependencies.Mailer}
	capabilities := transport.Capabilities()
	if !capabilities.RawMIME || !capabilities.ProviderReceipt {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime requires a raw-MIME provider with correlation receipts")
	}
	// These limitations are deliberate safety blockers in the runtime. Do not
	// reinterpret a custom mailer as provider-idempotent or dedicated-route
	// capable merely because it can return a receipt.
	if capabilities.ProviderIdempotency || capabilities.DedicatedMessenger {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime received unsupported transport capability claims")
	}
	if dependencies.VerifySchema == nil {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime schema verifier is required")
	}
	if err := dependencies.VerifySchema(ctx, dependencies.Pool); err != nil {
		return campaignBoundSendComposition{}, fmt.Errorf("campaign bound send runtime readiness: %w", err)
	}
	if dependencies.NewLeaseOwner == nil {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime lease identity factory is required")
	}
	leaseOwner := strings.TrimSpace(dependencies.NewLeaseOwner())
	parsedLeaseOwner, err := uuid.Parse(leaseOwner)
	if err != nil || parsedLeaseOwner.String() != leaseOwner {
		return campaignBoundSendComposition{}, errors.New("campaign bound send runtime lease identity must be a canonical UUID")
	}
	coordinator := &campaigndelivery.Coordinator{
		Store:         campaigndelivery.NewRepo(dependencies.Pool),
		Transport:     transport,
		TransportName: campaignBoundSendTransportName,
		LeaseOwner:    leaseOwner,
		LeaseDuration: campaignBoundSendLeaseTTL,
		// Production must retain a provider message ID for feedback and
		// reconciliation. The zero value is intentionally fail-closed.
		AllowReceiptlessTransport: false,
	}
	assuranceRepository := campaignassurance.NewRepo(dependencies.Pool)
	runtime := &campaignsendruntime.Runtime{
		Artifacts:        campaignartifact.NewRepo(dependencies.Pool),
		Assurance:        assuranceRepository,
		Gate:             dependencies.Gate,
		Objects:          dependencies.Objects,
		Recipients:       &campaignsendruntime.PostgresRecipientResolver{Pool: dependencies.Pool},
		Polls:            dependencies.Polls,
		Honeypot:         dependencies.Honeypot,
		ReplyCorrelation: dependencies.ReplyCorrelation,
		Delivery:         coordinator,
	}
	return campaignBoundSendComposition{
		Dispatcher:       runtime,
		ReplyCorrelation: dependencies.ReplyCorrelation,
		LeaseOwner:       leaseOwner,
		Transport:        campaignBoundSendTransportName,
	}, nil
}

func campaignReplyCorrelationFromEnv(enabled bool) (*replycorrelation.Service, error) {
	if !enabled {
		return nil, nil
	}
	raw := strings.TrimSpace(os.Getenv("POSTWAVE_REPLIES_VERP_KEYRING_JSON"))
	domain := strings.TrimSpace(os.Getenv("POSTWAVE_REPLIES_ENVELOPE_DOMAIN"))
	if raw == "" || domain == "" {
		return nil, errors.New("campaign bound send runtime requires POSTWAVE_REPLIES_VERP_KEYRING_JSON and POSTWAVE_REPLIES_ENVELOPE_DOMAIN")
	}
	ttl := replycorrelation.DefaultTTL
	if configured := strings.TrimSpace(os.Getenv("POSTWAVE_REPLIES_VERP_TTL")); configured != "" {
		parsed, err := time.ParseDuration(configured)
		if err != nil {
			return nil, fmt.Errorf("campaign bound send runtime invalid POSTWAVE_REPLIES_VERP_TTL: %w", err)
		}
		ttl = parsed
	}
	service, err := replycorrelation.ParseConfig(raw, domain, ttl)
	if err != nil {
		return nil, fmt.Errorf("campaign bound send runtime reply correlation: %w", err)
	}
	return service, nil
}

// verifyCampaignBoundSendSchema proves the complete read/write shape used by
// the runtime before a process can drain assurance-bound rows. Each subquery is
// empty by construction; PostgreSQL still resolves table, column, and SELECT
// privileges, including migration 1924's complete override-id set.
func verifyCampaignBoundSendSchema(ctx context.Context, pool *db.Pool) error {
	if pool == nil {
		return errors.New("database pool is required")
	}
	readinessCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := pool.Exec(readinessCtx, `
SELECT
  EXISTS (SELECT cr.id FROM campaign_content_revisions cr WHERE false),
  EXISTS (SELECT sp.id FROM campaign_send_plans sp WHERE false),
  EXISTS (SELECT ra.id FROM campaign_render_artifacts ra WHERE false),
  EXISTS (SELECT ar.id FROM campaign_assurance_runs ar WHERE false),
  EXISTS (SELECT ara.artifact_id FROM campaign_assurance_run_artifacts ara WHERE false),
  EXISTS (SELECT arc.configuration_hash FROM campaign_assurance_run_configurations arc WHERE false),
  EXISTS (SELECT art.outbound_mime_hash FROM campaign_assurance_run_targets art WHERE false),
  EXISTS (SELECT af.receipt_hash FROM campaign_assurance_findings af WHERE false),
  EXISTS (SELECT ao.finding_receipt_hash FROM campaign_assurance_overrides ao WHERE false),
  EXISTS (SELECT cr.assurance_override_ids FROM campaign_recipients cr WHERE false),
  EXISTS (SELECT sd.gate_override_ids FROM campaign_send_deliveries sd WHERE false),
  EXISTS (
    SELECT sd.reply_to, sd.reply_correlation_version,
           sd.reply_correlation_key_id, sd.reply_correlation_expires_at,
           sd.reply_correlation_token_hash
      FROM campaign_send_deliveries sd WHERE false
  )
`)
	if err != nil {
		return fmt.Errorf("exact campaign delivery schema unavailable: %w", err)
	}
	var deliveryPrivileges, gateFunctionReady, lifecycleFunctionReady bool
	var gateTriggerReady, lifecycleTriggerReady, replyTriggerReady, replyResolverReady bool
	if err := pool.QueryRow(readinessCtx, `
SELECT
  has_table_privilege(
    current_user,
    'campaign_send_deliveries',
    'SELECT,INSERT,UPDATE'
  ),
  to_regprocedure('campaign_send_deliveries_gate_guard()') IS NOT NULL,
  to_regprocedure('campaign_send_deliveries_lifecycle_guard()') IS NOT NULL,
  to_regprocedure('resolve_campaign_reply_correlation_tenant(text)') IS NOT NULL
    AND has_function_privilege(current_user, 'resolve_campaign_reply_correlation_tenant(text)', 'EXECUTE'),
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.oid = 'campaign_send_deliveries'::regclass
       AND t.tgname = 'campaign_send_deliveries_gate_guard'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ),
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.oid = 'campaign_send_deliveries'::regclass
       AND t.tgname = 'campaign_send_deliveries_lifecycle_guard'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ),
  EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.oid = 'campaign_send_deliveries'::regclass
       AND t.tgname = 'campaign_send_delivery_reply_correlation_guard'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  )
`).Scan(
		&deliveryPrivileges,
		&gateFunctionReady,
		&lifecycleFunctionReady,
		&replyResolverReady,
		&gateTriggerReady,
		&lifecycleTriggerReady,
		&replyTriggerReady,
	); err != nil {
		return fmt.Errorf("campaign delivery privilege readiness: %w", err)
	}
	if !deliveryPrivileges || !gateFunctionReady || !lifecycleFunctionReady ||
		!gateTriggerReady || !lifecycleTriggerReady || !replyTriggerReady || !replyResolverReady {
		return errors.New("campaign delivery role, gate, or lifecycle enforcement is not ready")
	}
	return nil
}

// campaignHoneypotMinter returns the F01 decoy minter for the send runtime, or
// a nil interface when honeypots are not configured.
//
// The nil is returned as an untyped nil rather than a typed nil pointer: a
// non-nil interface holding a nil pointer would pass the runtime's `!= nil`
// check and then be called, which is the classic Go trap. Both env vars must be
// present, because a decoy pointing at an unset base URL is markup in customer
// mail that measures nothing.
func campaignHoneypotMinter(
	minter *engagementhoneypot.Minter, baseURL string, logger *slog.Logger,
) campaignsendruntime.HoneypotDecoyMinter {
	if minter == nil || strings.TrimSpace(baseURL) == "" {
		return nil
	}
	return &engagementhoneypot.SendMinter{
		Minter: minter, BaseURL: strings.TrimSpace(baseURL), Logger: logger,
	}
}
