// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/packages/runtime/internalsign"
	"github.com/postwave/postwave/services/deliverability/internal/inboxreality"
	"github.com/postwave/postwave/services/deliverability/internal/reportstore"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

type inboxRealityDeliverabilityDependencies struct {
	Enabled               bool
	Pool                  *pgxpool.Pool
	Registry              *seedlist.Registry
	Connector             seedlist.Connector
	ConnectorKind         string
	ObservationStore      *reportstore.PostgresStore
	RawMIMECaptureEnabled bool
	GatewayURL            string
	BearerToken           string
	SigningSecrets        string
	SESRegion             string
	SESConfigurationSet   string
	LoadAWSConfig         func(context.Context, string) (aws.Config, error)
}

type inboxRealityDeliverabilityRuntime struct {
	Handler *inboxreality.Handler
	enabled bool
}

func (r inboxRealityDeliverabilityRuntime) Enabled() bool { return r.enabled }

func (r inboxRealityDeliverabilityRuntime) MountInternal(router chi.Router) {
	if r.enabled && r.Handler != nil {
		r.Handler.MountInternal(router)
	}
}

// initializeInboxRealityDeliverabilityRuntime composes the synchronous,
// durable execution endpoint and post-commit observation callback. Explicit
// enablement fails closed if raw observation capture or any trust boundary is
// missing; disabled mode registers no route and no notifier.
func initializeInboxRealityDeliverabilityRuntime(
	ctx context.Context,
	dependencies inboxRealityDeliverabilityDependencies,
) (inboxRealityDeliverabilityRuntime, error) {
	if !dependencies.Enabled {
		return inboxRealityDeliverabilityRuntime{}, nil
	}
	if dependencies.Pool == nil || dependencies.Registry == nil || dependencies.Connector == nil ||
		dependencies.ObservationStore == nil || dependencies.ObservationStore.ObservationObjects == nil ||
		strings.TrimSpace(dependencies.ConnectorKind) == "" ||
		!dependencies.RawMIMECaptureEnabled ||
		strings.TrimSpace(dependencies.GatewayURL) == "" || strings.TrimSpace(dependencies.BearerToken) == "" ||
		strings.TrimSpace(dependencies.SigningSecrets) == "" || strings.TrimSpace(dependencies.SESRegion) == "" {
		return inboxRealityDeliverabilityRuntime{}, errors.New("enabled Inbox Reality execution requires postgres, controlled seeds, enabled raw MIME capture, gateway auth, signing secrets, and SES region")
	}
	if active := countActiveSeedlist(dependencies.Registry); active == 0 {
		return inboxRealityDeliverabilityRuntime{}, errors.New("enabled Inbox Reality execution requires at least one active controlled seed")
	}
	capabilities := seedlist.CapabilitiesOf(dependencies.Connector)
	if capabilities.Placement != seedlist.CapabilityAvailable ||
		capabilities.Headers != seedlist.CapabilityAvailable ||
		capabilities.RawMIME != seedlist.CapabilityAvailable ||
		capabilities.BodyParts != seedlist.CapabilityAvailable {
		return inboxRealityDeliverabilityRuntime{}, errors.New("enabled Inbox Reality execution requires placement, headers, raw MIME, and body-part connector capabilities")
	}
	if err := verifyInboxRealityDeliverabilitySchema(ctx, dependencies.Pool); err != nil {
		return inboxRealityDeliverabilityRuntime{}, err
	}
	primarySecret, err := internalsign.PrimarySecret(dependencies.SigningSecrets)
	if err != nil {
		return inboxRealityDeliverabilityRuntime{}, err
	}
	callback := &inboxreality.ObservationCallbackClient{
		GatewayBaseURL: dependencies.GatewayURL, BearerToken: dependencies.BearerToken,
		SigningSecret: primarySecret,
	}
	if err := callback.Validate(); err != nil {
		return inboxRealityDeliverabilityRuntime{}, err
	}
	loadAWS := dependencies.LoadAWSConfig
	if loadAWS == nil {
		loadAWS = func(ctx context.Context, region string) (aws.Config, error) {
			return awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
		}
	}
	loadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	awsConfig, err := loadAWS(loadCtx, strings.TrimSpace(dependencies.SESRegion))
	if err != nil {
		return inboxRealityDeliverabilityRuntime{}, fmt.Errorf("Inbox Reality SES configuration: %w", err)
	}
	dispatcher := &inboxreality.Dispatcher{
		Seeds: inboxreality.RegistrySource{
			Registry: dependencies.Registry, Connector: dependencies.Connector,
			ConnectorKind: dependencies.ConnectorKind,
		},
		Store:  inboxreality.NewPostgresExecutionStore(dependencies.Pool),
		Sender: inboxreality.NewSESRawSeedSender(awsConfig, dependencies.SESConfigurationSet),
	}
	dependencies.ObservationStore.ObservationNotifier = callback
	return inboxRealityDeliverabilityRuntime{
		Handler: &inboxreality.Handler{
			Dispatcher: dispatcher, SigningSecrets: dependencies.SigningSecrets,
			// The same registry the dispatcher sends through, so the catalog the
			// gateway advertises and the mailboxes we actually deliver to can
			// never be two different lists.
			Seeds: dependencies.Registry,
		},
		enabled: true,
	}, nil
}

func verifyInboxRealityDeliverabilitySchema(ctx context.Context, pool *pgxpool.Pool) error {
	readinessCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var ready bool
	err := pool.QueryRow(readinessCtx, `
SELECT
    to_regclass('public.inbox_reality_dispatch_commands') IS NOT NULL
    AND to_regclass('public.inbox_reality_seed_dispatches') IS NOT NULL
    AND to_regclass('public.seed_message_observations') IS NOT NULL
    AND has_table_privilege(current_user, 'inbox_reality_dispatch_commands', 'SELECT,UPDATE')
    AND has_table_privilege(current_user, 'inbox_reality_seed_dispatches', 'SELECT,INSERT,UPDATE')
    AND EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='inbox_reality_seed_dispatches'
           AND policyname='inbox_reality_seed_dispatches_worker_update'
    )
    AND EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid='inbox_reality_seed_dispatches'::regclass
           AND tgname='inbox_reality_seed_dispatch_guard' AND NOT tgisinternal
    )`).Scan(&ready)
	if err != nil {
		return fmt.Errorf("Inbox Reality deliverability schema readiness: %w", err)
	}
	if !ready {
		return errors.New("Inbox Reality deliverability schema, privileges, or execution guards are unavailable")
	}
	return nil
}
