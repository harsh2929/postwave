// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — periodically walks audit_log rows newer than each
// enabled rule's last_audit_id and dispatches matches via the
// rule's configured channel.

package audit_alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// hmacSHA256Hex returns hex(hmacSHA256(secret, body)). Matches the
// signature shape outbound_webhooks uses so consumers' existing
// verifiers work without changes.
func hmacSHA256Hex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Worker is the background matcher.
type Worker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	HTTP     *http.Client
	Interval time.Duration
	// MailSender, when non-nil, is called for channel_kind='email'
	// rules. nil ⇒ email channel falls back to webhook-only behaviour
	// (the operator gets a logged error per fire).
	MailSender MailSender
	// Slack, when non-nil, fans rules with notify_slack=true
	// (migration 0391) out to the tenant's managed Slack integration
	// via the slack.deliver outbox. The dispatcher itself filters on
	// the integration being enabled + subscribed to the
	// "audit.alert.fired" event, so a tenant without Slack configured
	// costs one indexed SELECT per fire. main.go wires
	// slackint.Dispatcher here; nil ⇒ the fan-out is skipped.
	Slack SlackNotifier
}

// MailSender is the narrow surface the worker needs to deliver an
// email-channel fire. Production wires this to the platform mailer;
// tests pass an in-memory fake.
type MailSender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// SlackNotifier is the narrow slackint.Dispatcher surface the worker
// needs. Fire must be called with a tenant-scoped pgx.Tx; it enqueues
// one slack.deliver outbox row per matching integration.
type SlackNotifier interface {
	Fire(ctx context.Context, tx pgx.Tx, tenantID, eventType string, body any) (int, error)
}

// slackAuditEventType is the slackint event key tenants subscribe
// their Slack integration to for audit-alert fan-out.
const slackAuditEventType = "audit.alert.fired"

// Run drives the worker until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("audit_alerts worker: missing deps")
	}
	if w.HTTP == nil {
		// Secure transport: dial-time private-IP block + redirect
		// re-validation. Operator-configured channel URLs
		// (channel_config.url / webhook_url) flow into postJSON
		// below; without the secure dialer, an URL like
		// https://internal-admin.svc.cluster.local/ would be
		// happily POSTed to (audit finding H2/H3, SSRF).
		w.HTTP = outbound_webhooks.NewSecureHTTPClient(nil)
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if w.Logger != nil {
		w.Logger.Info("audit_alerts worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("audit_alerts tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// execWorker runs one best-effort write under a short worker-scope tx. Used
// for the per-rule cursor stamps, which must NOT share one long tx held across
// processRuleInline's external delivery. Errors are swallowed (the cursor
// re-advances next tick), matching the prior autocommit semantics.
func (w *Worker) execWorker(ctx context.Context, sql string, args ...any) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// tick walks enabled rules + dispatches matches.
func (w *Worker) tick(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, action_glob,
       COALESCE(actor_type,''), COALESCE(actor_label_glob,''),
       COALESCE(resource_type,''), channel_kind, channel_config,
       COALESCE(last_audit_id, 0),
       COALESCE(operator_kind,'glob'), COALESCE(operator_config,'{}'::jsonb),
       COALESCE(notify_slack, false)
  FROM audit_alert_rules
 WHERE enabled = true
 ORDER BY id`)
	if err != nil {
		return fmt.Errorf("list rules: %w", err)
	}
	defer rows.Close()
	type ruleRow struct {
		ID, TenantID, Name, ActionGlob          string
		ActorType, ActorLabelGlob, ResourceType string
		ChannelKind                             string
		ChannelConfig                           map[string]any
		LastAuditID                             int64
		OperatorKind                            string
		OperatorConfig                          map[string]any
		NotifySlack                             bool
	}
	rulesToProcess := []ruleRow{}
	for rows.Next() {
		var r ruleRow
		var cfg []byte
		var opCfg []byte
		if err := rows.Scan(&r.ID, &r.TenantID, &r.Name, &r.ActionGlob,
			&r.ActorType, &r.ActorLabelGlob, &r.ResourceType,
			&r.ChannelKind, &cfg, &r.LastAuditID,
			&r.OperatorKind, &opCfg, &r.NotifySlack); err != nil {
			continue
		}
		_ = json.Unmarshal(cfg, &r.ChannelConfig)
		_ = json.Unmarshal(opCfg, &r.OperatorConfig)
		rulesToProcess = append(rulesToProcess, r)
	}
	rows.Close()
	// Release the read tx before processing — processRuleInline does external
	// delivery (HTTP/Slack/email) and the cursor stamps below run in their own
	// short txs (execWorker). Holding this tx across the loop would pin it open
	// across every delivery.
	_ = tx.Rollback(ctx)

	for _, rule := range rulesToProcess {
		newCursor, err := w.processRuleInline(ctx,
			rule.ID, rule.TenantID, rule.Name, rule.ActionGlob,
			rule.ActorType, rule.ActorLabelGlob, rule.ResourceType,
			rule.ChannelKind, rule.ChannelConfig, rule.LastAuditID,
			rule.OperatorKind, rule.OperatorConfig, rule.NotifySlack)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("rule processing failed",
					"rule", rule.ID, "err", err.Error())
			}
			w.execWorker(ctx,
				`UPDATE audit_alert_rules SET last_error = $1 WHERE id = $2::uuid`,
				err.Error(), rule.ID)
			continue
		}
		if newCursor > rule.LastAuditID {
			w.execWorker(ctx,
				`UPDATE audit_alert_rules SET last_audit_id = $1, last_error = NULL
				   WHERE id = $2::uuid`,
				newCursor, rule.ID)
		}
	}
	return nil
}

// processRuleInline scans audit_log rows newer than lastAuditID +
// dispatches matches via the configured channel. The operator gate
// runs *after* matchesRule so threshold_window/rate_deviation/outlier
// operators can short-circuit before any external delivery happens.
func (w *Worker) processRuleInline(ctx context.Context,
	id, tenantID, name, actionGlob, actorType, actorLabelGlob, resourceType,
	channelKind string, channelConfig map[string]any, lastAuditID int64,
	operatorKind string, operatorConfig map[string]any, notifySlack bool,
) (int64, error) {
	// Phase 1 — read up to 200 candidate rows into memory under a short
	// worker-scope read tx. The bound prevents a dormant rule from doing a
	// multi-million-row scan on enable. We materialise + release the read tx
	// BEFORE any external delivery so no tx is held across network I/O.
	type auditRow struct {
		auditID                int64
		action, resType, resID string
		aType, aLabel, atStr   string
		metaJSON               []byte
	}
	var candidates []auditRow
	maxID := lastAuditID
	{
		tx, err := db.WithWorkerScope(ctx, w.Pool)
		if err != nil {
			return lastAuditID, err
		}
		rows, err := tx.Query(ctx, `
SELECT id, action, COALESCE(resource_type,''), COALESCE(resource_id,''),
       COALESCE(actor_type,''), COALESCE(actor_label,''),
       at::text, COALESCE(metadata,'{}'::jsonb)
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id > $2
 ORDER BY id ASC
 LIMIT 200`, tenantID, lastAuditID)
		if err != nil {
			_ = tx.Rollback(ctx)
			return lastAuditID, err
		}
		for rows.Next() {
			var r auditRow
			if err := rows.Scan(&r.auditID, &r.action, &r.resType, &r.resID,
				&r.aType, &r.aLabel, &r.atStr, &r.metaJSON); err != nil {
				rows.Close()
				_ = tx.Rollback(ctx)
				return maxID, err
			}
			if r.auditID > maxID {
				maxID = r.auditID
			}
			candidates = append(candidates, r)
		}
		rows.Close()
		rErr := rows.Err()
		_ = tx.Rollback(ctx) // read-only — nothing to commit
		if rErr != nil {
			return maxID, rErr
		}
	}

	// Phase 2 — per matched row: operator gate, dispatch (network), then
	// record the fire in its own short tx. No DB tx is held across delivery.
	for _, r := range candidates {
		if !matchesRule(r.action, r.resType, r.aType, r.aLabel,
			actionGlob, resourceType, actorType, actorLabelGlob) {
			continue
		}
		// Operator gate: glob-only rules always pass; the richer
		// operators (threshold_window/rate_deviation/outlier) consult
		// audit_log history before firing.
		rowTS, _ := time.Parse(time.RFC3339Nano, r.atStr)
		if rowTS.IsZero() {
			rowTS = time.Now().UTC()
		}
		decision := evaluateOperator(ctx, w.Pool, tenantID,
			actionGlob, r.aLabel, operatorKind, operatorConfig, rowTS)
		if !decision.Fire {
			continue
		}
		// Dispatch.
		errMsg := ""
		delivered := true
		env := fireEnvelope{
			RuleID:       id,
			RuleName:     name,
			AuditID:      r.auditID,
			TenantID:     tenantID,
			Action:       r.action,
			ActorType:    r.aType,
			ActorLabel:   r.aLabel,
			ResourceType: r.resType,
			ResourceID:   r.resID,
			At:           r.atStr,
			Metadata:     r.metaJSON,
			Reason:       decision.Reason,
		}
		if err := w.dispatch(ctx, channelKind, channelConfig, env); err != nil {
			delivered = false
			errMsg = err.Error()
		}
		// Slack fan-out (migration 0391): independent of the primary
		// channel outcome — a webhook 500 must not silence the SOC's
		// Slack channel (and vice versa: a Slack enqueue failure is
		// logged, not recorded as a delivery failure of the rule).
		if notifySlack && w.Slack != nil {
			if err := w.fireSlack(ctx, tenantID, env); err != nil && w.Logger != nil {
				w.Logger.Warn("audit_alerts: slack fan-out failed",
					"rule", id, "err", err.Error())
			}
		}
		w.recordFire(ctx, id, tenantID, r.auditID, delivered, errMsg)
	}
	return maxID, nil
}

// recordFire persists one fire + bumps the rule counter atomically in a short
// worker-scope tx. Best-effort (errors swallowed — the fire still happened;
// the counter is non-critical), matching the prior autocommit semantics.
func (w *Worker) recordFire(ctx context.Context, ruleID, tenantID string, auditID int64, delivered bool, errMsg string) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_alert_fires (rule_id, tenant_id, audit_id, delivered, delivery_error)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''))`,
		ruleID, tenantID, auditID, delivered, errMsg); err != nil {
		return
	}
	if delivered {
		if _, err := tx.Exec(ctx, `
UPDATE audit_alert_rules
   SET fired_count = fired_count + 1, last_fired_at = now()
 WHERE id = $1::uuid`, ruleID); err != nil {
			return
		}
	}
	_ = tx.Commit(ctx)
}

// fireSlack enqueues the fire envelope onto the tenant's managed
// Slack integration via the slack.deliver outbox. The Dispatcher
// requires a tenant-scoped tx (the outbox append is RLS-bound), so we
// open one per fire — fires are rare (operator-tuned alert rules), so
// the extra tx is negligible. Returns nil when the tenant has no
// enabled integration subscribed to audit.alert.fired (count 0 is the
// dispatcher's "nobody listening" non-error).
func (w *Worker) fireSlack(ctx context.Context, tenantID string, env fireEnvelope) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := w.Slack.Fire(ctx, tx, tenantID, slackAuditEventType, env)
	if err != nil {
		return err
	}
	if n == 0 {
		return nil // nothing enqueued — skip the commit round-trip
	}
	return tx.Commit(ctx)
}

// fireEnvelope is the shape sent to channels.
type fireEnvelope struct {
	RuleID       string          `json:"rule_id"`
	RuleName     string          `json:"rule_name"`
	AuditID      int64           `json:"audit_id"`
	TenantID     string          `json:"tenant_id"`
	Action       string          `json:"action"`
	ActorType    string          `json:"actor_type"`
	ActorLabel   string          `json:"actor_label"`
	ResourceType string          `json:"resource_type"`
	ResourceID   string          `json:"resource_id"`
	At           string          `json:"at"`
	Metadata     json.RawMessage `json:"metadata"`
	Reason       string          `json:"reason,omitempty"`
}

// dispatch sends the envelope to the configured channel.
func (w *Worker) dispatch(ctx context.Context, kind string, config map[string]any, env fireEnvelope) error {
	switch kind {
	case "email":
		if w.MailSender == nil {
			return errors.New("email channel: no mail sender configured")
		}
		to, _ := config["to"].(string)
		subjectPrefix, _ := config["subject_prefix"].(string)
		if subjectPrefix == "" {
			subjectPrefix = "[Moosewave audit alert]"
		}
		subject := fmt.Sprintf("%s %s — %s", subjectPrefix, env.RuleName, env.Action)
		body := fmt.Sprintf(
			"Rule: %s\nAudit event id: %d\nAction: %s\nActor: %s (%s)\nResource: %s/%s\nWhen: %s\nReason: %s\n",
			env.RuleName, env.AuditID, env.Action, env.ActorLabel, env.ActorType,
			env.ResourceType, env.ResourceID, env.At, env.Reason)
		return w.MailSender.Send(ctx, to, subject, body)
	case "slack":
		url, _ := config["webhook_url"].(string)
		text := fmt.Sprintf("*%s* fired on `%s` by `%s` at %s — %s",
			env.RuleName, env.Action, env.ActorLabel, env.At, env.Reason)
		body, _ := json.Marshal(map[string]string{"text": text})
		return postJSON(ctx, w.HTTP, url, body, nil)
	case "webhook":
		url, _ := config["url"].(string)
		body, _ := json.Marshal(env)
		headers := map[string]string{}
		if secret, _ := config["hmac_secret"].(string); secret != "" {
			// HMAC signing — mirror outbound_webhooks' shape so
			// consumers' existing verifiers work.
			headers["X-Postwave-Signature"] = "v1=" + hmacSHA256Hex(secret, body)
		}
		return postJSON(ctx, w.HTTP, url, body, headers)
	case "servicenow":
		extID, url, err := createServiceNowIncident(ctx, w.HTTP, config, env, env.Reason)
		if err != nil {
			return err
		}
		if err := recordOutboundIncident(ctx, w.Pool,
			env.RuleID, env.TenantID, "servicenow", extID, url, env.AuditID); err != nil && w.Logger != nil {
			w.Logger.Warn("record servicenow incident failed", "err", err.Error())
		}
		return nil
	case "jira":
		extID, url, err := createJiraIssue(ctx, w.HTTP, config, env, env.Reason)
		if err != nil {
			return err
		}
		if err := recordOutboundIncident(ctx, w.Pool,
			env.RuleID, env.TenantID, "jira", extID, url, env.AuditID); err != nil && w.Logger != nil {
			w.Logger.Warn("record jira incident failed", "err", err.Error())
		}
		return nil
	case "pagerduty":
		extID, url, err := createPagerDutyIncident(ctx, w.HTTP, config, env, env.Reason)
		if err != nil {
			return err
		}
		if err := recordOutboundIncident(ctx, w.Pool,
			env.RuleID, env.TenantID, "pagerduty", extID, url, env.AuditID); err != nil && w.Logger != nil {
			w.Logger.Warn("record pagerduty incident failed", "err", err.Error())
		}
		return nil
	}
	return fmt.Errorf("unknown channel kind: %s", kind)
}

func postJSON(ctx context.Context, client *http.Client, url string, body []byte, headers map[string]string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("upstream %s", resp.Status)
	}
	return nil
}

// matchesRule applies all specified criteria with AND semantics.
func matchesRule(action, resType, actorType, actorLabel,
	actionGlob, ruleResType, ruleActorType, ruleActorLabelGlob string) bool {
	if !globMatch(actionGlob, action) {
		return false
	}
	if ruleResType != "" && ruleResType != resType {
		return false
	}
	if ruleActorType != "" && ruleActorType != actorType {
		return false
	}
	if ruleActorLabelGlob != "" && !globMatch(ruleActorLabelGlob, actorLabel) {
		return false
	}
	return true
}

// globMatch is the standard tiny shell-glob used elsewhere in the
// codebase (mirrors inbound_email/routes.go semantics for
// consistency).
func globMatch(pattern, candidate string) bool {
	if pattern == "*" || pattern == "" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return strings.EqualFold(pattern, candidate)
	}
	segments := strings.Split(strings.ToLower(pattern), "*")
	cand := strings.ToLower(candidate)
	if !strings.HasPrefix(cand, segments[0]) {
		return false
	}
	rest := cand[len(segments[0]):]
	for i := 1; i < len(segments); i++ {
		seg := segments[i]
		if seg == "" {
			if i == len(segments)-1 {
				return true
			}
			continue
		}
		idx := strings.Index(rest, seg)
		if idx < 0 {
			return false
		}
		rest = rest[idx+len(seg):]
		if i == len(segments)-1 && !strings.HasSuffix(cand, seg) {
			return false
		}
	}
	return true
}
