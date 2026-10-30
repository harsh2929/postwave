package sms

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Worker struct {
	Store         *Store
	Provider      Provider
	PublicBaseURL string
	Logger        *slog.Logger
	Owner         string
	BatchSize     int
	LoopInterval  time.Duration
	MaxAttempts   int
}

func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return nil
	}
	interval := w.LoopInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			w.log().Warn("sms worker tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Worker) RunOnce(ctx context.Context) (err error) {
	// This is the last source-level interlock before any queued row can cross a
	// provider boundary. Do not rely on deployment identity/configuration being
	// absent: a future worker credential must not silently drain historical
	// queues while the durable budget/reconciliation sagas remain release-held.
	if !smsLegacyDispatchReleaseReady || !smsDispatchSagaReleaseReady {
		return nil
	}
	if w == nil || w.Store == nil {
		return nil
	}
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("sms worker panic: %v", rec)
			w.log().Error("sms worker recovered panic", "err", err.Error())
		}
	}()
	if err := w.enqueueDueScheduled(ctx); err != nil {
		w.log().Warn("sms scheduled enqueue failed", "err", err.Error())
	}
	if err := w.enqueueDueScheduledBroadcasts(ctx); err != nil {
		w.log().Warn("sms scheduled broadcast enqueue failed", "err", err.Error())
	}
	if err := w.syncSendingBroadcasts(ctx); err != nil {
		w.log().Warn("sms broadcast progress sync failed", "err", err.Error())
	}
	rows, err := w.Store.ClaimQueuedRecipients(ctx, w.owner(), w.batchSize())
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := w.safeSendOne(ctx, row); err != nil {
			w.log().Warn("sms queue row failed", "id", row.ID, "err", err.Error())
		}
	}
	return nil
}

func (w *Worker) enqueueDueScheduled(ctx context.Context) error {
	due, err := w.Store.FindDueScheduledCampaigns(ctx, 16)
	if err != nil {
		return err
	}
	deps := &Deps{Store: w.Store, Provider: w.Provider, PublicBaseURL: w.PublicBaseURL}
	for _, campaign := range due {
		_, err := w.safeSendScheduledCampaign(ctx, deps, campaign)
		if err != nil {
			w.log().Warn("sms scheduled campaign enqueue failed",
				"tenant_id", campaign.TenantID,
				"campaign_id", campaign.ID,
				"err", err.Error(),
			)
		}
	}
	return nil
}

// enqueueDueScheduledBroadcasts sweeps scheduled sms_broadcasts whose
// scheduled_at has passed. Cross-tenant discovery requires a dedicated DB
// identity and remains held for the ordinary API role. It runs each through the same sendBroadcast path the
// HTTP handler uses: resolve audience → claim (idempotent) → enqueue
// into sms_campaign_recipients for the existing worker/gate drain.
func (w *Worker) enqueueDueScheduledBroadcasts(ctx context.Context) error {
	due, err := w.Store.FindDueScheduledBroadcasts(ctx, 16)
	if err != nil {
		return err
	}
	deps := &Deps{Store: w.Store, Provider: w.Provider, PublicBaseURL: w.PublicBaseURL, Logger: w.Logger}
	for _, ref := range due {
		if _, err := w.safeSendScheduledBroadcast(ctx, deps, ref); err != nil {
			w.log().Warn("sms scheduled broadcast enqueue failed",
				"tenant_id", ref.TenantID,
				"broadcast_id", ref.ID,
				"err", err.Error(),
			)
		}
	}
	return nil
}

func (w *Worker) safeSendScheduledBroadcast(ctx context.Context, deps *Deps, ref broadcastRef) (result BroadcastSendResponse, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("sms scheduled broadcast panic: %v", rec)
		}
	}()
	return deps.sendBroadcast(ctx, ref.TenantID, ref.ID, time.Now())
}

// syncSendingBroadcasts refreshes the denormalised sent/failed/held
// counters for broadcasts currently in 'sending' and finalizes them to
// 'sent' once the recipient queue has drained (no queued/sending rows
// left). This keeps progress fresh even when nobody polls
// GET .../progress.
func (w *Worker) syncSendingBroadcasts(ctx context.Context) error {
	refs, err := w.Store.FindSendingBroadcasts(ctx, 32)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if _, _, err := w.Store.SyncBroadcastProgress(ctx, ref.TenantID, ref.ID); err != nil {
			w.log().Warn("sms broadcast progress sync failed",
				"tenant_id", ref.TenantID,
				"broadcast_id", ref.ID,
				"err", err.Error(),
			)
		}
	}
	return nil
}

func (w *Worker) safeSendScheduledCampaign(ctx context.Context, deps *Deps, campaign Campaign) (result BroadcastResult, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("sms scheduled campaign panic: %v", rec)
		}
	}()
	return deps.sendCampaign(ctx, campaign.TenantID, campaign.ID, BroadcastInput{}, w.Provider)
}

func (w *Worker) safeSendOne(ctx context.Context, row QueuedRecipient) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("sms queue row panic: %v", rec)
			if retryErr := w.retryPanickedRecipient(ctx, row, err); retryErr != nil {
				w.log().Warn("sms queue row panic retry update failed",
					"id", row.ID,
					"err", retryErr.Error(),
				)
			}
		}
	}()
	return w.sendOne(ctx, row)
}

func (w *Worker) retryPanickedRecipient(ctx context.Context, row QueuedRecipient, cause error) (err error) {
	if w == nil || w.Store == nil || row.ID == "" || row.TenantID == "" {
		return nil
	}
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("sms queue row panic retry update panic: %v", rec)
		}
	}()
	retryCtx := context.Background()
	if ctx != nil {
		retryCtx = context.WithoutCancel(ctx)
	}
	return w.Store.RetryQueuedRecipient(retryCtx, row, "worker_panic", cause.Error(), w.maxAttempts())
}

func (w *Worker) sendOne(ctx context.Context, row QueuedRecipient) error {
	sender, err := w.Store.GetSender(ctx, row.TenantID, row.SenderProfileID)
	if err != nil {
		return w.Store.RetryQueuedRecipient(ctx, row, "sender_lookup_failed", err.Error(), w.maxAttempts())
	}
	phone, decision, err := w.Store.Gate(ctx, row.TenantID, sender, row.ListID, row.PhoneE164, row.Body, -1)
	if err != nil {
		return w.Store.BlockQueuedRecipient(ctx, row, "invalid_phone")
	}
	if !decision.Allowed {
		// Quiet hours are a temporal hold, not a permanent block:
		// requeue until the window ends (GAP-LS-145). Everything else
		// stays a hard block.
		if decision.Reason == "quiet_hours" && decision.HoldUntil != nil && decision.HoldUntil.After(time.Now()) {
			return w.Store.RetryQueuedRecipientAt(ctx, row, "quiet_hours", "deferred until the quiet-hours window ends", *decision.HoldUntil)
		}
		observeSMSCampaignRecipients(sender.Provider, "blocked", 1)
		return w.Store.BlockQueuedRecipient(ctx, row, decision.Reason)
	}
	if w.Provider == nil {
		observeSMSProviderSend(sender.Provider, errors.New("provider_unconfigured"), 0)
		return w.Store.RetryQueuedRecipient(ctx, row, "provider_unconfigured", "sms provider is not configured", w.maxAttempts())
	}
	slot, err := w.Store.ReserveSenderSendSlot(ctx, row.TenantID, sender.ID, sender.Provider, carrierSendDelay(sender.Metadata), 2*time.Second)
	if err != nil {
		return w.Store.RetryQueuedRecipient(ctx, row, "throttle_lookup_failed", err.Error(), w.maxAttempts())
	}
	if !slot.SuspendedUntil.IsZero() && slot.SuspendedUntil.After(time.Now()) {
		return w.Store.RetryQueuedRecipientAt(ctx, row, "sender_throttled", "sender is temporarily suspended after provider failures", slot.SuspendedUntil)
	}
	if slot.WaitUntil.After(time.Now()) {
		wait := time.Until(slot.WaitUntil)
		if wait > 2*time.Second {
			return w.Store.RetryQueuedRecipientAt(ctx, row, "sender_rate_limited", "sender send slot is not available yet", slot.WaitUntil)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	result, err := safeProviderSend(ctx, w.Provider, ProviderOutbound{
		Provider:            sender.Provider,
		To:                  phone,
		Body:                row.Body,
		MediaURL:            row.MediaURL,
		FromNumber:          sender.PhoneNumber,
		MessagingServiceSID: sender.MessagingServiceSID,
		StatusCallbackURL:   statusCallbackURL(w.publicBaseURL(), sender.Provider, row.TenantID, sender.ID),
	})
	if err != nil {
		observeSMSProviderSend(sender.Provider, err, result.PriceMicros)
		_ = w.Store.RecordSenderThrottleResult(ctx, row.TenantID, sender.ID, sender.Provider, result.ErrorCode, err.Error(), err)
		if result.RetryAfter > 0 {
			retryAt := time.Now().UTC().Add(result.RetryAfter)
			_ = w.Store.SuspendSenderUntil(ctx, row.TenantID, sender.ID, sender.Provider, retryAt, result.ErrorCode, err.Error())
			return w.Store.RetryQueuedRecipientAt(ctx, row, result.ErrorCode, err.Error(), retryAt)
		}
		return w.Store.RetryQueuedRecipient(ctx, row, result.ErrorCode, err.Error(), w.maxAttempts())
	}
	observeSMSProviderSend(sender.Provider, nil, result.PriceMicros)
	_ = w.Store.RecordSenderThrottleResult(ctx, row.TenantID, sender.ID, sender.Provider, "", "", nil)
	meta := nilMap(row.Metadata)
	meta["queue_id"] = row.ID
	msg, err := w.Store.RecordOutbound(ctx, row.TenantID, SendInput{
		SenderProfileID: row.SenderProfileID,
		ListID:          row.ListID,
		To:              phone,
		Body:            row.Body,
		MediaURL:        row.MediaURL,
		CampaignID:      row.CampaignID,
		Metadata:        meta,
	}, phone, decision, result)
	if err != nil {
		return w.Store.RetryQueuedRecipient(ctx, row, "record_failed", err.Error(), w.maxAttempts())
	}
	if row.LinkTracking {
		_ = w.Store.AttachLinkTokens(ctx, row.TenantID, row.CampaignID, phone, msg.ID)
	}
	if err := w.Store.CompleteQueuedRecipient(ctx, row, msg, result); err != nil {
		return err
	}
	_, _ = w.Store.RefreshCampaignStats(ctx, row.TenantID, row.CampaignID)
	return nil
}

func safeProviderSend(ctx context.Context, provider Provider, msg ProviderOutbound) (result ProviderResult, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			result.Provider = defaulted(result.Provider, msg.Provider)
			result.ErrorCode = "provider_panic"
			result.ErrorMessage = "SMS provider call failed."
			result.Raw = nil
			err = errors.New("sms provider call failed")
		}
	}()
	result, err = provider.Send(ctx, msg)
	result = sanitizeProviderResult(result, msg.Provider)
	if err != nil {
		err = errors.New("sms provider call failed")
	}
	return result, err
}

func sanitizeProviderResult(result ProviderResult, fallbackProvider string) ProviderResult {
	result.Provider = strings.ToLower(strings.TrimSpace(defaulted(result.Provider, fallbackProvider)))
	if !oneOf(result.Provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		result.Provider = strings.ToLower(strings.TrimSpace(fallbackProvider))
	}
	result.MessageID = safeProviderIdentifier(result.MessageID, 256)
	// Preserve the provider's status token for the effect owner to classify.
	// normalizeStatus deliberately defaults unknown values to "queued" for
	// legacy read projections; using it here would turn a malformed/novel 2xx
	// provider response into false dispatch certainty and could commit budget.
	result.Status = strings.ToLower(strings.TrimSpace(result.Status))
	result.ErrorCode = safeInboxProviderCode(result.ErrorCode)
	if result.ErrorCode != "" {
		result.ErrorMessage = "SMS provider request failed (code " + result.ErrorCode + ")."
	} else if result.ErrorMessage != "" {
		result.ErrorMessage = "SMS provider request failed."
	}
	if result.PriceMicros < 0 {
		result.PriceMicros = 0
	}
	if result.RetryAfter < 0 || result.RetryAfter > 24*time.Hour {
		result.RetryAfter = 0
	}
	result.Raw = nil
	return result
}

func safeProviderIdentifier(value string, max int) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > max {
		return ""
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == ':') {
			return ""
		}
	}
	return value
}

func (w *Worker) owner() string {
	if w.Owner != "" {
		return w.Owner
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "api"
	}
	return host
}

func (w *Worker) batchSize() int {
	if w.BatchSize > 0 {
		return w.BatchSize
	}
	return 50
}

func (w *Worker) maxAttempts() int {
	if w.MaxAttempts > 0 {
		return w.MaxAttempts
	}
	return 3
}

func (w *Worker) publicBaseURL() string {
	return normalizePublicBaseURL(defaulted(w.PublicBaseURL, envPublicBaseURL()))
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func statusCallbackURL(base, provider, tenantID, _ string) string {
	base = normalizePublicBaseURL(base)
	if base == "" {
		return ""
	}
	provider = defaulted(strings.ToLower(strings.TrimSpace(provider)), ProviderTwilio)
	if !oneOf(provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		return ""
	}
	return base + "/api/public/sms/" + provider + "/" + tenantID + "/status"
}

func stringsTrimRightSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func carrierSendDelay(metadata map[string]any) time.Duration {
	perSecond := positiveFloatFromMetadata(metadata, "messages_per_second", "mps", "carrier_mps")
	if perSecond <= 0 {
		if sending := mapFromAny(metadata["sending"]); len(sending) > 0 {
			perSecond = positiveFloatFromMetadata(sending, "messages_per_second", "mps", "carrier_mps")
		}
	}
	if perSecond <= 0 {
		return 0
	}
	if perSecond > 100 {
		perSecond = 100
	}
	return time.Duration(float64(time.Second) / perSecond)
}

func providerBackoffDelay(code, message string, consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 0 {
		consecutiveFailures = 1
	}
	text := strings.ToLower(strings.TrimSpace(code + " " + message))
	switch {
	case text == "":
		return 0
	case strings.Contains(text, "invalid_phone"),
		strings.Contains(text, "invalid number"),
		strings.Contains(text, "not a mobile"),
		strings.Contains(text, "21614"),
		strings.Contains(text, "recipient_suppressed"),
		strings.Contains(text, "recipient_not_opted_in"):
		return 0
	case strings.Contains(text, "429"),
		strings.Contains(text, "20429"),
		strings.Contains(text, "rate"),
		strings.Contains(text, "throttle"),
		strings.Contains(text, "too many requests"):
		return cappedBackoff(time.Duration(consecutiveFailures)*time.Minute, 15*time.Minute)
	case strings.Contains(text, "30001"),
		strings.Contains(text, "30002"),
		strings.Contains(text, "30003"),
		strings.Contains(text, "30004"),
		strings.Contains(text, "30005"),
		strings.Contains(text, "30006"),
		strings.Contains(text, "30007"),
		strings.Contains(text, "30008"),
		strings.Contains(text, "carrier"),
		strings.Contains(text, "filter"):
		return cappedBackoff(time.Duration(consecutiveFailures)*30*time.Second, 10*time.Minute)
	case consecutiveFailures >= 3:
		return cappedBackoff(time.Duration(consecutiveFailures)*30*time.Second, 5*time.Minute)
	default:
		return 0
	}
}

func cappedBackoff(delay, cap time.Duration) time.Duration {
	if delay <= 0 {
		return 0
	}
	if delay > cap {
		return cap
	}
	return delay
}

func positiveFloatFromMetadata(metadata map[string]any, keys ...string) float64 {
	for _, key := range keys {
		raw := strings.TrimSpace(stringFromAny(metadata[key]))
		if raw == "" {
			continue
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err == nil && value > 0 {
			return value
		}
	}
	return 0
}
