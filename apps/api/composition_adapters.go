package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/audit"
	apiboot "github.com/postwave/postwave/apps/api/internal/boot"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/demographics"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/nbp"
	"github.com/postwave/postwave/apps/api/internal/offers"
	"github.com/postwave/postwave/apps/api/internal/onsite_growth"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/preferences"
	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	"github.com/postwave/postwave/apps/api/internal/segments"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/slackint"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/trigger_replayer"
	"github.com/postwave/postwave/apps/api/internal/uploads"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
	"github.com/postwave/postwave/apps/api/internal/zerocopy_triggers"

	// X1+X2+X3 internal packages — net-new since 2026-05-03 fork point.
	"github.com/postwave/postwave/apps/api/internal/archive"
	"github.com/postwave/postwave/apps/api/internal/archive_comments"
	"github.com/postwave/postwave/apps/api/internal/discounts"
	"github.com/postwave/postwave/apps/api/internal/email_blocks"
	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/tags"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// smtpKeyVerifier adapts the API-key auth chain to the SMTP relay's Verifier
// seam: the SMTP password is the plaintext API key; it must be valid,
// unrevoked, and carry send:transactional (or admin).
type smtpKeyVerifier struct {
	resolver *apikeys.Repo
	cache    *apikeys.AuthCache
}

func (v smtpKeyVerifier) Verify(ctx context.Context, plaintext string) (string, bool) {
	plaintext = strings.TrimSpace(plaintext)
	if plaintext == "" {
		return "", false
	}
	key, tenant, err := v.cache.ResolveAuth(ctx, v.resolver.HashKey(plaintext))
	if err != nil || key == nil || tenant == nil || key.RevokedAt != nil {
		return "", false
	}
	for _, s := range key.Scopes {
		if s == apikeys.ScopeSendTransactional || s == apikeys.ScopeAdmin {
			return tenant.ID, true
		}
	}
	return "", false
}

// txSuppressionChecker adapts the suppressions converger to the transactional
// send-core's SuppressionChecker seam (is this address suppressed for
// transactional email?).
type txSuppressionChecker struct {
	conv *suppressions.SuppressionConverger
}

func (c txSuppressionChecker) IsSuppressed(ctx context.Context, tenantID, email string) (bool, error) {
	if c.conv == nil {
		return false, nil
	}
	suppressed, _, err := c.conv.Check(ctx, tenantID, email, suppressions.ChannelEmail, suppressions.ScopeTransactional)
	return suppressed, err
}

// convergerCampaignLookup adapts the suppressions converger to the
// campaigns SuppressionLookup seam (map[string]bool, lowercase-keyed),
// so campaign queue-fill + send-preview see rows from all three
// suppression tables via v_suppressions_unified. Marketing scope +
// email channel match the campaign send path (P0 D05#1/#2).
type convergerCampaignLookup struct {
	conv *suppressions.SuppressionConverger
}

func (c convergerCampaignLookup) LookupBulk(ctx context.Context, tenantID string, emails []string) (map[string]bool, error) {
	out := make(map[string]bool, len(emails))
	if c.conv == nil {
		return out, nil
	}
	hits, err := c.conv.LookupBulk(ctx, tenantID, emails, suppressions.ChannelEmail, suppressions.ScopeMarketing)
	if err != nil {
		return nil, err
	}
	for email := range hits {
		out[strings.ToLower(strings.TrimSpace(email))] = true
	}
	return out, nil
}

// zeroCopyConnectionLookup adapts the warehouse Repo to the zerocopy driver's
// ConnectionLookup seam (resolve a trigger's connection_id to provider +
// credentials_ref + config, tenant-scoped).
type zeroCopyConnectionLookup struct {
	repo *warehouse.Repo
}

func (l zeroCopyConnectionLookup) LookupConnection(ctx context.Context, tenantID, connectionID string) (zerocopy_triggers.ConnInfo, error) {
	if l.repo == nil {
		return zerocopy_triggers.ConnInfo{}, errors.New("zero-copy connection lookup: nil warehouse repo")
	}
	c, err := l.repo.GetConnection(ctx, tenantID, connectionID)
	if err != nil {
		return zerocopy_triggers.ConnInfo{}, err
	}
	if err := zeroCopyConnectionAvailable(c); err != nil {
		return zerocopy_triggers.ConnInfo{}, err
	}
	return zerocopy_triggers.ConnInfo{
		Provider:       c.Provider,
		Direction:      c.Direction,
		Status:         c.Status,
		CredentialsRef: c.CredentialsRef,
		Config:         c.Config,
	}, nil
}

func zeroCopyConnectionAvailable(c *warehouse.Connection) error {
	if c == nil {
		return warehouse.ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(c.Status), "disconnected") {
		return warehouse.ErrDisconnected
	}
	if !strings.EqualFold(strings.TrimSpace(c.Status), "active") {
		return fmt.Errorf("warehouse connection must be active (current status %q)", c.Status)
	}
	direction := strings.ToLower(strings.TrimSpace(c.Direction))
	if direction != "import" && direction != "bidirectional" {
		return fmt.Errorf("warehouse connection direction must be import or bidirectional")
	}
	return nil
}

type zeroCopyFlowEnqueuer struct {
	repo *flowbuilder.Repo
}

func (e zeroCopyFlowEnqueuer) EnqueueRun(ctx context.Context, tenantID string, req zerocopy_triggers.EnqueueRequest) (string, error) {
	if e.repo == nil {
		return "", errors.New("zero-copy flow enqueuer: nil flow repo")
	}
	rec, err := e.repo.EnqueueRun(ctx, tenantID, flowbuilder.RunEnqueueRequest{
		FlowID:           req.FlowID,
		SubscriberID:     req.SubscriberID,
		TriggerEventName: req.TriggerEventName,
		ScheduledAt:      req.ScheduledAt,
	})
	if err != nil {
		return "", err
	}
	return rec.ID, nil
}

type campaignRetryQueueAdapter struct {
	Queue *intelligent_retry.Queue
}

func (a campaignRetryQueueAdapter) EnqueueFrequencySkippedTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, emails []string, breakdown []campaigns.FrequencySkipBreakdown, retryAfter time.Time) error {
	if a.Queue == nil {
		return errors.New("campaign retry queue adapter: intelligent-retry queue is not configured")
	}
	out := make([]intelligent_retry.Breakdown, 0, len(breakdown))
	for _, b := range breakdown {
		out = append(out, intelligent_retry.Breakdown{
			RuleID:    b.RuleID,
			RuleLabel: b.RuleLabel,
			Skipped:   b.Skipped,
		})
	}
	return a.Queue.EnqueueFrequencySkippedTx(ctx, tx, tenantID, campaignID, emails, out, retryAfter)
}

// demographicsAdapter maps the demographics.Predictor concrete output
// (demographics.Prediction) onto the package-local
// subscribers.PredictedDemographics so the subscribers package stays
// import-free of the demographics package (SUB-063, mirrors the
// geolocation.DriftAdapter pattern used by SUB-055).
type demographicsAdapter struct {
	predictor demographics.Predictor
}

func (a demographicsAdapter) PredictDemographics(firstName, fullName string) (subscribers.PredictedDemographics, bool) {
	if a.predictor == nil {
		return subscribers.PredictedDemographics{}, false
	}
	pred := a.predictor.Predict(demographics.Input{FirstName: firstName, FullName: fullName})
	if !pred.HasAny() {
		return subscribers.PredictedDemographics{}, false
	}
	return subscribers.PredictedDemographics{
		Gender:              string(pred.Gender),
		GenderConfidence:    pred.GenderConfidence,
		AgeGroup:            pred.AgeGroup,
		AgeGroupConfidence:  pred.AgeGroupConfidence,
		Interests:           pred.Interests,
		InterestsConfidence: pred.InterestsConfidence,
	}, true
}

type subscriberEventFanoutAdapter struct {
	Track         *track.Repo
	FlowRuns      flowbuilder.RunEnqueuer
	DelayResolver track.DelayResolver
	Logger        *slog.Logger
}

func (a subscriberEventFanoutAdapter) RecordSubscriberEvent(ctx context.Context, ev listmonk_events.SubscriberEventRecord) error {
	if a.Track == nil || strings.TrimSpace(ev.TenantID) == "" || strings.TrimSpace(ev.EventName) == "" {
		return nil
	}
	sub, err := a.Track.ResolveSubscriberIdentity(ctx, ev.TenantID, "", ev.SubscriberEmail)
	if err != nil {
		if errors.Is(err, track.ErrNotFound) {
			return nil
		}
		return err
	}
	props := map[string]any{}
	for k, v := range ev.Properties {
		props[k] = v
	}
	if ev.CampaignID != "" {
		props["campaign_id"] = ev.CampaignID
	}
	if ev.MessageID != "" {
		props["message_id"] = ev.MessageID
	}
	raw, _ := json.Marshal(props)
	at := ev.At.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	eventID, err := a.Track.Insert(ctx, ev.TenantID, sub.ID, ev.EventName, raw, at, "")
	if err != nil {
		return err
	}
	if a.FlowRuns == nil {
		return nil
	}
	matches, err := a.FlowRuns.MatchFlowsForEvent(ctx, ev.TenantID, ev.EventName)
	if err != nil {
		if errors.Is(err, flowbuilder.ErrFlowRuntimeUnavailable) {
			if a.Logger != nil {
				a.Logger.Info("subscriber event automation fanout contained",
					"tenant", ev.TenantID, "event", ev.EventName,
					"runtime_status", "unavailable")
			}
			return nil
		}
		return err
	}
	for _, m := range matches {
		eventCopy := eventID
		req := flowbuilder.RunEnqueueRequest{
			FlowID:           m.FlowID,
			SubscriberID:     sub.ID,
			TriggerEventID:   &eventCopy,
			TriggerEventName: ev.EventName,
			ScheduledAt:      at,
		}
		if strings.EqualFold(m.DelayStrategy, "optimized") && a.DelayResolver != nil {
			delay, ok, delayErr := a.DelayResolver.ResolveDelay(ctx, ev.TenantID, sub.ID, ev.EventName)
			if delayErr != nil {
				if a.Logger != nil {
					a.Logger.Warn("subscriber event delay lookup failed", "tenant", ev.TenantID, "event", ev.EventName, "err", delayErr.Error())
				}
			} else if ok && delay > 0 {
				req.ScheduledAt = at.Add(delay)
			}
		}
		if _, err := a.FlowRuns.EnqueueRun(ctx, ev.TenantID, req); err != nil && a.Logger != nil {
			a.Logger.Warn("subscriber event flow enqueue failed", "tenant", ev.TenantID, "flow", m.FlowID, "event", ev.EventName, "err", err.Error())
		}
	}
	return nil
}

func runNBPBuilder(ctx context.Context, logger *slog.Logger, builder *nbp.Builder) {
	if builder == nil {
		return
	}
	run := func() {
		if err := builder.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("nbp builder failed", "err", err.Error())
		}
	}
	run()
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func archiveCampaignResolver(repo *archive.Repo) archive_comments.CampaignResolver {
	return func(ctx context.Context, tenantID, campaignSlug string) (string, error) {
		if repo == nil {
			return "", archive_comments.ErrNotFound
		}
		issue, err := repo.GetIssue(ctx, tenantID, campaignSlug)
		if err != nil {
			return "", err
		}
		if issue.CampaignID == "" {
			return "", archive_comments.ErrNotFound
		}
		return issue.CampaignID, nil
	}
}

func archiveCommentSubscriberResolver(pool *db.Pool, prefRepo *preferences.Repo) archive_comments.SubscriberResolver {
	return func(ctx context.Context, r *http.Request) (string, string, error) {
		token := archiveSubscriberTokenFromRequest(r)
		if token == "" || pool == nil || prefRepo == nil {
			return "", "", archive_comments.ErrNoSubscriber
		}
		pt, err := prefRepo.LookupToken(ctx, token)
		if err != nil {
			if errors.Is(err, preferences.ErrNotFound) || errors.Is(err, preferences.ErrTokenExpired) {
				return "", "", archive_comments.ErrNoSubscriber
			}
			return "", "", err
		}
		tx, err := db.WithTenant(ctx, pool, pt.TenantID)
		if err != nil {
			return "", "", err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var id, displayName string
		err = tx.QueryRow(ctx, `
SELECT id::text,
       COALESCE(NULLIF(custom_fields->>'first_name', ''), split_part(email::text, '@', 1))
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
 LIMIT 1`, pt.TenantID, pt.SubscriberEmail).Scan(&id, &displayName)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", archive_comments.ErrNoSubscriber
		}
		if err != nil {
			return "", "", err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", "", err
		}
		return id, displayName, nil
	}
}

func archiveSubscriberTokenFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	for _, key := range []string{"token", "subscriber_token", "preference_token"} {
		if v := strings.TrimSpace(r.URL.Query().Get(key)); v != "" {
			return v
		}
	}
	if v := strings.TrimSpace(r.Header.Get("X-Postwave-Subscriber-Token")); v != "" {
		return v
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[len("bearer "):])
	}
	for _, cookieName := range []string{"postwave_preference_token", "pw_preference_token", "pw_archive_token"} {
		c, err := r.Cookie(cookieName)
		if err == nil && strings.TrimSpace(c.Value) != "" {
			return strings.TrimSpace(c.Value)
		}
	}
	return ""
}

// s3FormsAdapter bridges the broader uploads.Store surface down to the
// narrow forms.UploadStore (Presign-only) interface forms.Uploads
// consumes. The forms code still hands the browser a PUT URL; here it
// becomes a presigned PUT against the configured S3 bucket. It deliberately
// does not mint a GET URL: public objects remain read-inaccessible until the
// asynchronous verification and malware scan return clean.
//
// Tenant scoping note: every form key includes the tenant, form and upload IDs
// below a quarantine prefix. The broader S3 store adds its own fixed `_forms`
// namespace, yielding a private, non-colliding object key.
type s3FormsAdapter struct {
	store *uploads.S3UploadStore
}

// PresignPutHeaders exposes every non-browser-managed header included in the
// S3 PUT signature. The public form uploader must replay these values exactly;
// the bucket policy rejects missing encryption headers and SigV4 rejects a
// mismatched Content-Type.
func (a *s3FormsAdapter) PresignPutHeaders(mime string) map[string]string {
	headers := map[string]string{
		"Content-Type":                 mime,
		"x-amz-server-side-encryption": "aws:kms",
	}
	if a != nil && a.store != nil && strings.TrimSpace(a.store.SSEKMSKeyID) != "" {
		headers["x-amz-server-side-encryption-aws-kms-key-id"] = a.store.SSEKMSKeyID
	}
	return headers
}

func (a *s3FormsAdapter) Presign(ctx context.Context, key, mime string, size int64, ttl time.Duration) (putURL, getURL string, err error) {
	if a == nil || a.store == nil {
		return "", "", fmt.Errorf("forms presign: s3 store not initialised")
	}
	// We rebuild a per-call store with the form key under a synthetic
	// `tenants/_forms` prefix; the key itself carries tenant isolation.
	const formsTenant = "_forms"
	put, perr := presignPutObject(ctx, a.store.Bucket, a.store.SSEKMSKeyID, formsTenant, key, mime, size, ttl)
	if perr != nil {
		return "", "", perr
	}
	return put, "", nil
}

func (a *s3FormsAdapter) Delete(ctx context.Context, key string) error {
	if a == nil || a.store == nil {
		return fmt.Errorf("forms delete: s3 store not initialised")
	}
	return a.store.Delete(ctx, "_forms", key)
}

func (a *s3FormsAdapter) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if a == nil || a.store == nil {
		return nil, fmt.Errorf("forms open: s3 store not initialised")
	}
	body, _, err := a.store.Get(ctx, "_forms", key)
	return body, err
}

// presignPutObject is a small helper to mint a presigned PUT URL with
// SSE-KMS forced on. We don't expose this as a method on uploads.Store
// because PUT presigning is a forms-only flow today (other callers
// stream bodies through Put). Inlined here so the wire-in stays in one
// section.
func presignPutObject(ctx context.Context, bucket, kmsKeyID, tenant, rest, mime string, size int64, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		ttl = uploads.DefaultPresignTTL
	}
	key := "tenants/" + tenant + "/" + strings.TrimLeft(rest, "/")
	in := &s3.PutObjectInput{
		Bucket:               aws.String(bucket),
		ContentLength:        aws.Int64(size),
		Key:                  aws.String(key),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
	}
	if mime != "" {
		in.ContentType = aws.String(mime)
	}
	if kmsKeyID != "" {
		in.SSEKMSKeyId = aws.String(kmsKeyID)
	}
	// We need an *s3.Client to presign. We keep one in the adapter via
	// a package-level cached factory; constructed lazily because main.go
	// has already wired awsCfg by the time forms presign fires.
	pc := getFormsPresignClient()
	if pc == nil {
		return "", fmt.Errorf("forms presign: s3 client not initialised")
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	signed, err := pc.PresignPutObject(timeoutCtx, in, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", fmt.Errorf("forms presign put: %w", err)
	}
	return signed.URL, nil
}

// formsPresignClient is set when the S3 upload-store path is wired in
// run(). It's a package-level slot so presignPutObject doesn't have to
// thread the client through s3FormsAdapter.
var formsPresignClient *s3.PresignClient

func getFormsPresignClient() *s3.PresignClient { return formsPresignClient }

func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func hasWildcardOrigin(origins []string) bool {
	for _, origin := range origins {
		if strings.TrimSpace(origin) == "*" {
			return true
		}
	}
	return false
}

// jsonError returns an http.HandlerFunc that emits the canonical
// {"error":{"code","message"}} envelope with the given status. Used as
// chi's NotFound + MethodNotAllowed handlers so framework-level
// responses match the application-level error contract.
func jsonError(status int, code, message string) http.HandlerFunc {
	body := []byte(fmt.Sprintf(
		`{"error":{"code":%q,"message":%q}}`,
		code, message,
	))
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}
}

// jsonRecoverer turns panics into the same JSON error envelope used by
// application handlers. chi's default Recoverer writes text/plain and can
// include implementation details; API clients need a stable shape instead.
func jsonRecoverer(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := chimiddleware.NewWrapResponseWriter(w, r.ProtoMajor)
			defer func() {
				if rec := recover(); rec != nil {
					// net/http reserves ErrAbortHandler for handlers that must
					// terminate the connection/stream without producing a normal
					// response. Swallowing it here would turn a truncated streaming
					// export into a plausible successful response.
					if rec == http.ErrAbortHandler {
						panic(rec)
					}
					requestID := chimiddleware.GetReqID(r.Context())
					logger.Error("panic recovered",
						"panic", fmt.Sprint(rec),
						"method", r.Method,
						"path", r.URL.Path,
						"request_id", requestID,
						"stack", string(debug.Stack()))

					if ww.Status() != 0 {
						return
					}
					ww.Header().Set("Content-Type", "application/json; charset=utf-8")
					ww.Header().Set("X-Content-Type-Options", "nosniff")
					if requestID != "" {
						ww.Header().Set("X-Request-Id", requestID)
					}
					ww.WriteHeader(http.StatusInternalServerError)
					_ = json.NewEncoder(ww).Encode(map[string]any{
						"error": map[string]any{
							"code":       "internal_server_error",
							"message":    "Internal server error.",
							"request_id": requestID,
						},
					})
				}
			}()
			next.ServeHTTP(ww, r)
		})
	}
}

// rejectControlBytesInPath rejects any request whose URL path or raw
// query contains a NUL byte or other ASCII control char (0x00-0x1F
// except tab/newline/CR which won't appear in a URL anyway, and 0x7F).
// Without this, garbage like `/api/public/forms/%00null%00` reaches a
// SQL query parameter, the Postgres driver returns SQLSTATE 22021, and
// the handler emits a 500 with the raw error in the body — which is
// information disclosure to anonymous public callers.
func rejectControlBytesInPath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hasControlByte(r.URL.Path) || hasControlByte(r.URL.RawQuery) {
			jsonError(http.StatusBadRequest, "invalid_request",
				"URL contains control bytes which are not permitted.").ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hasControlByte(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c == 0x7F {
			return true
		}
	}
	return false
}

// verifyEnvelopeCipher preserves the package-main seam while the boot package
// owns the readiness contract used by AWS startup.
func verifyEnvelopeCipher(ctx context.Context, cipher sending.EnvelopeEncryptor) error {
	return apiboot.VerifyEnvelopeCipher(ctx, cipher)
}

// isProductionEnv delegates to ops.IsProductionEnv so the boot checks and
// the ops push canary share one production detector — they once diverged
// (the canary matched only POSTWAVE_ENV=production), which let a
// production deployment with zero push channels present as a quiet WARN.
func isProductionEnv() bool {
	return ops.IsProductionEnv()
}

func validateProductionUploadStoreConfig(bucket, region, s3KMSKeyID string) error {
	return apiboot.ValidateProductionUploadStoreConfig(bucket, region, s3KMSKeyID, isProductionEnv())
}

func validateProductionFormUploadScannerConfig(address string) error {
	if !isProductionEnv() {
		return nil
	}
	if strings.TrimSpace(address) == "" {
		return errors.New("POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR is required in production; public form uploads must remain quarantined unless a malware scanner is reachable")
	}
	return nil
}

// sentryEnvironment resolves the environment label that Sentry tags every
// event with. Picks the first non-empty of POSTWAVE_ENV / ENVIRONMENT /
// NODE_ENV, falling back to "development" so local runs without a DSN
// stay readable in case a DSN gets set without an env marker.
func sentryEnvironment() string {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return "development"
}

// newFormsOutboxAdapter wraps *outbox.Repo so it satisfies the narrow
// forms.OutboxAppender interface. Keeps forms package import-free of
// outbox at the type level so the dep direction stays clean.
func newFormsOutboxAdapter(repo *outbox.Repo) forms.OutboxAppender {
	return formsOutboxAdapter{repo: repo}
}

type formsOutboxAdapter struct{ repo *outbox.Repo }

func (a formsOutboxAdapter) Append(ctx context.Context, tx pgx.Tx, in forms.OutboxAppendInput) (string, error) {
	return a.repo.Append(ctx, tx, outbox.Append{
		TenantID:    in.TenantID,
		Kind:        in.Kind,
		Payload:     in.Payload,
		MaxAttempts: in.MaxAttempts,
	})
}

// newSubscribersEngineSyncOutboxAdapter wires canonical subscriber writes to
// the shared transactional outbox without making the subscribers repository
// depend on outbox's concrete persistence type.
func newSubscribersEngineSyncOutboxAdapter(repo *outbox.Repo) subscribers.EngineSyncOutboxAppender {
	return subscribersEngineSyncOutboxAdapter{repo: repo}
}

type subscribersEngineSyncOutboxAdapter struct{ repo *outbox.Repo }

func (a subscribersEngineSyncOutboxAdapter) Append(
	ctx context.Context,
	tx pgx.Tx,
	in subscribers.EngineSyncOutboxAppendInput,
) (string, error) {
	return a.repo.Append(ctx, tx, outbox.Append{
		TenantID:    in.TenantID,
		Kind:        in.Kind,
		Payload:     in.Payload,
		MaxAttempts: in.MaxAttempts,
	})
}

func (a subscribersEngineSyncOutboxAdapter) AppendMany(
	ctx context.Context,
	tx pgx.Tx,
	inputs []subscribers.EngineSyncOutboxAppendInput,
) error {
	batch := make([]outbox.Append, 0, len(inputs))
	for _, in := range inputs {
		batch = append(batch, outbox.Append{
			TenantID:    in.TenantID,
			Kind:        in.Kind,
			Payload:     in.Payload,
			MaxAttempts: in.MaxAttempts,
		})
	}
	return a.repo.AppendMany(ctx, tx, batch)
}

// newWarmupGate adapts sending.WarmupTracker to the campaigns.WarmupGate
// contract. We compute today's cap from the tracker's WarmupState +
// CapForDay; nil state (warmup not started or tier not enrolled) means
// "no cap" — surfaced as -1.
func newWarmupGate(tracker sending.WarmupTracker) campaigns.WarmupGate {
	return warmupGate{tracker: tracker}
}

type warmupGate struct{ tracker sending.WarmupTracker }

func (g warmupGate) CapForToday(ctx context.Context, tenantID string) (int, error) {
	if g.tracker == nil {
		return -1, nil
	}
	st, err := g.tracker.Get(ctx, tenantID)
	if err != nil || st == nil {
		// Treat "no warmup row" as no cap — Pro tier or warmup-complete.
		return -1, nil
	}
	return sending.CapForDay(st.WarmupDay, st.TierLimit), nil
}

// newAudienceCounter returns a campaigns.AudienceCounter wired to the
// campaign list audience + segments repos. The campaigns package only sees
// the narrow interface (two Count* methods); this adapter is where we cross
// the package boundary into the concrete repos.
//
// Both branches count subscribers a campaign would actually be sent to (the
// activation predicate), so the editor's count, the send review and the
// send path agree. Both return (0, nil) for "audience id resolved to
// nobody" — the upstream checklist gate is the right place to translate zero
// into a hard fail. Errors are reserved for unknown audiences and store
// failures.
func newAudienceCounter(pool *db.Pool) campaigns.AudienceCounter {
	return audienceCounter{
		lists:    &campaigns.Repo{Pool: pool},
		segments: &segments.Repo{Pool: pool},
	}
}

type audienceCounter struct {
	lists    *campaigns.Repo
	segments *segments.Repo
}

func (a audienceCounter) CountListAudience(ctx context.Context, tenantID, listID string) (int64, error) {
	if a.lists == nil {
		return 0, nil
	}
	return a.lists.CountEligibleListAudience(ctx, tenantID, listID)
}

func (a audienceCounter) CountSegmentAudience(ctx context.Context, tenantID, segmentID string) (int64, error) {
	if a.segments == nil {
		return 0, nil
	}
	return a.segments.CountSegmentAudience(ctx, tenantID, segmentID)
}

// newListmonkSender wraps *listmonk.Client into the narrow ListmonkSender
// interface the send-loop guard depends on. Listmonk's transactional API
// (/api/tx) is the only per-recipient send hook; we use it here so the
// guard can interleave per-tenant rate + quiet-hours checks per row.
//
// defaultFrom is informational — Listmonk's transactional API derives
// from_email from the configured default sender; we don't pass a per-call
// override here. If a deployment adapter adds tenant-routed sub-accounts,
// the wrapper is the right place to attach the routing header.
func newListmonkSender(client *listmonk.Client, defaultFrom string) sending.ListmonkSender {
	// Listmonk's /api/tx requires a non-zero template_id; bare sends
	// (template_id=0) get rejected with "template 0 not found". Read
	// the operator-provisioned default from env so a properly-deployed
	// stack has a working send path out of the box.
	var defaultTemplate int64
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_LISTMONK_DEFAULT_TEMPLATE_ID")); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			defaultTemplate = n
		}
	}
	return listmonkTransactional{
		client:            client,
		defaultFrom:       defaultFrom,
		defaultTemplateID: defaultTemplate,
	}
}

func newCampaignTransactionalSender(client campaigns.TransactionalSender, logger *slog.Logger) campaigns.TransactionalSender {
	if envTruthy("POSTWAVE_DEV_TRANSACTIONAL_SINK") {
		if logger == nil {
			logger = slog.Default()
		}
		return devCampaignTransactionalSink{logger: logger}
	}
	// Apply the operator-provided default Listmonk template id to any
	// request that omits it. Listmonk rejects /api/tx with `template 0
	// not found`, so test-sends and any future code path that fills in
	// the request struct directly would fail without this defaulting.
	var defaultTemplate int64
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_LISTMONK_DEFAULT_TEMPLATE_ID")); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			defaultTemplate = n
		}
	}
	if defaultTemplate == 0 {
		return client
	}
	return campaignSenderWithDefaultTemplate{inner: client, defaultTemplateID: defaultTemplate}
}

type campaignSenderWithDefaultTemplate struct {
	inner             campaigns.TransactionalSender
	defaultTemplateID int64
}

func (s campaignSenderWithDefaultTemplate) SendTransactional(ctx context.Context, req listmonk.SendTransactionalReq) error {
	if req.TemplateID == 0 {
		req.TemplateID = s.defaultTemplateID
	}
	return s.inner.SendTransactional(ctx, req)
}

type devCampaignTransactionalSink struct {
	logger *slog.Logger
}

func (d devCampaignTransactionalSink) SendTransactional(_ context.Context, req listmonk.SendTransactionalReq) error {
	d.logger.Info("dev campaign transactional sink accepted",
		"to", req.SubscriberEmail,
		"subject", req.Subject,
		"content_type", req.ContentType,
	)
	return nil
}

func envTruthy(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

type listmonkTransactional struct {
	client            *listmonk.Client
	defaultFrom       string
	defaultTemplateID int64
}

func (l listmonkTransactional) Send(ctx context.Context, tenantID, email, subject, htmlBody string) error {
	return l.send(tenantengine.WithTenant(ctx, tenantID), email, subject, htmlBody, "", "", nil)
}

// SendIdempotent implements sending.ListmonkSender's idempotent
// variant. The key is attached to the wire request as an
// Idempotency-Key header by the listmonk.Client.
func (l listmonkTransactional) SendIdempotent(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey string) error {
	return l.send(tenantengine.WithTenant(ctx, tenantID), email, subject, htmlBody, idempotencyKey, "", nil)
}

// SendWithRouting routes the send through the named Listmonk
// messenger when non-empty (per-tenant dedicated IP pool). Empty
// falls through to default routing.
func (l listmonkTransactional) SendWithRouting(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey, messenger string) error {
	return l.send(tenantengine.WithTenant(ctx, tenantID), email, subject, htmlBody, idempotencyKey, messenger, nil)
}

// SendWithHeaders is SendWithRouting + arbitrary wire headers
// (List-Unsubscribe / List-Unsubscribe-Post for one-click RFC 8058).
func (l listmonkTransactional) SendWithHeaders(ctx context.Context, tenantID, email, subject, htmlBody, idempotencyKey, messenger string, headers map[string]string) error {
	return l.send(tenantengine.WithTenant(ctx, tenantID), email, subject, htmlBody, idempotencyKey, messenger, headers)
}

func (l listmonkTransactional) send(ctx context.Context, email, subject, htmlBody, idempotencyKey, messenger string, headers map[string]string) error {
	if l.client == nil {
		return errors.New("listmonk client not configured")
	}
	return l.client.SendTransactional(ctx, listmonk.SendTransactionalReq{
		SubscriberEmail: email,
		TemplateID:      l.defaultTemplateID,
		Subject:         subject,
		Body:            htmlBody,
		ContentType:     "html",
		IdempotencyKey:  idempotencyKey,
		Messenger:       messenger,
		Headers:         headers,
	})
}

// oneClickSuppressorAdapter bridges preferences' narrow suppression seam to
// the canonical suppression row and customer-webhook delivery intent. Both
// writes share one tenant transaction: a successful RFC 8058 response can
// never acknowledge the opt-out while losing subscriber.unsubscribed.
type oneClickSuppressorAdapter struct {
	pool   *db.Pool
	fanout *outbound_webhooks.TransactionalFanout
}

// Add satisfies preferences.OneClickSuppressor.
func (a oneClickSuppressorAdapter) Add(ctx context.Context, tenantID, email, reason string, evidence preferences.OneClickEvidence) error {
	if a.pool == nil || a.fanout == nil {
		return errors.New("one-click suppressor: durable fanout is not configured")
	}
	tenantID = strings.TrimSpace(tenantID)
	email = strings.ToLower(strings.TrimSpace(email))
	if tenantID == "" || email == "" {
		return errors.New("one-click suppressor: tenant and email are required")
	}
	tx, err := db.WithTenant(ctx, a.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Only a new or previously expired suppression is a domain transition.
	// The WHERE arm makes concurrent/retried RFC 8058 calls against an already
	// active row a no-op, so exactly one transaction owns the webhook event.
	var sourceEventID string
	err = tx.QueryRow(ctx, `
INSERT INTO email_suppressions (
    tenant_id, email, reason, source, metadata
)
VALUES (
    $1::uuid, $2, 'unsubscribe', 'one_click',
    '{"origin":"rfc8058"}'::jsonb
)
ON CONFLICT (tenant_id, email, reason) DO UPDATE
SET suppressed_at = now(),
    expires_at = NULL,
    source = 'one_click',
    metadata = email_suppressions.metadata || EXCLUDED.metadata
WHERE email_suppressions.expires_at IS NOT NULL
RETURNING gen_random_uuid()::text`,
		tenantID, email,
	).Scan(&sourceEventID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The active suppression already owns its webhook delivery. Lock that row
		// explicitly before the evidence existence check so concurrent mailbox
		// retries cannot both heal the same legacy gap.
		sourceEventID = ""
		if _, lockErr := tx.Exec(ctx, `
SELECT 1
  FROM email_suppressions
 WHERE tenant_id = $1::uuid
   AND email = $2
   AND reason = 'unsubscribe'
   AND expires_at IS NULL
 FOR UPDATE`, tenantID, email); lockErr != nil {
			return lockErr
		}
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if sourceEventID != "" {
		// A new/reactivated suppression is a new domain transition and therefore
		// owns one new evidence row even when older activations exist.
		if err := preferences.AppendOneClickConsentRevocation(ctx, tx, tenantID, email, evidence); err != nil {
			return err
		}
	} else {
		// An already-active suppression is an idempotent retry. Append only when
		// healing a legacy row that predates canonical consent evidence.
		if _, err := preferences.EnsureOneClickConsentRevocation(ctx, tx, tenantID, email, evidence); err != nil {
			return err
		}
	}
	occurredAt := time.Now().UTC()
	if sourceEventID != "" {
		if _, err := a.fanout.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
			TenantID:      tenantID,
			EventType:     outbound_webhooks.EventSubscriberUnsubscribed,
			SourceEventID: sourceEventID,
			OccurredAt:    occurredAt,
			Body: map[string]any{
				"email":  email,
				"reason": reason,
				"source": "one_click",
			},
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// newSubscribersTriggerReplayer bridges the package-local subscribers
// TriggerReplayer contract to the concrete trigger_replayer.Replayer (SUB-003)
// so subscribers stays free of the trigger_replayer import.
func newSubscribersTriggerReplayer(pool *db.Pool) subscribers.TriggerReplayer {
	return subscribersTriggerReplayerAdapter{r: trigger_replayer.New(pool)}
}

type subscribersTriggerReplayerAdapter struct {
	r *trigger_replayer.Replayer
}

func (a subscribersTriggerReplayerAdapter) RetryIdentifiedEventsWithin(ctx context.Context, tenantID, subscriberEmail string, window time.Duration) (*subscribers.ReplayResult, error) {
	res, err := a.r.RetryIdentifiedEventsWithin(ctx, tenantID, subscriberEmail, window)
	if err != nil {
		return nil, err
	}
	return &subscribers.ReplayResult{
		EventsInWindow:   res.EventsInWindow,
		SyntheticEmitted: res.SyntheticEmitted,
	}, nil
}

// newSubscribersWebhookAdapter bridges the package-local subscribers
// dispatcher contract to the real webhooks.Dispatcher + every wired
// integration adapter (Slack, Discord, Teams, ...) so subscribers
// stays free of all those imports.
func newSubscribersWebhookAdapter(d *webhooks.Dispatcher, integrations ...webhooks.IntegrationFanouter) subscribers.WebhookDispatcher {
	return subscribersWebhookAdapter{d: d, integrations: integrations}
}

type subscribersWebhookAdapter struct {
	d            *webhooks.Dispatcher
	integrations []webhooks.IntegrationFanouter
}

func (a subscribersWebhookAdapter) Fire(ctx context.Context, tx pgx.Tx, in subscribers.WebhookFireInput) (int, error) {
	n, err := a.d.Fire(ctx, tx, webhooks.FireInput{
		TenantID:       in.TenantID,
		EventType:      webhooks.EventType(in.EventType),
		Body:           in.Body,
		IdempotencyKey: in.IdempotencyKey,
	})
	if err != nil {
		return n, err
	}
	// Per-integration fanouts ride the same producer tx for atomicity:
	// failure here rolls back the business write. Matches webhook
	// semantics so adding/removing integrations doesn't change the
	// rollback contract.
	for _, adapter := range a.integrations {
		if adapter == nil {
			continue
		}
		if _, err := adapter.Fire(ctx, tx, in.TenantID, in.EventType, in.Body); err != nil {
			return n, err
		}
	}
	return n, nil
}

type listMembershipWebhookAdapter struct {
	fanout *outbound_webhooks.TransactionalFanout
}

func newListMembershipWebhookAdapter(
	fanout *outbound_webhooks.TransactionalFanout,
) lists.MembershipWebhookFanout {
	return listMembershipWebhookAdapter{fanout: fanout}
}

func (a listMembershipWebhookAdapter) FireListSubscriberAddedBatch(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	events []lists.SubscriberAddedMembership,
) (int, error) {
	if a.fanout == nil || len(events) == 0 {
		return 0, nil
	}
	canonical := make(
		[]outbound_webhooks.ListSubscriberAddedEvent,
		0,
		len(events),
	)
	for _, event := range events {
		canonical = append(canonical, outbound_webhooks.ListSubscriberAddedEvent{
			SubscriberID: event.SubscriberID,
			Email:        event.Email,
			ListID:       event.ListID,
			Source:       event.Source,
			AddedAt:      event.AddedAt,
		})
	}
	return a.fanout.FireListSubscriberAddedBatch(
		ctx, tx, tenantID, canonical,
	)
}

// tagsWebhookAdapter bridges tags.WebhookDispatcher to the real
// webhooks.Dispatcher so the tags package doesn't import webhooks.
// Tag mutations don't fan out to Slack/Discord/Teams adapters in V1
// (those are subscriber- and campaign-scoped); add them here if that
// changes.
type tagsWebhookAdapter struct {
	d *webhooks.Dispatcher
}

func (a tagsWebhookAdapter) Fire(ctx context.Context, tx pgx.Tx, in tags.WebhookFireInput) (int, error) {
	return a.d.Fire(ctx, tx, webhooks.FireInput{
		TenantID:  in.TenantID,
		EventType: webhooks.EventType(in.EventType),
		Body:      in.Body,
	})
}

// tagsFlowTriggerAdapter bridges tags.FlowTriggerDispatcher to the
// flowbuilder repo so a tag mutation can enqueue flow_runs for every
// active flow whose trigger is tag.added / tag.removed. Fan-out is
// hard-capped by MaxTagTriggerFanout in flowbuilder so a tenant wiring
// the same tag into many flows can't unintentionally blow up
// per-event work. Runs on the caller's tx so flow_runs commits
// atomically with the tag_history row that produced it.
type tagsFlowTriggerAdapter struct {
	repo *flowbuilder.Repo
}

func (a tagsFlowTriggerAdapter) Dispatch(ctx context.Context, tx pgx.Tx, in tags.FlowTriggerEvent) error {
	if a.repo == nil {
		return nil
	}
	matches, err := a.repo.MatchFlowsForTagEventTx(ctx, tx, in.TenantID, in.Action, in.TagName, in.TagID)
	if err != nil {
		// Tag history is authoritative even while automation execution is
		// release-contained. Swallow only the typed capability boundary; every
		// repository or query error still aborts the caller-owned transaction.
		if errors.Is(err, flowbuilder.ErrFlowRuntimeUnavailable) {
			return nil
		}
		return err
	}
	if len(matches) > 10 {
		matches = matches[:10]
	}
	eventName := flowbuilder.TagTriggerEventName(in.Action)
	for _, match := range matches {
		if _, err := a.repo.EnqueueRunInTx(ctx, tx, in.TenantID, flowbuilder.RunEnqueueRequest{
			FlowID:           match.FlowID,
			SubscriberID:     in.SubscriberID,
			TriggerEventName: eventName,
			ScheduledAt:      time.Now().UTC(),
			// The tag is the match context. Engine.Trigger re-checks it
			// (a trigger with Tag="vip" only fires when payload["tag"]=="vip"),
			// so a run enqueued without it is silently dropped as a non-match.
			TriggerPayload: map[string]any{"tag": in.TagName},
		}); err != nil {
			return err
		}
	}
	return nil
}

// newCampaignsWebhookAdapter bridges the package-local campaigns
// dispatcher contract to the real webhooks.Dispatcher + every wired
// integration adapter. Same pattern as newSubscribersWebhookAdapter.
func newCampaignsWebhookAdapter(d *webhooks.Dispatcher, integrations ...webhooks.IntegrationFanouter) campaigns.WebhookDispatcher {
	return campaignsWebhookAdapter{d: d, integrations: integrations}
}

type campaignsWebhookAdapter struct {
	d            *webhooks.Dispatcher
	integrations []webhooks.IntegrationFanouter
}

func (a campaignsWebhookAdapter) Fire(ctx context.Context, tx pgx.Tx, in campaigns.WebhookFireInput) (int, error) {
	n, err := a.d.Fire(ctx, tx, webhooks.FireInput{
		TenantID:       in.TenantID,
		EventType:      webhooks.EventType(in.EventType),
		Body:           in.Body,
		IdempotencyKey: in.IdempotencyKey,
	})
	if err != nil {
		return n, err
	}
	for _, adapter := range a.integrations {
		if adapter == nil {
			continue
		}
		if _, err := adapter.Fire(ctx, tx, in.TenantID, in.EventType, in.Body); err != nil {
			return n, err
		}
	}
	return n, nil
}

// derefInt unwraps an *int into an int (0 for nil). Used by the
// per-API-key rate-limit lookup so a "no limit configured" column
// (NULL) reads as 0 = unlimited at the middleware layer.
func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return ""
}

// localUploadPutHandler serves the development-only direct-upload PUT. The
// route is mounted in every configuration because routeauth refuses to boot
// when a manifest route is not mounted, and production has no local store: it
// stores uploads in S3 through presigned URLs, so there the route answers 404.
func localUploadPutHandler(store *forms.LocalUploadStore) http.HandlerFunc {
	if store == nil {
		return http.NotFound
	}
	return store.ServePut
}

func directSendingProvisionRouteEnabled() bool {
	return !isProductionEnv() || strings.EqualFold(os.Getenv("POSTWAVE_ALLOW_DIRECT_PROVISION"), "true") || os.Getenv("POSTWAVE_ALLOW_DIRECT_PROVISION") == "1"
}

func runSendingDeprovisionWorker(ctx context.Context, provisioner *sending.Provisioner, logger *slog.Logger) {
	if provisioner == nil {
		return
	}
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		completed, err := provisioner.RunDueDeprovisionJobs(ctx, 25)
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("sending deprovision worker failed", "err", err.Error())
		} else if completed > 0 {
			logger.Info("sending deprovision worker completed jobs", "count", completed)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// cmpOr returns the first non-empty argument. Tiny convenience for
// env-var-with-default in main.go without importing cmp.Or (which is
// 1.21+ but not 1.23-only — keep this readable inline).
func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// newWebhookFanoutAppender returns a tx-less appender for "best-effort
// fan out an event after a business write committed". Producers that
// can't (or shouldn't) reuse their write tx — public form-submit, the
// listmonk-events sync path, etc. — call this. It opens its own tx,
// writes a single webhook.fanout outbox row, and commits. The
// FanoutHandler then expands that into per-subscription delivery rows.
func newWebhookFanoutAppender(repo *outbox.Repo) webhookFanoutAppender {
	return webhookFanoutAppender{repo: repo}
}

type webhookFanoutAppender struct{ repo *outbox.Repo }

func (a webhookFanoutAppender) AppendFanout(ctx context.Context, tenantID, eventType string, body any) error {
	if a.repo == nil || tenantID == "" || eventType == "" {
		return nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("webhook fanout: marshal body: %w", err)
	}
	tx, err := db.WithTenant(ctx, a.repo.Pool, tenantID)
	if err != nil {
		return fmt.Errorf("webhook fanout: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := a.repo.Append(ctx, tx, outbox.Append{
		TenantID: tenantID,
		Kind:     webhooks.FanoutKind,
		Payload: webhooks.FanoutPayload{
			EventType: eventType,
			Body:      bodyBytes,
		},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func allowMemoryFallback() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_ALLOW_MEMORY_FALLBACK"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Slack approval-bot adapters.
// ---------------------------------------------------------------------------
// These thin adapters bridge the approvals package's narrow interfaces
// (SlackPoster, plus the slackint-side Decider/Creator interfaces) to
// the concrete approvals.Service type. Defined here, in main.go,
// because main.go owns both packages — keeping the bridge out of
// each package keeps their dep graph free of the other.

// approvalSlackBridge satisfies approvals.SlackPoster. It receives a
// *approvals.Approval and forwards a slackint.ApprovalView (plain
// struct that satisfies slackint.ApprovalLike) to ApprovalDeps.
type approvalSlackBridge struct {
	Deps *slackint.ApprovalDeps
}

func (b approvalSlackBridge) PostApprovalRequest(ctx context.Context, a *approvals.Approval) error {
	if b.Deps == nil || a == nil {
		return nil
	}
	return b.Deps.PostApprovalRequest(ctx, slackint.ApprovalView{
		ID:                    a.ID,
		TenantID:              a.TenantID,
		ResourceType:          a.ResourceType,
		ResourceID:            a.ResourceID,
		RequestedByActorLabel: a.RequestedByActorLabel,
		ExpiresAt:             a.ExpiresAt,
	})
}

// approvalDeciderAdapter satisfies slackint.ApprovalDecider. Forwards
// to the approvals.Service.Decide and Repo.Get methods.
type approvalDeciderAdapter struct {
	Service    *approvals.Service
	OnApproved approvals.ApprovedHook
}

func (a approvalDeciderAdapter) Decide(ctx context.Context, tenantID, approvalID, action, decidedByUserID, notes string) error {
	d := approvals.DecisionApprove
	if action == "reject" {
		d = approvals.DecisionReject
	}
	if err := a.Service.Decide(ctx, tenantID, approvalID, d, decidedByUserID, notes); err != nil {
		return err
	}
	if d != approvals.DecisionApprove || a.OnApproved == nil || a.Service == nil || a.Service.Repo == nil {
		return nil
	}
	row, err := a.Service.Repo.Get(ctx, tenantID, approvalID)
	if err != nil {
		return err
	}
	if row.Status != approvals.StatusApproved {
		return nil
	}
	return a.OnApproved(ctx, tenantID, approvals.ResourceType(row.ResourceType), row.ResourceID)
}

func (a approvalDeciderAdapter) LookupSummary(ctx context.Context, tenantID, approvalID string) string {
	if a.Service == nil || a.Service.Repo == nil {
		return ""
	}
	row, err := a.Service.Repo.Get(ctx, tenantID, approvalID)
	if err != nil || row == nil {
		return ""
	}
	return row.ResourceType + " · " + row.ResourceID
}

// approvalCreatorAdapter satisfies slackint.ApprovalCreator for the
// `/postwave send <campaign_id>` slash command — creates a campaign
// approval row via the existing service.
//
// SlackPoster mirrors the wiring inside approvals.RequestApprovalHandler:
// every direct Service.Request caller in this binary should fan out to
// the Slack approval bot if one is connected, so a campaign send /
// sequence activate / automation send approval shows up in the tenant's
// channel regardless of which surface created it. Failures are logged
// and never propagate.
type approvalCreatorAdapter struct {
	Service     *approvals.Service
	SlackPoster approvals.SlackPoster
}

// postSlackForApproval is the shared "fan out a freshly-created approval
// to the Slack approval bot" helper. nil-safe so test wiring stays
// minimal; runs in a goroutine so a slow Slack API call doesn't extend
// the calling request's latency.
func postSlackForApproval(poster approvals.SlackPoster, a *approvals.Approval) {
	if poster == nil || a == nil {
		return
	}
	approvalCopy := *a
	safego.Go(slog.Default(), "slack-approval-poster", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := poster.PostApprovalRequest(ctx, &approvalCopy); err != nil {
			slog.Warn("slack post approval failed",
				"approval_id", approvalCopy.ID,
				"tenant_id", approvalCopy.TenantID,
				"err", err.Error())
		}
	})
}

func (a approvalCreatorAdapter) CreateForCampaign(ctx context.Context, tenantID, campaignID, requesterLabel string) (*slackint.ApprovalView, error) {
	row, err := a.Service.Request(ctx, tenantID, approvals.Resource{
		Type: approvals.ResourceCampaign,
		ID:   campaignID,
	}, approvals.Actor{
		Type:  "slack",
		Label: requesterLabel,
	})
	if err != nil {
		return nil, err
	}
	postSlackForApproval(a.SlackPoster, row)
	return &slackint.ApprovalView{
		ID:                    row.ID,
		TenantID:              row.TenantID,
		ResourceType:          row.ResourceType,
		ResourceID:            row.ResourceID,
		RequestedByActorLabel: row.RequestedByActorLabel,
		ExpiresAt:             row.ExpiresAt,
	}, nil
}

// campaignApprovalGate bridges campaigns.ApprovalGate to the approvals
// package. It reuses an active pending/approved row for the same campaign so
// repeated send attempts do not spam admins with duplicate approval requests.
type campaignApprovalGate struct {
	Service     *approvals.Service
	SlackPoster approvals.SlackPoster
}

func (g campaignApprovalGate) EnsureCampaignSendApproved(ctx context.Context, tenantID, campaignID, fingerprint string, actor campaigns.ApprovalActor) (*campaigns.ApprovalState, error) {
	if g.Service == nil || g.Service.Repo == nil {
		return &campaigns.ApprovalState{Approved: true, Status: string(approvals.StatusApproved)}, nil
	}
	if latest, err := g.Service.Repo.LatestForResource(ctx, tenantID, approvals.ResourceCampaign, campaignID); err == nil && latest != nil {
		switch latest.Status {
		case approvals.StatusApproved:
			// D7+D11 guards: an Approved row is only reusable if
			//   (a) its content_hash matches the current campaign
			//       content (no post-approval edits), AND
			//   (b) it has NOT already been consumed (one-shot).
			// Failing either falls through to request a fresh
			// approval. Empty stored hash = legacy pre-0160 row;
			// honor it as before to avoid bricking in-flight
			// approvals during the deploy window.
			storedHash, consumedAt, ferr := g.Service.Repo.FingerprintAndConsumed(ctx, tenantID, latest.ID)
			if ferr == nil {
				edited := storedHash != "" && fingerprint != "" && storedHash != fingerprint
				consumed := consumedAt != nil
				if !edited && !consumed {
					return campaignApprovalState(latest, true), nil
				}
				// Fall through to re-request below.
			}
		case approvals.StatusPending:
			if time.Now().UTC().Before(latest.ExpiresAt) {
				return campaignApprovalState(latest, false), nil
			}
		}
	} else if !errors.Is(err, approvals.ErrNotFound) {
		return nil, err
	}

	var apiKeyID *string
	if strings.TrimSpace(actor.APIKeyID) != "" {
		v := strings.TrimSpace(actor.APIKeyID)
		apiKeyID = &v
	}
	var userID *string
	if strings.TrimSpace(actor.UserID) != "" {
		v := strings.TrimSpace(actor.UserID)
		userID = &v
	}
	row, err := g.Service.Request(ctx, tenantID, approvals.Resource{
		Type: approvals.ResourceCampaign,
		ID:   campaignID,
	}, approvals.Actor{
		Type:     actorTypeOrHuman(actor.Type),
		Label:    actor.Label,
		APIKeyID: apiKeyID,
		UserID:   userID,
	}, approvals.WithContentHash(fingerprint))
	if err != nil {
		return nil, err
	}
	postSlackForApproval(g.SlackPoster, row)
	return campaignApprovalState(row, false), nil
}

// MarkApprovalConsumed implements campaigns.ApprovalGate. Stamps the
// approval row's consumed_at so a second queue/send for the same
// campaign can't silently reuse the grant.
// VerifyApprovedFingerprint compares the current content hash against the one
// stored on the most recent approval for this campaign.
//
// Reuses the same repo read the gate uses (FingerprintAndConsumed) so the two
// paths cannot disagree about what "approved content" means.
func (g campaignApprovalGate) VerifyApprovedFingerprint(
	ctx context.Context, tenantID, campaignID, fingerprint string,
) (bool, error) {
	if g.Service == nil || g.Service.Repo == nil {
		// No approvals service wired: the gate itself treats this as "approved",
		// so refusing here would make the two paths disagree.
		return true, nil
	}
	latest, err := g.Service.Repo.LatestForResource(ctx, tenantID, approvals.ResourceCampaign, campaignID)
	if err != nil {
		return false, err
	}
	if latest == nil {
		// Nothing was approved. The caller is the approval hook, which only runs
		// after a decision, so this should not occur — report it as a mismatch
		// rather than waving the send through.
		return false, nil
	}
	storedHash, _, err := g.Service.Repo.FingerprintAndConsumed(ctx, tenantID, latest.ID)
	if err != nil {
		return false, err
	}
	// An empty stored hash predates the fingerprint. Honouring it keeps a
	// deploy from bricking every in-flight approval, matching the gate's own
	// treatment of legacy rows.
	if storedHash == "" || fingerprint == "" {
		return true, nil
	}
	return storedHash == fingerprint, nil
}

func (g campaignApprovalGate) MarkApprovalConsumed(ctx context.Context, tenantID, approvalID string) error {
	if g.Service == nil || g.Service.Repo == nil || strings.TrimSpace(approvalID) == "" {
		return nil
	}
	return g.Service.Repo.MarkConsumed(ctx, tenantID, approvalID)
}

// actorTypeOrHuman returns t when non-empty, otherwise "human".
// Local helper because the apikeys + commerce packages each define
// their own internal firstNonEmpty with package scope.
func actorTypeOrHuman(t string) string {
	if strings.TrimSpace(t) == "" {
		return "human"
	}
	return t
}

type commerceProductFeedResolver struct {
	Repo *commerce.Repo
}

func (r commerceProductFeedResolver) ResolveProductFeed(ctx context.Context, tenantID, catalogID, feedID string, opts email_blocks.ProductFeedResolveOptions) ([]email_blocks.ResolvedProduct, error) {
	if r.Repo == nil {
		return nil, errors.New("commerce product feed resolver unavailable")
	}
	out, err := r.Repo.ResolveProductFeed(ctx, tenantID, catalogID, feedID, commerce.ProductFeedResolveInput{
		SubscriberEmail:   opts.SubscriberEmail,
		MaxItems:          opts.MaxItems,
		ExcludeOutOfStock: opts.ExcludeOutOfStock,
	})
	if err != nil {
		return nil, err
	}
	items := make([]email_blocks.ResolvedProduct, 0, len(out.Items))
	for _, item := range out.Items {
		items = append(items, email_blocks.ResolvedProduct{
			Title:      item.Title,
			ImageURL:   item.ImageURL,
			URL:        item.URL,
			PriceCents: item.PriceCents,
			Currency:   item.Currency,
		})
	}
	return items, nil
}

type discountCouponResolver struct {
	Repo *discounts.Repo
}

func (r discountCouponResolver) AssignCoupon(ctx context.Context, tenantID, poolID string, opts email_blocks.CouponResolveOptions) (*email_blocks.ResolvedCoupon, error) {
	if r.Repo == nil {
		return nil, errors.New("coupon resolver unavailable")
	}
	out, err := r.Repo.AssignCoupon(ctx, tenantID, poolID, discounts.CouponAssignmentInput{
		SubscriberID:          opts.SubscriberID,
		SubscriberEmail:       opts.SubscriberEmail,
		ContextKey:            opts.ContextKey,
		RenderKey:             opts.RenderKey,
		Channel:               opts.Channel,
		Surface:               opts.Surface,
		ReservationTTLSeconds: opts.ReservationTTLSeconds,
	}, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &email_blocks.ResolvedCoupon{
		Code:         out.Assignment.Code,
		PoolID:       out.Assignment.PoolID,
		AssignmentID: out.Assignment.ID,
		ExpiresAt:    out.Assignment.ExpiresAt,
	}, nil
}

type onsiteCouponAssigner struct {
	Repo *discounts.Repo
}

func (a onsiteCouponAssigner) AssignCoupon(ctx context.Context, tenantID, poolID string, in onsite_growth.CouponAssignmentInput) (*onsite_growth.AssignedCoupon, error) {
	if a.Repo == nil {
		return nil, errors.New("coupon assigner unavailable")
	}
	out, err := a.Repo.AssignCoupon(ctx, tenantID, poolID, discounts.CouponAssignmentInput{
		SubscriberID:          in.SubscriberID,
		SubscriberEmail:       in.SubscriberEmail,
		ContextKey:            in.ContextKey,
		RenderKey:             in.RenderKey,
		Channel:               in.Channel,
		Surface:               in.Surface,
		ReservationTTLSeconds: in.ReservationTTLSeconds,
		Metadata:              in.Metadata,
	}, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &onsite_growth.AssignedCoupon{
		Code:         out.Assignment.Code,
		PoolID:       out.Assignment.PoolID,
		AssignmentID: out.Assignment.ID,
		ExpiresAt:    out.Assignment.ExpiresAt,
	}, nil
}

// byokAWSClient returns the AWS-SDK-v2 KMS client to register in the
// BYOK provider registry. Returns nil when the deployment has no AWS
// region OR no platform KMS key configured (both are required to
// reach a working KMS endpoint at all). Returning nil makes
// byok.BuildRegistry skip the "aws" provider registration cleanly —
// HealthCheck will surface a "unknown provider 'aws'" error to the
// operator rather than crash on a nil client.
//
// Note: the BYOK provider uses the SAME AWS credentials as the
// platform KMS client. Per-tenant KMS keys are routed by KeyRef
// (the ARN/alias the tenant supplies), and AWS authorises each
// kms:Encrypt / kms:Decrypt against that ARN's resource policy. So
// a tenant's customer-managed KMS key is only usable if the
// platform's AWS IAM role has been granted access via the customer's
// KMS key policy — the standard cross-account BYOK pattern.
func byokAWSClient(awsCfg aws.Config, platformKMSKeyID string) *kms.Client {
	if awsCfg.Region == "" || platformKMSKeyID == "" {
		return nil
	}
	return kms.NewFromConfig(awsCfg)
}

func campaignApprovalState(row *approvals.Approval, approved bool) *campaigns.ApprovalState {
	if row == nil {
		return &campaigns.ApprovalState{Approved: approved}
	}
	expiresAt := row.ExpiresAt
	return &campaigns.ApprovalState{
		Approved:  approved,
		ID:        row.ID,
		Status:    string(row.Status),
		ExpiresAt: &expiresAt,
	}
}

type sandboxCampaignLifecycle struct {
	Simulator *sandbox.Simulator
}

func (s sandboxCampaignLifecycle) SimulateCampaignLifecycle(ctx context.Context, tenantID, campaignID string, recipientCount int, now time.Time) error {
	if s.Simulator == nil {
		return errors.New("sandbox simulator is not configured")
	}
	return s.Simulator.SimulateLifecycle(ctx, tenantID, campaignID, recipientCount, sandbox.DefaultSchedule, now)
}

// inboundEmailSourceType classifies an inbound email for the support spine: a
// reply tied to a campaign is a 'campaign_reply', otherwise generic
// 'inbound_email'.
func inboundEmailSourceType(em inbound_email.Email) string {
	if em.CampaignID != "" {
		return "campaign_reply"
	}
	return "inbound_email"
}

// inboundEmailConversation maps an inbound email to the support conversation it
// belongs to. The thread key prefers the In-Reply-To (so a reply joins the
// existing thread) then the message id.
func inboundEmailConversation(em inbound_email.Email) service_suite.Conversation {
	thread := em.InReplyTo
	if thread == "" {
		thread = em.MessageID
	}
	return service_suite.Conversation{
		ChannelType:      "email",
		SourceType:       inboundEmailSourceType(em),
		ExternalThreadID: thread,
		SubscriberID:     em.SubscriberID,
		RequesterEmail:   em.From,
		Subject:          em.Subject,
		Status:           "open",
		Priority:         "normal",
	}
}

// inboundEmailMessage maps an inbound email to the support message appended to
// its conversation.
func inboundEmailMessage(em inbound_email.Email) service_suite.Message {
	return service_suite.Message{
		SourceType: inboundEmailSourceType(em),
		SourceID:   em.MessageID,
		Direction:  "inbound",
		SenderType: "customer",
		Sender:     em.From,
		BodyText:   em.BodyText,
		BodyHTML:   em.BodyHTML,
		SentAt:     time.Now().UTC(),
	}
}

type reviewsFlowEventAdapter struct{ track *track.Repo }

// reviewFlowEventSem bounds the number of in-flight review→flow fanout
// goroutines process-wide. The public storefront submit is unauthenticated, and
// each accepted event spawns a goroutine that holds 2..N pooled DB connections
// (resolve + insert + per-flow enqueue) for up to 15s. Without a cap a burst
// could exhaust the connection pool; at capacity we drop the event (best-effort
// — a flow trigger is not the system of record) rather than pile up goroutines.
var reviewFlowEventSem = make(chan struct{}, 64)

func (a reviewsFlowEventAdapter) EmitFlowEvent(ctx context.Context, tenantID string, ev reviews.FlowEvent) {
	if a.track == nil {
		return
	}
	select {
	case reviewFlowEventSem <- struct{}{}:
	default:
		return // at capacity — shed load rather than exhaust the DB pool
	}
	// Detach from the request context (which is cancelled when the handler
	// returns) and run in the background; mirrors track.Repo's own async
	// fanout. Panic-safe so a bad payload can't crash the server.
	go func() {
		defer func() { <-reviewFlowEventSem }()
		defer func() { _ = recover() }()
		bg, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		subID, err := a.track.ResolveSubscriber(bg, tenantID, ev.SubscriberID, ev.Email)
		if err != nil || subID == "" {
			return // unknown subscriber — nothing to enroll
		}
		props, err := json.Marshal(ev.Props)
		if err != nil {
			return
		}
		_, _ = a.track.Insert(bg, tenantID, subID, ev.EventName, props, ev.OccurredAt, "")
	}()
}

// assetsTenantLister is a tiny adapter that satisfies assets.TenantLister
// for the references-refresher goroutine. Reads outside any tenant tx —
// the refresher then enters per-tenant transactions itself via the repo.
type assetsTenantLister struct{ pool *db.Pool }

func (a assetsTenantLister) ActiveTenantIDs(ctx context.Context) ([]string, error) {
	if a.pool == nil {
		return nil, nil
	}
	rows, err := a.pool.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// listsForTenant returns the distinct list ids that have at least one
// live member, for the given tenant. Used by the list-health history
// worker (GAP-LS-119) to pick which lists to snapshot daily.
//
// Runs inside a tenant-scoped tx so RLS does the cross-tenant filtering
// and the worker doesn't need any sui-generis worker bypass policy.
func listsForTenant(ctx context.Context, pool *db.Pool, tenantID string) ([]string, error) {
	if pool == nil || strings.TrimSpace(tenantID) == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT list_id::text FROM list_subscribers
 WHERE tenant_id = $1::uuid AND removed_at IS NULL`,
		tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// segmentsNLQAdapter bridges audit.LLMClient (Complete returns
// text+token-usage) → segments.NLProvider (Complete returns text
// only). The token counts the audit client surfaces matter for the
// NLQ cost tracker, but the AI segment compiler operates outside
// that ledger so we drop them on the floor here.
type segmentsNLQAdapter struct{ c audit.LLMClient }

func (a segmentsNLQAdapter) Complete(ctx context.Context, system, user string) (string, error) {
	text, _, _, err := a.c.Complete(ctx, system, user)
	return text, err
}

// AIProcessingMetadata exposes only facts available from the concrete client.
// A different audit.LLMClient implementation remains undisclosed instead of
// being mislabeled as Anthropic or assigned an invented model.
func (a segmentsNLQAdapter) AIProcessingMetadata() segments.AIProviderMetadata {
	client, ok := a.c.(*audit.AnthropicNLQClient)
	if !ok || client == nil {
		return segments.AIProviderMetadata{}
	}
	provider := ""
	if strings.EqualFold(strings.TrimRight(strings.TrimSpace(client.BaseURL), "/"), "https://api.anthropic.com") {
		provider = "anthropic"
	}
	return segments.AIProviderMetadata{
		Provider: provider,
		Model:    strings.TrimSpace(client.Model),
	}
}

// automationEmailSuppression adapts suppressions.Store to the narrow interface
// campaigns.AutomationEmailHandler needs. The handler only cares whether the
// address is suppressed, not why.
type automationEmailSuppression struct {
	store *suppressions.Store
}

func (a automationEmailSuppression) Check(ctx context.Context, tenantID, email string) (bool, error) {
	suppressed, _, err := a.store.Check(ctx, tenantID, email)
	return suppressed, err
}

// newOfferTenantResolver resolves an offer's tenant from its id.
//
// Public offer reads have no session — an agent following a CTA carries no
// credentials — so the tenant has to be established from the only thing the
// request holds. The offer id is a UUID and globally unique, so this is a
// cross-tenant lookup by design, and it deliberately runs OUTSIDE RLS: there is
// no bound tenant yet for a policy to filter on.
//
// It returns only the tenant id, never any offer content. The content read that
// follows is tenant-scoped normally, so a caller who guesses a UUID learns
// nothing this lookup did not already have to tell them — that the id exists.
func newOfferTenantResolver(pool *db.Pool) func(context.Context, string) (string, error) {
	return offerTenantResolver(pool, 5*time.Second)
}

type offerTenantQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func offerTenantResolver(query offerTenantQueryer, timeout time.Duration) func(context.Context, string) (string, error) {
	return func(ctx context.Context, offerID string) (string, error) {
		offerID = strings.TrimSpace(offerID)
		if offerID == "" {
			return "", offers.ErrNotFound
		}
		parsed, err := uuid.Parse(offerID)
		if err != nil || parsed.String() != offerID {
			// Refused before it reaches a ::uuid cast: malformed and non-canonical
			// identifiers are indistinguishable from an absent public resource.
			return "", offers.ErrNotFound
		}
		if query == nil {
			return "", errors.New("public offer tenant resolver: database unavailable")
		}
		lookupCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		var tenantID string
		err = query.QueryRow(lookupCtx,
			`SELECT public.resolve_public_offer_tenant($1::uuid)::text`, offerID).Scan(&tenantID)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", offers.ErrNotFound
		}
		if err != nil {
			return "", fmt.Errorf("public offer tenant resolver: %w", err)
		}
		if strings.TrimSpace(tenantID) == "" {
			return "", offers.ErrNotFound
		}
		return tenantID, nil
	}
}
