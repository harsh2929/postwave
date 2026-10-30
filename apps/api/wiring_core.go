// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	apiboot "github.com/postwave/postwave/apps/api/internal/boot"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/discounts"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/onsite_growth"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/polls"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/safety"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	"github.com/postwave/postwave/apps/api/internal/sending"
	apiserver "github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
	"github.com/postwave/postwave/apps/api/internal/verification"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
	"github.com/postwave/postwave/packages/secrets"
)

// configureSnowflakeExecutor wires the Snowflake database/sql executor onto
// the warehouse repo unless disabled. Moved verbatim from run().
func configureSnowflakeExecutor(secretsResolver secrets.Resolver, warehouseRepo *warehouse.Repo, logger *slog.Logger) {
	if os.Getenv("POSTWAVE_DISABLE_SNOWFLAKE_EXECUTOR") != "1" {
		snowflakeExecutor := warehouse.NewSnowflakeSQLExecutor(
			warehouse.NewSnowflakeSecretsCredentialResolver(secretsResolver),
		)
		if driverName := strings.TrimSpace(os.Getenv("POSTWAVE_SNOWFLAKE_SQL_DRIVER")); driverName != "" {
			snowflakeExecutor.DriverName = driverName
		}
		if raw := strings.TrimSpace(os.Getenv("POSTWAVE_SNOWFLAKE_MAX_OPEN_CONNS")); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 {
				snowflakeExecutor.MaxOpenConns = n
			}
		}
		if raw := strings.TrimSpace(os.Getenv("POSTWAVE_SNOWFLAKE_MAX_QUERY_ROWS")); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 {
				snowflakeExecutor.MaxQueryRows = n
			}
		}
		warehouseRepo.SnowflakeExecutor = snowflakeExecutor
		logDriver := strings.TrimSpace(snowflakeExecutor.DriverName)
		if logDriver == "" {
			logDriver = "snowflake"
		}
		logger.Info("warehouse: Snowflake database/sql executor enabled", "driver", logDriver)
	}
}

// buildFormUploads builds the form upload pipeline: quarantine reader, tenant
// quota, pending limit, ClamAV scanner, orphan sweeper and scan worker. Moved
// verbatim from run().
func buildFormUploads(pool *db.Pool, formsRepo *forms.Repo, uploadStore forms.UploadStore, logger *slog.Logger, cfg config.Config, formsDeps *forms.Deps, outboxCtx context.Context) (*forms.Uploads, error) {
	formsUploads := &forms.Uploads{
		Pool: pool, Repo: formsRepo, Store: uploadStore, Logger: logger,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
	}
	reader, readerOK := uploadStore.(forms.UploadObjectReader)
	if !readerOK {
		return nil, fmt.Errorf("configured form upload store cannot open quarantine objects for malware scanning")
	}
	formsUploads.ObjectReader = reader
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_FORM_UPLOAD_TENANT_QUOTA_BYTES")); raw != "" {
		quota, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || quota < forms.MaxUploadBytes {
			return nil, fmt.Errorf("POSTWAVE_FORM_UPLOAD_TENANT_QUOTA_BYTES must be an integer >= %d", forms.MaxUploadBytes)
		}
		formsUploads.TenantQuotaBytes = quota
	}
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_FORM_UPLOAD_PENDING_LIMIT")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 10000 {
			return nil, fmt.Errorf("POSTWAVE_FORM_UPLOAD_PENDING_LIMIT must be an integer from 1 to 10000")
		}
		formsUploads.PendingLimit = limit
	}
	clamAddr := strings.TrimSpace(os.Getenv("POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR"))
	if err := validateProductionFormUploadScannerConfig(clamAddr); err != nil {
		return nil, err
	}
	// The public forms' other production-only requirement: every double
	// opt-in email links to FORMS_PUBLIC_HOST.
	if err := validateProductionFormsPublicHost(cfg.FormsPublicHost); err != nil {
		return nil, err
	}
	if clamAddr != "" {
		scanner, err := forms.NewClamAVScanner(clamAddr)
		if err != nil {
			return nil, err
		}
		probeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = scanner.Ping(probeCtx)
		cancel()
		if err != nil {
			if isProductionEnv() {
				return nil, fmt.Errorf("form upload malware scanner readiness: %w", err)
			}
			logger.Warn("form upload malware scanner unavailable; uploads remain quarantined", "err", err.Error())
		} else {
			formsUploads.Scanner = scanner
			logger.Info("form upload malware scanner ready")
		}
	}
	formsDeps.Uploads = formsUploads
	formUploadSweeper := &forms.OrphanSweeper{Uploads: formsUploads, Logger: logger}
	safego.Go(logger, "form-upload-orphan-sweeper", func() { formUploadSweeper.Run(outboxCtx) })
	if formsUploads.Scanner != nil {
		formUploadScanner := &forms.UploadScanWorker{Uploads: formsUploads, Logger: logger}
		safego.Go(logger, "form-upload-malware-scanner", func() { formUploadScanner.Run(outboxCtx) })
	}

	return formsUploads, nil
}

// buildFormsDepsResult bundles the values buildFormsDeps hands back to run().
type buildFormsDepsResult struct {
	formsRepo         *forms.Repo
	discountsRepo     *discounts.Repo
	onsiteGrowthRepo  *onsite_growth.Repo
	verificationStore *verification.Store
	formsDeps         *forms.Deps
	publicFormEmbed   *forms.EmbedDeps
}

// buildFormsDeps builds the forms, discounts and onsite-growth repos, the
// shared verification store and the public form dependencies. The public
// form handlers never call Listmonk: the signup's audience and Listmonk
// writes run from the outbox (registerFormsSignupHandlers), and run() hands
// them the outbound mailer for confirmation emails once it exists.
func buildFormsDeps(pool *db.Pool, logger *slog.Logger, secretsResolver secrets.Resolver, cfg config.Config, outboxRepo *outbox.Repo) buildFormsDepsResult {
	formsRepo := &forms.Repo{Pool: pool}
	discountsRepo := &discounts.Repo{Pool: pool}
	onsiteGrowthRepo := &onsite_growth.Repo{Pool: pool}
	// Shared verification store. Built HERE, well before the
	// authenticated router exists, because the public form-submit gate
	// needs it at forms.Deps construction time. The same instance is
	// handed to MountVerificationSurface later so both call paths share
	// one DNS cache.
	verificationStore := apiserver.NewVerificationStore(pool, logger, secretsResolver)

	formsDeps := &forms.Deps{
		Repo:                    formsRepo,
		SignupGate:              apiserver.NewFormsSignupGate(verificationStore),
		PublicHostBase:          cfg.FormsPublicHost,
		RecaptchaSecret:         cfg.RecaptchaSecret,
		RecaptchaSiteKey:        cfg.RecaptchaSiteKey,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		Outbox:                  newFormsOutboxAdapter(outboxRepo),
		Webhooks:                newWebhookFanoutAppender(outboxRepo),
		Logger:                  logger,
	}
	publicFormEmbed := &forms.EmbedDeps{
		Deps:            formsDeps,
		FormsPublicHost: cfg.FormsPublicHost,
	}

	return buildFormsDepsResult{
		formsRepo:         formsRepo,
		discountsRepo:     discountsRepo,
		onsiteGrowthRepo:  onsiteGrowthRepo,
		verificationStore: verificationStore,
		formsDeps:         formsDeps,
		publicFormEmbed:   publicFormEmbed,
	}
}

// buildSMSDeps derives the SMS inbox keys and builds the SMS dependencies.
// Moved verbatim from run().
func buildSMSDeps(cfg config.Config, pool *db.Pool, logger *slog.Logger) *sms.Deps {
	smsInboxCursorKey := append([]byte(nil), cfg.SMSInboxCursorKey...)
	if len(smsInboxCursorKey) == 0 && !isProductionEnv() {
		// Local-only continuity. Production readiness blocks an absent/short
		// dedicated cursor-encryption key.
		smsInboxCursorKey = []byte("postwave-local-sms-inbox-cursor-key-v1")
	}
	smsInboxAuditFingerprintKey := append([]byte(nil), cfg.PIIFingerprintPepper...)
	if len(smsInboxAuditFingerprintKey) == 0 && !isProductionEnv() {
		smsInboxAuditFingerprintKey = []byte("postwave-local-sms-inbox-audit-fingerprint-key-v1")
	}
	smsDeps := &sms.Deps{
		Store:                    &sms.Store{Pool: pool},
		Provider:                 sms.NewProviderRouterFromEnv(),
		TwilioAuthToken:          os.Getenv("TWILIO_WEBHOOK_AUTH_TOKEN"),
		PublicBaseURL:            cfg.SMSProviderCallbackBaseURL,
		InboxCursorKey:           smsInboxCursorKey,
		InboxCursorPreviousKey:   append([]byte(nil), cfg.SMSInboxCursorPreviousKey...),
		InboxAuditFingerprintKey: smsInboxAuditFingerprintKey,
		Logger:                   logger,
	}

	return smsDeps
}

// wireCampaignQueueFilters attaches the sandbox lifecycle and the frequency,
// subscriber-preference and prioritization queue filters to the campaign
// dependencies. Moved verbatim from run().
func wireCampaignQueueFilters(campaignDeps *campaigns.Deps, pool *db.Pool, logger *slog.Logger) {
	campaignDeps.Sandbox = sandboxCampaignLifecycle{
		Simulator: &sandbox.Simulator{
			Queue:  &sandbox.PgxQueue{Pool: pool},
			Logger: logger,
		},
	}
	// G16 (campaigns 2026): tenant frequency-cap filter at queue-fill.
	// Loosely-typed shim so the campaigns package keeps the frequency
	// package out of its import graph (tighter dependency cone).
	// SUB-133: pass the campaign's send channel through to the channel-aware
	// cap filter so a multi-channel rule (channels=['email','sms',...]) counts
	// sends across every channel in its set toward one shared cap, instead of
	// silently degrading to email-only at queue time.
	campaignDeps.Frequency = func(ctx context.Context, tenantID, channel string, candidates []string) ([]string, int, []campaigns.FrequencySkipBreakdown, error) {
		res, err := frequency.FilterAudienceForChannel(ctx, pool, tenantID, channel, candidates)
		if err != nil {
			return candidates, 0, nil, err
		}
		bd := make([]campaigns.FrequencySkipBreakdown, 0, len(res.Breakdown))
		for _, b := range res.Breakdown {
			bd = append(bd, campaigns.FrequencySkipBreakdown{
				RuleID: b.RuleID, RuleLabel: b.RuleLabel, Skipped: b.Skipped,
			})
		}
		return res.Kept, res.Skipped, bd, nil
	}
	// SUB-132: subscriber-level frequency preference filter at queue-fill.
	// Excludes recipients whose frequency_preference='paused' and whose pause
	// is still in effect. Loosely-typed shim, same pattern as the tenant
	// frequency-cap filter above.
	campaignDeps.SubscriberPreference = func(ctx context.Context, tenantID string, candidates []string) ([]string, int, error) {
		res, err := frequency.FilterBySubscriberPreference(ctx, pool, tenantID, candidates)
		if err != nil {
			return nil, 0, err
		}
		return res.Kept, res.Skipped, nil
	}
}

// wireAuditEventEmitters wires the transactional and best-effort audit.created
// emitters. Moved verbatim from run().
func wireAuditEventEmitters(canonicalWebhookFanout *outbound_webhooks.TransactionalFanout, eventsBus *events.Bus) {
	// audit row. The realtime bus below remains presentation-only and may be
	// best-effort; customer webhooks never depend on it.
	db.SetAuditTransactionalEmitter(func(
		ctx context.Context,
		tx pgx.Tx,
		tenantID, action, resourceType, resourceID, eventID string,
		occurredAt time.Time,
	) error {
		_, err := canonicalWebhookFanout.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
			TenantID:      tenantID,
			EventType:     "audit.created",
			SourceEventID: eventID,
			OccurredAt:    occurredAt,
			Body: map[string]any{
				"action":        action,
				"resource_type": resourceType,
				"resource_id":   resourceID,
			},
		})
		return err
	})
	// Make the bus reachable from the audit-row writer via a package-
	// level setter (db has no Deps struct to thread through).
	db.SetAuditEventEmitter(func(tenantID, action, resourceType, resourceID string) {
		eventsBus.Publish(events.Event{
			Topic:    "audit.created",
			TenantID: tenantID,
			Payload: map[string]any{
				"action":        action,
				"resource_type": resourceType,
				"resource_id":   resourceID,
			},
		})
	})
}

// buildOutboxPlaneResult bundles the values buildOutboxPlane hands back to run().
type buildOutboxPlaneResult struct {
	customFieldsRepo       *customfields.Repo
	customFieldsValidator  *customfields.Validator
	outboxRepo             *outbox.Repo
	dlqDeps                *outbox.Deps
	canonicalWebhookFanout *outbound_webhooks.TransactionalFanout
	listMembershipWebhooks lists.MembershipWebhookFanout
	webhooksDispatcher     *webhooks.Dispatcher
}

// buildListmonkAndOutboxPlane builds the Listmonk client, custom-fields
// validator, outbox repo and the canonical webhook dispatcher. Moved verbatim
// from run().
func buildOutboxPlane(pool *db.Pool) buildOutboxPlaneResult {
	// Custom-fields validator: tenant_custom_fields drives the schema for
	// subscribers.custom_fields + merge_fields. Mode is per-tenant (set via
	// tenants.custom_fields_mode) with a global env override for ops.
	customFieldsRepo := &customfields.Repo{Pool: pool}
	customFieldsValidator := &customfields.Validator{
		Repo: customFieldsRepo,
		Mode: customfields.ParseMode(os.Getenv("POSTWAVE_CUSTOM_FIELDS_MODE")),
	}
	// outboxRepo is defined here (before subscriber wiring) so the
	// webhooks Dispatcher can hold a reference. The handler registration
	// happens further down once all kinds are known.
	outboxRepo := &outbox.Repo{Pool: pool}
	dlqDeps := &outbox.Deps{Repo: outboxRepo}
	// The webhooks dispatcher fires events from inside subscriber write
	// transactions so receivers never see a row that didn't commit. The
	// adapter below translates between the package-local subscribers
	// shape and the webhooks Dispatcher so subscribers doesn't import
	// webhooks directly.
	canonicalWebhookFanout := &outbound_webhooks.TransactionalFanout{}
	listMembershipWebhooks := newListMembershipWebhookAdapter(canonicalWebhookFanout)
	webhooksDispatcher := &webhooks.Dispatcher{
		Outbox:    outboxRepo,
		Canonical: canonicalWebhookFanout,
	}

	return buildOutboxPlaneResult{
		customFieldsRepo:       customFieldsRepo,
		customFieldsValidator:  customFieldsValidator,
		outboxRepo:             outboxRepo,
		dlqDeps:                dlqDeps,
		canonicalWebhookFanout: canonicalWebhookFanout,
		listMembershipWebhooks: listMembershipWebhooks,
		webhooksDispatcher:     webhooksDispatcher,
	}
}

// wireAuditRedactionAndSafety wires PII redaction for audit rows and the
// pre-send safety + NLQ LLM clients. Moved verbatim from run().
func wireAuditRedactionAndSafety(pool *db.Pool, auditHandlers *handlers.AuditHandlers, logger *slog.Logger) *safety.Service {
	{
		sqlLoader := &audit.SQLPolicyLoader{
			Query: func(ctx context.Context, tenantID string) (string, []byte, error) {
				tx, err := db.WithTenant(ctx, pool, tenantID)
				if err != nil {
					return "", nil, err
				}
				defer func() { _ = tx.Rollback(ctx) }()
				var defaultsCSV string
				var rulesJSON []byte
				err = tx.QueryRow(ctx, `
SELECT default_redacted_fields, jsonpath_rules
  FROM audit_redaction_policies
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&defaultsCSV, &rulesJSON)
				if err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						// Missing row -> empty policy (floor still applies).
						return "", nil, nil
					}
					return "", nil, err
				}
				return defaultsCSV, rulesJSON, nil
			},
		}
		audit.WireDB(sqlLoader, auditHandlers.Cipher)
		logger.Info("audit: pii-redaction wired (per-tenant policy + envelope encryption)")
	}

	// Pre-send safety eval. Static + AUP rules always run; when an Anthropic
	// key is configured, the optional rubric LLM stage is enabled too.
	var safetyLLM safety.LLMClient
	if key := strings.TrimSpace(firstEnv("SAFETY_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")); key != "" {
		safetyLLM = safety.NewAnthropicClient(
			key,
			os.Getenv("SAFETY_LLM_MODEL"),
			os.Getenv("SAFETY_ANTHROPIC_BASE_URL"),
		)
		logger.Info("safety: Anthropic pre-send rubric enabled")
	}
	safetyService := safety.NewService(safetyLLM)

	// natural-language-query: parallel to safetyLLM init, wire the
	// NLQ-specific Anthropic client. Same env fallback so a single
	// ANTHROPIC_API_KEY enables both surfaces. NLQ_LLM_MODEL is
	// optional — defaults to claude-3-5-haiku-latest (cheap).
	if key := strings.TrimSpace(firstEnv("ANTHROPIC_API_KEY", "SAFETY_ANTHROPIC_API_KEY")); key != "" {
		auditHandlers.NLQLLM = audit.NewAnthropicNLQClient(
			key,
			os.Getenv("NLQ_LLM_MODEL"),
			os.Getenv("ANTHROPIC_BASE_URL"),
		)
		logger.Info("audit-nlq: Anthropic natural-language query enabled")
	}

	return safetyService
}

// initializeSendingPersistenceAndAWSResult bundles the values initializeSendingPersistenceAndAWS hands back to run().
type initializeSendingPersistenceAndAWSResult struct {
	stateRepo          sending.StateRepo
	warmupTracker      sending.WarmupTracker
	tenantControlsRepo *tenantcontrols.Repo
	awsCfg             aws.Config
	kmsKeyID           string
	envCipher          sending.EnvelopeEncryptor
	secretsResolver    secrets.Resolver
	provisioner        *sending.Provisioner
	sendingHandlers    *handlers.SendingHandlers
}

// initializeSendingPersistenceAndAWS initialises sending persistence, the AWS
// dependencies, and the sending provisioner + handlers. Moved verbatim from
// run().
func initializeSendingPersistenceAndAWS(pool *db.Pool, cfg config.Config, logger *slog.Logger) (initializeSendingPersistenceAndAWSResult, error) {
	sendingPersistence, sendingPersistenceErr := apiboot.InitializeSendingPersistence(
		pool,
		cfg,
		logger,
		apiboot.SendingPersistencePolicy{
			IsProduction:        isProductionEnv,
			AllowMemoryFallback: allowMemoryFallback,
		},
	)
	if sendingPersistenceErr != nil {
		return initializeSendingPersistenceAndAWSResult{}, sendingPersistenceErr
	}
	postmarkClient := sendingPersistence.PostmarkClient
	stateRepo := sendingPersistence.StateRepo
	warmupTracker := sendingPersistence.WarmupTracker
	tenantControlsRepo := sendingPersistence.TenantControls
	awsDependencies, awsErr := apiboot.InitializeAWSDependencies(cfg, logger, isProductionEnv())
	if awsErr != nil {
		return initializeSendingPersistenceAndAWSResult{}, awsErr
	}
	awsCfg, kmsKeyID := awsDependencies.Config, awsDependencies.KMSKeyID
	envCipher := awsDependencies.EnvelopeCipher
	secretsResolver := awsDependencies.SecretsResolver
	dipProv := &sending.DedicatedIPProvisioner{Postmark: postmarkClient}
	provisioner := &sending.Provisioner{
		Postmark:       postmarkClient,
		Repo:           stateRepo,
		Warmup:         warmupTracker,
		DedicatedIP:    dipProv,
		EncryptionKey:  cfg.SendingKEK,
		EnvelopeCipher: envCipher,
		DKIMRootDomain: cfg.DKIMRootDomain,
		DefaultRegion:  cfg.DedicatedIPRegion,
	}
	sendingHandlers := &handlers.SendingHandlers{
		Provisioner:   provisioner,
		Repo:          stateRepo,
		WarmupTracker: warmupTracker,
		Controls:      tenantControlsRepo,
	}

	return initializeSendingPersistenceAndAWSResult{
		stateRepo:          stateRepo,
		warmupTracker:      warmupTracker,
		tenantControlsRepo: tenantControlsRepo,
		awsCfg:             awsCfg,
		kmsKeyID:           kmsKeyID,
		envCipher:          envCipher,
		secretsResolver:    secretsResolver,
		provisioner:        provisioner,
		sendingHandlers:    sendingHandlers,
	}, nil
}

// buildPollRepo builds the campaign poll repo and link minter when polls are
// enabled. Moved verbatim from run().
func buildPollRepo(pollRuntimeConfiguration polls.RuntimeConfiguration, pool *db.Pool) (*polls.Repo, *polls.LinkMinter, error) {
	var campaignPollRepo *polls.Repo
	var campaignPollLinkMinter *polls.LinkMinter
	if pollRuntimeConfiguration.Enabled {
		campaignPollRepo = &polls.Repo{Pool: pool, TokenKeyring: pollRuntimeConfiguration.TokenKeyring}
		campaignPollLinkMinter = &polls.LinkMinter{
			Repo: campaignPollRepo, PublicBaseURL: pollRuntimeConfiguration.PublicBaseURL,
		}
		if err := campaignPollLinkMinter.Validate(); err != nil {
			return nil, nil, fmt.Errorf("campaign polls startup configuration: %w", err)
		}
	}

	return campaignPollRepo, campaignPollLinkMinter, nil
}

// loadPollRuntimeConfiguration loads and validates the campaign polls
// startup configuration. Moved verbatim from run().
func loadPollRuntimeConfiguration(cfg config.Config) (polls.RuntimeConfiguration, error) {
	pollRuntimeConfiguration, err := polls.RuntimeConfigurationFromEnvironment(os.Getenv)
	if err != nil {
		return polls.RuntimeConfiguration{}, fmt.Errorf("campaign polls startup configuration: %w", err)
	}
	if err := pollRuntimeConfiguration.ValidateDedicated(
		"POSTWAVE_SENDING_KEK", []byte(os.Getenv("POSTWAVE_SENDING_KEK")),
	); err != nil {
		return polls.RuntimeConfiguration{}, fmt.Errorf("campaign polls startup configuration: %w", err)
	}
	if err := pollRuntimeConfiguration.ValidateDedicated(
		"decoded POSTWAVE_SENDING_KEK", cfg.SendingKEK,
	); err != nil {
		return polls.RuntimeConfiguration{}, fmt.Errorf("campaign polls startup configuration: %w", err)
	}
	if err := pollRuntimeConfiguration.ValidateDedicated(
		"POSTWAVE_INTERNAL_API_TOKEN", []byte(cfg.InternalAPIToken),
	); err != nil {
		return polls.RuntimeConfiguration{}, fmt.Errorf("campaign polls startup configuration: %w", err)
	}

	return pollRuntimeConfiguration, nil
}
