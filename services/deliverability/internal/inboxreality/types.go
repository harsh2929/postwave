// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

var (
	ErrInvalidRequest        = errors.New("deliverability Inbox Reality: invalid request")
	ErrCommandConflict       = errors.New("deliverability Inbox Reality: command identity conflict")
	ErrCapabilityUnavailable = errors.New("deliverability Inbox Reality: required capability unavailable")
	ErrNoActiveSeeds         = errors.New("deliverability Inbox Reality: no active controlled seeds")
	ErrExecutionLeaseLost    = errors.New("deliverability Inbox Reality: seed execution lease lost")
)

type Seed struct {
	MailboxID         string
	Provider          string
	Address           string
	RegistryVersionID string
}

type SeedSource interface {
	ActiveSeeds(ctx context.Context) ([]Seed, error)
	CapabilitySnapshot(ctx context.Context) (inboxrealitycontract.CapabilitySnapshot, error)
}

type SendRequest struct {
	TenantID   string
	TestID     string
	ArtifactID string
	ScenarioID string
	MailboxID  string
	Provider   string
	EnvelopeTo string
	RawMIME    []byte
	MIMEHash   string
}

type SendReceipt struct {
	ProviderMessageID string
}

type RawSeedSender interface {
	SendRaw(ctx context.Context, request SendRequest) (SendReceipt, error)
}

type FailureDisposition string

const (
	FailureRetryableDefinitelyNotSent FailureDisposition = "retryable_definitely_not_sent"
	FailurePermanentDefinitelyNotSent FailureDisposition = "permanent_definitely_not_sent"
	FailureIndeterminate              FailureDisposition = "indeterminate"
)

type SendError struct {
	Disposition FailureDisposition
	Code        string
	Err         error
}

func (e *SendError) Error() string {
	if e == nil || e.Err == nil {
		return "seed send failed"
	}
	return e.Err.Error()
}

func (e *SendError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type SeedDelivery struct {
	ID                  string
	TenantID            string
	TestID              string
	CommandID           string
	MailboxID           string
	Provider            string
	RegistryVersionID   string
	CapabilitySnapshot  []byte
	ArtifactMIMEHash    string
	DispatchedMIMEHash  string
	SourceMessageIDHash string
	State               string
	AttemptCount        int
	MaxAttempts         int
	AvailableAt         time.Time
	DispatchToken       string
	DispatchStartedAt   *time.Time
	FailureCode         string
}

type ExecutionStore interface {
	Prepare(ctx context.Context, request inboxrealitycontract.DispatchRequest, seeds []Seed,
		snapshot inboxrealitycontract.CapabilitySnapshot, dispatchedHash string) ([]SeedDelivery, error)
	MarkStaleDispatchesIndeterminate(ctx context.Context, commandID string, before time.Time) error
	ClaimSeed(ctx context.Context, commandID, mailboxID string) (SeedDelivery, error)
	AcceptSeed(ctx context.Context, delivery SeedDelivery, providerMessageID string) error
	RetrySeed(ctx context.Context, delivery SeedDelivery, retryAt time.Time, code string) error
	RejectSeed(ctx context.Context, delivery SeedDelivery, code string) error
	MarkSeedIndeterminate(ctx context.Context, delivery SeedDelivery, code string) error
	ListSeeds(ctx context.Context, commandID string) ([]SeedDelivery, error)
}
