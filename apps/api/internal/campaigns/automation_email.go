package campaigns

// automation_email.go — delivery for a flow's send_email node.
//
// WHY THIS EXISTS
// ---------------
// services/automation's send_email used to call Listmonk's /api/tx DIRECTLY
// from the engine. That skipped, in one line, every guardrail the campaign path
// enforces:
//
//	suppression lookup · consent · frequency caps · quiet hours ·
//	send windows · the tenant email kill switch
//
// A flow could therefore mail a suppressed address, at 3am, past the frequency
// cap, while the tenant's sending was paused. Meanwhile the equivalent SMS node
// did the right thing — it enqueues an outbox row and lets apps/api re-check
// consent (see sms.AutomationSMSHandler). Email simply never got the same
// treatment.
//
// It also could not send a Moosewave template at all: the engine did
// strconv.Atoi(node.TemplateID), but campaign_templates.id is a uuid, so every
// Moosewave template id failed to parse and the node failed permanently.
//
// This handler is the email twin of sms.AutomationSMSHandler. The engine has no
// provider credentials and cannot see suppression state; apps/api owns both.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"log/slog"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/freq_caps"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

// AutomationEmailOutboxKind is the cross-service outbox kind a
// services/automation send_email node enqueues (runtime.emailKind).
//
// MUST stay equal to services/automation/internal/runtime.emailKind.
const AutomationEmailOutboxKind = "automation.email"

// automationEmailPayload mirrors runtime.EmailSendRequest in
// services/automation. Keep the json tags in sync — this is the wire contract.
type automationEmailPayload struct {
	SubscriberEmail string         `json:"subscriber_email"`
	TemplateID      string         `json:"template_id"`
	Subject         string         `json:"subject,omitempty"`
	Data            map[string]any `json:"data,omitempty"`
	AutomationID    string         `json:"automation_id"`
	NodeID          string         `json:"node_id"`
	RunID           string         `json:"run_id,omitempty"`
}

// AutomationEmailSuppressionChecker reports whether an address is suppressed.
type AutomationEmailSuppressionChecker interface {
	Check(ctx context.Context, tenantID, email string) (bool, error)
}

// AutomationEmailSender delivers the resolved message.
type AutomationEmailSender interface {
	SendTransactional(ctx context.Context, req listmonk.SendTransactionalReq) error
}

// AutomationEmailPauseChecker reports the tenant email kill switch.
type AutomationEmailPauseChecker interface {
	EmailSendingPaused(ctx context.Context, tenantID string) (bool, string, error)
}

// AutomationEmailHandler delivers automation.email outbox rows through the same
// guardrails as any other outbound email.
type AutomationEmailHandler struct {
	Pool             *db.Pool
	Suppression      AutomationEmailSuppressionChecker
	Sender           AutomationEmailSender
	Pause            AutomationEmailPauseChecker
	Logger           *slog.Logger
	Allowance        sendallowance.Gate
	RequireAllowance bool
}

// ErrAutomationEmailDeferred signals a retryable condition (kill switch on, or a
// frequency cap hit). Returning an error lets the outbox's existing exponential
// backoff requeue the message rather than dropping it — the message is delayed,
// never silently lost.
var ErrAutomationEmailDeferred = errors.New("automation email: deferred")

func (h *AutomationEmailHandler) log() *slog.Logger {
	if h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

// Handle implements outbox.HandlerFunc for kind=automation.email.
func (h *AutomationEmailHandler) Handle(ctx context.Context, ev outbox.Event) error {
	return h.deliver(ctx, ev.TenantID, ev.Payload, "automation-outbox:"+ev.ID)
}

// Deliver is the testable core: everything Handle does, minus the outbox
// envelope.
func (h *AutomationEmailHandler) Deliver(ctx context.Context, tenantID string, raw []byte) error {
	return h.deliver(ctx, tenantID, raw, fmt.Sprintf("automation-direct:%x", sha256.Sum256(raw)))
}

func (h *AutomationEmailHandler) deliver(ctx context.Context, tenantID string, raw []byte, allowanceKey string) error {
	ctx = tenantengine.WithTenant(ctx, tenantID)
	var p automationEmailPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		// A malformed payload will never become valid. Fail terminally rather
		// than retrying 10 times into the DLQ.
		return fmt.Errorf("automation email: decode payload: %w", err)
	}
	email := strings.TrimSpace(p.SubscriberEmail)
	if email == "" {
		return fmt.Errorf("automation email: missing subscriber_email")
	}

	// 1. Tenant kill switch. A paused tenant must not have flows quietly
	//    mailing on its behalf.
	if h.Pause != nil {
		paused, reason, err := h.Pause.EmailSendingPaused(ctx, tenantID)
		if err != nil {
			return err
		}
		if paused {
			return fmt.Errorf("%w: email sending paused (%s)", ErrAutomationEmailDeferred, reason)
		}
	}

	// 2. Suppression. The single most important check, and the one the engine
	//    could not perform at all.
	if h.Suppression != nil {
		suppressed, err := h.Suppression.Check(ctx, tenantID, email)
		if err != nil {
			return err
		}
		if suppressed {
			// Terminal, not retryable: a suppressed address stays suppressed.
			// Drop the message and say so.
			h.log().Info("automation email skipped: recipient suppressed",
				"automation", p.AutomationID, "node", p.NodeID, "tenant", tenantID)
			return nil
		}
	}

	// 3. Frequency caps. internal/freq_caps had ZERO send-time callsites — it
	//    was a configurable surface wired to nothing. This is one.
	if h.Pool != nil {
		decision, err := freq_caps.WouldDefer(ctx, h.Pool, tenantID, freq_caps.SendContext{
			SubscriberEmail: email,
			Channel:         "email",
			MessageType:     "automation",
		})
		if err != nil {
			return err
		}
		if decision.Defer {
			return fmt.Errorf("%w: frequency cap %s hit", ErrAutomationEmailDeferred, decision.HitCapID)
		}
	}

	// 4. Resolve the template. The id is opaque: a Moosewave uuid or a numeric
	//    listmonk id.
	req, err := h.resolveTemplate(ctx, tenantID, p)
	if err != nil {
		return err
	}
	if h.Sender == nil {
		return fmt.Errorf("automation email: no sender wired")
	}
	// The allowance identity is also the upstream dedup identity. An outbox
	// retry after an ambiguous response must neither consume a second unit nor
	// create a second provider submission when the edge supports idempotency.
	req.IdempotencyKey = allowanceKey
	if h.Allowance == nil {
		if h.RequireAllowance {
			return fmt.Errorf("%w: %w", ErrAutomationEmailDeferred, sendallowance.ErrUnavailable)
		}
		return h.Sender.SendTransactional(ctx, req)
	}
	reservation, err := h.Allowance.Reserve(ctx, sendallowance.Request{
		TenantID: tenantID, Key: allowanceKey, Source: "automation",
		SourceRef: p.RunID + ":" + p.NodeID, RecipientIDs: []string{email},
	})
	if err != nil {
		return fmt.Errorf("%w: %w", ErrAutomationEmailDeferred, err)
	}
	if err := h.Allowance.Commit(ctx, reservation); err != nil {
		_ = h.Allowance.Release(context.WithoutCancel(ctx), reservation, "commit_failed")
		return fmt.Errorf("%w: %w", ErrAutomationEmailDeferred, err)
	}
	if err := h.Sender.SendTransactional(ctx, req); err != nil {
		if listmonk.DefinitelyRejected(err) {
			_ = h.Allowance.Release(context.WithoutCancel(ctx), reservation, "provider_definitely_rejected")
		}
		return err
	}
	return nil
}

// resolveTemplate turns an opaque template id into a sendable request.
//
// A numeric id is a listmonk template and is passed straight through. Anything
// else is treated as a Moosewave campaign_templates uuid, whose subject/body are
// loaded and sent inline — which is the only way a Moosewave template can be sent
// at all, since listmonk's transactional API keys on an integer id.
func (h *AutomationEmailHandler) resolveTemplate(ctx context.Context, tenantID string, p automationEmailPayload) (listmonk.SendTransactionalReq, error) {
	req := listmonk.SendTransactionalReq{
		SubscriberEmail: p.SubscriberEmail,
		Data:            p.Data,
	}
	tpl := strings.TrimSpace(p.TemplateID)
	if tpl == "" {
		return req, fmt.Errorf("automation email: missing template_id")
	}

	if n, err := strconv.ParseInt(tpl, 10, 64); err == nil {
		req.TemplateID = n
		req.Subject = p.Subject
		return req, nil
	}

	if h.Pool == nil {
		return req, fmt.Errorf("automation email: cannot resolve template %q without a pool", tpl)
	}
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return req, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subject, bodyHTML string
	err = tx.QueryRow(ctx, `
SELECT subject, body_html
  FROM campaign_templates
 WHERE id = $1::uuid
   AND (tenant_id = $2::uuid OR tenant_id IS NULL)`, tpl, tenantID).Scan(&subject, &bodyHTML)
	if errors.Is(err, pgx.ErrNoRows) {
		return req, fmt.Errorf("automation email: template %q not found for tenant", tpl)
	}
	if err != nil {
		return req, err
	}
	if err := tx.Commit(ctx); err != nil {
		return req, err
	}

	if strings.TrimSpace(p.Subject) != "" {
		subject = p.Subject
	}
	req.Subject = subject
	req.Body = bodyHTML
	req.ContentType = "html"
	return req, nil
}
