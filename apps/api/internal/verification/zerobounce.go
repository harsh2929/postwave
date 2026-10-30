// SPDX-License-Identifier: AGPL-3.0-only
//
// zerobounce.go — the ZeroBounce v2 driver.
//
// Endpoints used:
//
//	GET  {BaseURL}/v2/validate?api_key=&email=&ip_address=
//	POST {BulkURL}/v2/validatebatch
//	GET  {BaseURL}/v2/getcredits?api_key=
//	GET  {BaseURL}/v2/activity?api_key=&email=
//
// Two properties of this API drive most of the code below:
//
//  1. Booleans and integers arrive as JSON STRINGS in places
//     ("mx_found":"true", "Credits":"12345"). Decoding them into Go
//     bool/int fails outright, so every such field goes through a
//     tolerant type.
//
//  2. Authentication and quota failures are reported as HTTP 200 with
//     an {"error": "..."} body. Trusting the status code alone would
//     turn an expired key into a list where every address reads
//     "unknown" — the most expensive possible failure mode, because
//     it looks like data rather than an outage.

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ZeroBounce real-time validation origins. Both single and real-time batch
// validation use the primary API host; asynchronous file bulk is out of scope.
const (
	ZeroBounceDefaultBaseURL = zeroBounceOrigin
	ZeroBounceDefaultBulkURL = zeroBounceBulkOrigin
)

const (
	// zeroBounceMaxBatch matches the provider's documented 100-address
	// validatebatch ceiling while bounding one ambiguous request's blast radius.
	zeroBounceMaxBatch = 100
	// ZeroBounce documents up to 70 seconds for validatebatch. Ask the provider
	// to settle within 70 seconds and keep a ten-second total client margin;
	// the ordinary 30-second client remains correct for single validation.
	zeroBounceBatchProviderTimeoutSeconds = 70
	// The provider may use its entire requested 70-second processing window
	// before writing response headers. Keep this above that ceiling but below
	// the total client deadline, leaving five seconds for the response body.
	ZeroBounceBatchResponseHeaderTimeout = 75 * time.Second
	ZeroBounceBatchHTTPTimeout           = 80 * time.Second
)

// ZeroBounceVerifier implements Verifier against ZeroBounce v2.
type ZeroBounceVerifier struct {
	// APIKey is the tenant's key, resolved from the secrets backend
	// at call time. Never logged.
	APIKey string
	// IPAddress is optionally forwarded for geolocation enrichment.
	IPAddress string
	// Now overrides the clock, for tests.
	Now func() time.Time

	// batchPacer reserves one tenant/provider-wide durable validatebatch slot.
	// Production Store wiring sets it; direct adapter tests may leave it nil.
	batchPacer func(context.Context) error

	// testHooks is deliberately unexported and is ignored outside a go test
	// binary. Production origins and transports are never tenant-configurable.
	testHooks *providerTestHooks
}

// Name implements Verifier.
func (z *ZeroBounceVerifier) Name() string { return ProviderZeroBounce }

func (z *ZeroBounceVerifier) baseURL() string {
	if providerTestHooksEnabled() && z.testHooks != nil && z.testHooks.baseURL != "" {
		return strings.TrimSuffix(z.testHooks.baseURL, "/")
	}
	origin, err := officialProviderOrigin(ProviderZeroBounce, providerPrimaryOrigin)
	if err != nil {
		panic(err)
	}
	return origin
}

func (z *ZeroBounceVerifier) bulkURL() string {
	if providerTestHooksEnabled() && z.testHooks != nil && z.testHooks.bulkURL != "" {
		return strings.TrimSuffix(z.testHooks.bulkURL, "/")
	}
	origin, err := officialProviderOrigin(ProviderZeroBounce, providerBulkOrigin)
	if err != nil {
		panic(err)
	}
	return origin
}

func (z *ZeroBounceVerifier) client() *http.Client {
	if providerTestHooksEnabled() && z.testHooks != nil && z.testHooks.client != nil {
		return z.testHooks.client
	}
	return productionProviderHTTPClient(ProviderZeroBounce)
}

func (z *ZeroBounceVerifier) batchClient() *http.Client {
	if providerTestHooksEnabled() && z.testHooks != nil && z.testHooks.client != nil {
		return z.testHooks.client
	}
	return productionZeroBounceBatchHTTPClient()
}

func (z *ZeroBounceVerifier) now() time.Time {
	if z.Now != nil {
		return z.Now()
	}
	return time.Now().UTC()
}

// zbResult is the wire shape of one address verdict.
type zbResult struct {
	Address    string   `json:"address"`
	Status     string   `json:"status"`
	SubStatus  string   `json:"sub_status"`
	FreeEmail  flexBool `json:"free_email"`
	DidYouMean string   `json:"did_you_mean"`
	Account    string   `json:"account"`
	Domain     string   `json:"domain"`
	MXFound    flexBool `json:"mx_found"`
	MXRecord   string   `json:"mx_record"`
	FirstName  string   `json:"firstname"`
	LastName   string   `json:"lastname"`
	Gender     string   `json:"gender"`
	Country    string   `json:"country"`
	City       string   `json:"city"`
	// Error is the in-band failure envelope; present only on failure.
	Error string `json:"error"`
}

type zbBatchError struct {
	Error        string `json:"error"`
	EmailAddress string `json:"email_address"`
}

type zbBatchResponse struct {
	EmailBatch []zbResult     `json:"email_batch"`
	Errors     []zbBatchError `json:"errors"`
	Error      string         `json:"error"`
}

// Verify implements Verifier.
func (z *ZeroBounceVerifier) Verify(ctx context.Context, email string) (Result, error) {
	if strings.TrimSpace(z.APIKey) == "" {
		return Result{}, fmt.Errorf("zerobounce: %w", ErrNotConfigured)
	}

	q := url.Values{}
	q.Set("api_key", z.APIKey)
	q.Set("email", email)
	if z.IPAddress != "" {
		q.Set("ip_address", z.IPAddress)
	}
	endpoint := z.baseURL() + "/v2/validate?" + q.Encode()

	body, err := providerGet(ctx, z.client(), endpoint)
	if err != nil {
		return Result{}, fmt.Errorf("zerobounce validate: %w", err)
	}
	var wire zbResult
	if err := json.Unmarshal(body, &wire); err != nil {
		return Result{}, fmt.Errorf("zerobounce: malformed validate response: %w", ErrProviderPartialOutcome)
	}
	if err := zbMessageError(wire.Error); err != nil {
		if strings.TrimSpace(wire.Address) != "" || strings.TrimSpace(wire.Status) != "" {
			return Result{}, errors.Join(ErrProviderPartialOutcome, err)
		}
		return Result{}, err
	}
	if err := validateZBResult(wire, email); err != nil {
		return Result{}, err
	}
	return z.toResult(wire, email, body), nil
}

// VerifyBatch implements Verifier, chunking to the provider ceiling
// and realigning the response to input order.
func (z *ZeroBounceVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	return z.verifyBatchWithDispatchHook(ctx, emails, nil)
}

func (z *ZeroBounceVerifier) verifyBatchWithDispatchHook(
	ctx context.Context,
	emails []string,
	beforeChunk func(context.Context, []string) error,
) ([]Result, error) {
	if strings.TrimSpace(z.APIKey) == "" {
		return nil, fmt.Errorf("zerobounce: %w", ErrNotConfigured)
	}
	if len(emails) > MaxBatch {
		return nil, ErrBatchTooLarge
	}
	if len(emails) == 0 {
		return []Result{}, nil
	}
	if len(emails) == 1 {
		// Signup and synchronous single verification still enter through Chain's
		// batch method so its pre-egress dispatch receipt is preserved. Route the
		// actual one-address provider call to ZeroBounce's documented single
		// endpoint, whose 30-second client ceiling fits the hosted request budget;
		// validatebatch may legitimately wait 70 seconds before responding.
		if beforeChunk != nil {
			if err := beforeChunk(ctx, append([]string(nil), emails...)); err != nil {
				return nil, fmt.Errorf("zerobounce: persist single dispatch receipt: %w", err)
			}
		}
		result, err := z.Verify(ctx, emails[0])
		if err != nil {
			return nil, err
		}
		return []Result{result}, nil
	}

	// Index by normalized address so an out-of-order or partial
	// response still lands in the caller's slot.
	byAddress := make(map[string]zbResult, len(emails))
	completedChunks := 0

	for start := 0; start < len(emails); start += zeroBounceMaxBatch {
		end := start + zeroBounceMaxBatch
		if end > len(emails) {
			end = len(emails)
		}
		chunk := emails[start:end]

		type entry struct {
			EmailAddress string `json:"email_address"`
			IPAddress    string `json:"ip_address"`
		}
		payload := struct {
			APIKey     string  `json:"api_key"`
			EmailBatch []entry `json:"email_batch"`
			Timeout    int     `json:"timeout"`
		}{
			APIKey: z.APIKey, EmailBatch: make([]entry, 0, len(chunk)),
			Timeout: zeroBounceBatchProviderTimeoutSeconds,
		}
		for _, e := range chunk {
			payload.EmailBatch = append(payload.EmailBatch, entry{EmailAddress: e, IPAddress: z.IPAddress})
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, zeroBounceBatchFailure(completedChunks,
				fmt.Errorf("zerobounce: encode batch: %w", err))
		}
		// Reserve/wait before the durable dispatch receipt. A canceled request or
		// expired job lease therefore cannot leave merely-waiting rows marked as
		// provider-dispatched. The receipt callback runs immediately before egress.
		if z.batchPacer != nil {
			if err := z.batchPacer(ctx); err != nil {
				return nil, zeroBounceBatchFailure(completedChunks, err)
			}
		}
		if beforeChunk != nil {
			if err := beforeChunk(ctx, append([]string(nil), chunk...)); err != nil {
				return nil, zeroBounceBatchFailure(completedChunks,
					fmt.Errorf("zerobounce: persist batch dispatch receipt: %w", err))
			}
		}

		body, err := providerPostJSON(ctx, z.batchClient(), z.bulkURL()+"/v2/validatebatch", raw)
		if err != nil {
			return nil, zeroBounceBatchFailure(completedChunks,
				fmt.Errorf("zerobounce validatebatch: %w", err))
		}
		var resp zbBatchResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, zeroBounceBatchFailure(completedChunks,
				fmt.Errorf("zerobounce: malformed batch response: %w", ErrProviderPartialOutcome))
		}
		if err := zbMessageError(resp.Error); err != nil {
			if len(resp.EmailBatch) > 0 || len(resp.Errors) > 0 {
				err = errors.Join(ErrProviderPartialOutcome, err)
			}
			return nil, zeroBounceBatchFailure(completedChunks, err)
		}
		// ZeroBounce's documented real-time batch failure envelope is an
		// HTTP-200 response with an empty email_batch and an errors entry whose
		// email_address is "all". Classify it before per-address projection so
		// an invalid credential or exhausted account cannot masquerade as a set
		// of harmless, unbillable unknown results.
		if err := zbBatchGlobalError(resp.Errors); err != nil {
			if !zbBatchContainsOnlyGlobalErrors(resp) {
				err = errors.Join(ErrProviderPartialOutcome, err)
			}
			return nil, zeroBounceBatchFailure(completedChunks, err)
		}
		chunkResults, err := validateZBBatchResponse(chunk, resp)
		if err != nil {
			return nil, zeroBounceBatchFailure(completedChunks, err)
		}
		completedChunks++
		for requested, r := range chunkResults {
			byAddress[requested] = r
		}
	}

	missing := 0
	for _, email := range emails {
		if _, ok := byAddress[strings.ToLower(strings.TrimSpace(email))]; !ok {
			missing++
		}
	}
	if missing > 0 {
		// A provider request crossed the metered boundary but did not return a
		// verdict or an explicit per-address rejection for every slot. Its charge
		// state is unknowable, so never synthesize a successful unbillable result.
		return nil, fmt.Errorf("zerobounce: provider omitted %d batch result(s): %w",
			missing, ErrProviderPartialOutcome)
	}

	out := make([]Result, 0, len(emails))
	for _, e := range emails {
		wire := byAddress[strings.ToLower(strings.TrimSpace(e))]
		out = append(out, z.toResult(wire, e, nil))
	}
	return out, nil
}

func zeroBounceBatchFailure(completedChunks int, cause error) error {
	if completedChunks > 0 {
		return errors.Join(ErrProviderPartialOutcome, cause)
	}
	return cause
}

func zbBatchGlobalError(batchErrors []zbBatchError) error {
	for _, batchErr := range batchErrors {
		if strings.EqualFold(strings.TrimSpace(batchErr.EmailAddress), "all") {
			if err := zbMessageError(batchErr.Error); err != nil {
				return err
			}
			return fmt.Errorf("zerobounce: provider reported a batch-wide request failure: %w",
				ErrProviderUnavailable)
		}
	}
	return nil
}

func zbBatchContainsOnlyGlobalErrors(resp zbBatchResponse) bool {
	if len(resp.EmailBatch) != 0 || len(resp.Errors) == 0 {
		return false
	}
	for _, batchErr := range resp.Errors {
		if !strings.EqualFold(strings.TrimSpace(batchErr.EmailAddress), "all") {
			return false
		}
	}
	return true
}

func validateZBResult(result zbResult, requested string) error {
	requested = NormalizeEmail(requested)
	address, leadingPeriodRemoved, ok := matchZBResponseIdentity(result, requested)
	if !ok {
		return fmt.Errorf("zerobounce: validate response address is missing or mismatched: %w",
			ErrProviderPartialOutcome)
	}
	rawStatus, ok := parseZBStatus(result.Status)
	if !ok {
		return fmt.Errorf("zerobounce: validate response status is missing or unsupported: %w",
			ErrProviderPartialOutcome)
	}
	var subStatus SubStatus
	if leadingPeriodRemoved {
		subStatus = SubStatusPossibleTypo
	} else {
		subStatus, ok = parseZBSubStatus(result.SubStatus)
		if !ok {
			return fmt.Errorf("zerobounce: validate response sub-status is unsupported: %w",
				ErrProviderPartialOutcome)
		}
	}
	status, subStatus := canonicalZBProjection(rawStatus, subStatus, leadingPeriodRemoved)
	requestedLocal, _, _ := splitAddress(requested)
	if leadingPeriodRemoved {
		requestedLocal, _, _ = splitProviderTypoAddress(requested)
	}
	addressLocal, _, _ := splitAddress(address)
	if result.Account != "" {
		expectedAccount := requestedLocal
		if leadingPeriodRemoved {
			expectedAccount = addressLocal
		}
		if err := validateProviderResultText("account", result.Account, 64); err != nil ||
			strings.TrimSpace(result.Account) != result.Account ||
			!strings.EqualFold(result.Account, expectedAccount) {
			return invalidProviderResultField("account")
		}
	}
	didYouMean := result.DidYouMean
	if leadingPeriodRemoved {
		if didYouMean != "" && NormalizeEmail(didYouMean) != address {
			return invalidProviderResultField("did_you_mean")
		}
		didYouMean = address
	}
	return validateProviderProjection(Result{
		Email:      requested,
		Status:     status,
		SubStatus:  subStatus,
		Domain:     result.Domain,
		MXRecord:   result.MXRecord,
		DidYouMean: didYouMean,
		FirstName:  result.FirstName,
		LastName:   result.LastName,
		Gender:     result.Gender,
		Country:    result.Country,
		City:       result.City,
		Provider:   ProviderZeroBounce,
		RoleAccount: oneOfSubStatus(subStatus, SubStatusRoleBased,
			SubStatusRoleBasedCatchAll, SubStatusRoleBasedAcceptAll),
		Disposable: subStatus == SubStatusDisposable,
	}, requested)
}

func validateZBBatchResponse(chunk []string, resp zbBatchResponse) (map[string]zbResult, error) {
	if len(resp.Errors) > 0 {
		// The real-time API does not provide a per-address charge receipt for
		// errors[]. Do not invent Billable:false: the request already crossed the
		// metered boundary and a retry could consume the same credit again.
		return nil, fmt.Errorf("zerobounce: batch contains an indeterminate per-address error: %w",
			ErrProviderPartialOutcome)
	}
	expected := make(map[string]struct{}, len(chunk))
	for _, email := range chunk {
		expected[NormalizeEmail(email)] = struct{}{}
	}
	seen := make(map[string]struct{}, len(resp.EmailBatch))
	validAddress := func(result zbResult) (string, bool) {
		requested, ok := requestedForZBBatchResult(result, expected)
		if !ok {
			return "", false
		}
		if _, duplicate := seen[requested]; duplicate {
			return "", false
		}
		seen[requested] = struct{}{}
		return requested, true
	}

	byRequested := make(map[string]zbResult, len(resp.EmailBatch))
	for _, result := range resp.EmailBatch {
		requested, ok := validAddress(result)
		if !ok {
			return nil, fmt.Errorf("zerobounce: batch response contains a missing, duplicate, or foreign address: %w",
				ErrProviderPartialOutcome)
		}
		if err := validateZBResult(result, requested); err != nil {
			return nil, err
		}
		byRequested[requested] = result
	}
	if len(seen) != len(expected) {
		// Validate each provider-sized chunk before dispatching the next one.
		// Continuing after an omitted row could spend another chunk while the
		// first chunk's charge/outcome is already indeterminate.
		return nil, fmt.Errorf("zerobounce: batch response omitted one or more requested addresses: %w",
			ErrProviderPartialOutcome)
	}
	return byRequested, nil
}

func isZBLeadingPeriodRemoved(raw string) bool {
	return strings.EqualFold(strings.TrimSpace(raw), "leading_period_removed")
}

func isZBLeadingPeriodMailboxDomain(domain string) bool {
	return domain == "gmail.com" || domain == "googlemail.com"
}

func matchZBResponseIdentity(result zbResult, requested string) (string, bool, bool) {
	if err := validateProviderResultText("address", result.Address, maxProviderIdentityEmailBytes); err != nil ||
		strings.TrimSpace(result.Address) != result.Address {
		return "", false, false
	}
	address := NormalizeEmail(result.Address)
	if !isZBLeadingPeriodRemoved(result.SubStatus) {
		return address, false, address != "" && address == requested
	}
	requestedLocal, requestedDomain, requestedOK := splitProviderTypoAddress(requested)
	addressLocal, addressDomain, addressOK := splitAddress(address)
	if !requestedOK || !addressOK || !isZBLeadingPeriodMailboxDomain(requestedDomain) ||
		addressDomain != requestedDomain || len(requestedLocal) < 2 ||
		requestedLocal[0] != '.' || addressLocal != requestedLocal[1:] {
		return "", true, false
	}
	return address, true, true
}

func requestedForZBBatchResult(result zbResult, expected map[string]struct{}) (string, bool) {
	address := NormalizeEmail(result.Address)
	if !isZBLeadingPeriodRemoved(result.SubStatus) {
		_, ok := expected[address]
		return address, ok
	}
	local, domain, ok := splitAddress(address)
	if !ok || !isZBLeadingPeriodMailboxDomain(domain) {
		return "", false
	}
	requested := "." + local + "@" + domain
	_, ok = expected[requested]
	return requested, ok
}

func canonicalZBProjection(rawStatus Status, subStatus SubStatus, leadingPeriodRemoved bool) (Status, SubStatus) {
	if leadingPeriodRemoved {
		// Preserve the caller's identity and surface the provider's normalized
		// Gmail address as a suggestion. Declaring the uncorrected request Valid
		// would let downstream sending ignore the rewrite and manufacture an A.
		return StatusInvalid, SubStatusPossibleTypo
	}
	switch {
	case rawStatus == StatusValid && oneOfSubStatus(subStatus,
		SubStatusAcceptAll, SubStatusRoleBasedAcceptAll):
		return StatusCatchAll, subStatus
	case rawStatus == StatusDoNotMail && subStatus == SubStatusRoleBased:
		return StatusUnknown, subStatus
	case rawStatus == StatusDoNotMail && subStatus == SubStatusRoleBasedCatchAll:
		return StatusCatchAll, subStatus
	default:
		return rawStatus, subStatus
	}
}

// Credits implements Verifier.
func (z *ZeroBounceVerifier) Credits(ctx context.Context) (int, error) {
	if strings.TrimSpace(z.APIKey) == "" {
		return 0, fmt.Errorf("zerobounce: %w", ErrNotConfigured)
	}
	q := url.Values{}
	q.Set("api_key", z.APIKey)
	body, err := providerGet(ctx, z.client(), z.baseURL()+"/v2/getcredits?"+q.Encode())
	if err != nil {
		return 0, fmt.Errorf("zerobounce getcredits: %w", err)
	}
	if err := zbEnvelopeError(body); err != nil {
		return 0, err
	}
	var resp struct {
		Credits string `json:"Credits"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, fmt.Errorf("zerobounce: decode credits: %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(resp.Credits))
	if err != nil {
		return 0, fmt.Errorf("zerobounce: provider returned an invalid credit balance: %w", ErrProviderUnavailable)
	}
	// Documented sentinel: -1 means the key was not accepted.
	if n < 0 {
		return 0, fmt.Errorf("zerobounce getcredits: %w", ErrUnauthorized)
	}
	return n, nil
}

// Activity returns how recently the address was seen active in
// ZeroBounce's engagement corpus. This is the one capability with no
// first-party equivalent: it reports on addresses we have never
// mailed, which our own engagement data by definition cannot.
//
// Returns (days, found, error). days is 0 when found is false.
func (z *ZeroBounceVerifier) Activity(ctx context.Context, email string) (int, bool, error) {
	if strings.TrimSpace(z.APIKey) == "" {
		return 0, false, fmt.Errorf("zerobounce: %w", ErrNotConfigured)
	}
	q := url.Values{}
	q.Set("api_key", z.APIKey)
	q.Set("email", email)
	body, err := providerGet(ctx, z.client(), z.baseURL()+"/v2/activity?"+q.Encode())
	if err != nil {
		return 0, false, fmt.Errorf("zerobounce activity: %w", err)
	}
	if err := zbEnvelopeError(body); err != nil {
		return 0, false, err
	}
	var resp struct {
		Found        flexBool `json:"found"`
		ActiveInDays string   `json:"active_in_days"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, false, fmt.Errorf("zerobounce: decode activity: %w", err)
	}
	if !bool(resp.Found) {
		return 0, false, nil
	}
	days, err := strconv.Atoi(strings.TrimSpace(resp.ActiveInDays))
	if err != nil {
		return 0, true, nil
	}
	return days, true, nil
}

// toResult maps the wire shape onto the canonical Result.
func (z *ZeroBounceVerifier) toResult(w zbResult, requested string, raw json.RawMessage) Result {
	email := NormalizeEmail(requested)
	_, requestedDomain, _ := splitAddress(email)
	rawStatus, _ := parseZBStatus(w.Status)
	leadingPeriodRemoved := isZBLeadingPeriodRemoved(w.SubStatus)
	subStatus := zbSubStatus(w.SubStatus)
	if leadingPeriodRemoved {
		subStatus = SubStatusPossibleTypo
	}
	status, subStatus := canonicalZBProjection(rawStatus, subStatus, leadingPeriodRemoved)
	didYouMean := w.DidYouMean
	if leadingPeriodRemoved {
		didYouMean = NormalizeEmail(w.Address)
	}
	didYouMean, _ = canonicalProviderSuggestion(didYouMean)
	res := Result{
		Email:      email,
		Status:     status,
		SubStatus:  subStatus,
		Domain:     requestedDomain,
		FreeEmail:  bool(w.FreeEmail),
		MXFound:    bool(w.MXFound),
		MXRecord:   w.MXRecord,
		DidYouMean: didYouMean,
		FirstName:  w.FirstName,
		LastName:   w.LastName,
		Gender:     w.Gender,
		Country:    w.Country,
		City:       w.City,
		Provider:   ProviderZeroBounce,
		// ZeroBounce's v2 contract does not consume a credit for unknown
		// results. Preserve measured spend rather than counting every request.
		Billable:  rawStatus != StatusUnknown,
		CheckedAt: z.now(),
		Raw:       raw,
		RoleAccount: oneOfSubStatus(subStatus, SubStatusRoleBased,
			SubStatusRoleBasedCatchAll, SubStatusRoleBasedAcceptAll),
		Disposable: subStatus == SubStatusDisposable,
	}
	return res
}

// parseZBStatus maps the provider's closed success vocabulary onto ours. The
// boolean distinguishes documented "unknown" (a settled, unbilled response)
// from a missing/new value whose charge and meaning are indeterminate.
func parseZBStatus(s string) (Status, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "valid":
		return StatusValid, true
	case "invalid":
		return StatusInvalid, true
	case "catch-all", "catch_all", "catchall":
		return StatusCatchAll, true
	case "spamtrap", "spam_trap":
		return StatusSpamtrap, true
	case "abuse":
		return StatusAbuse, true
	case "do_not_mail", "donotmail":
		return StatusDoNotMail, true
	case "unknown":
		return StatusUnknown, true
	default:
		return StatusUnknown, false
	}
}

// zbSubStatus passes through codes that are already in our closed set
// and drops anything else. The sub-status is advisory; an unknown code
// is better represented as absent than as a value nothing can switch
// on.
func zbSubStatus(s string) SubStatus {
	c, _ := parseZBSubStatus(s)
	return c
}

func parseZBSubStatus(s string) (SubStatus, bool) {
	c := SubStatus(strings.ToLower(strings.TrimSpace(s)))
	switch c {
	case SubStatusNone,
		SubStatusSyntaxInvalid, SubStatusNoDNSEntries, SubStatusPossibleTypo,
		SubStatusDisposable, SubStatusRoleBased, SubStatusToxic,
		SubStatusAliasAddress, SubStatusAlternate, SubStatusGold,
		SubStatusAIAgentMailbox, SubStatusMailboxNotFound,
		SubStatusMailboxQuotaExceeded, SubStatusGlobalSuppression,
		SubStatusPossibleTrap, SubStatusRoleBasedCatchAll,
		SubStatusRoleBasedAcceptAll, SubStatusDoesNotAcceptMail,
		SubStatusUnroutableIPAddress, SubStatusAcceptAll, SubStatusMXForward,
		SubStatusAntispamSystem, SubStatusGreylisted,
		SubStatusServerTemporaryError, SubStatusServerDidNotRespond,
		SubStatusForcibleDisconnect, SubStatusTimeoutExceeded,
		SubStatusFailedSMTPConnection, SubStatusExceptionOccurred:
		return c, true
	default:
		// no_mailbox_probe and provider_unavailable are Moosewave receipts, not
		// ZeroBounce wire values. Keep the raw provider vocabulary independently
		// closed so adding a canonical code for another adapter cannot silently
		// make a new ZeroBounce response look settled.
		return SubStatusNone, false
	}
}

// zbEnvelopeError converts the in-band {"error": "..."} body into a
// typed error. The provider's documented combined key-or-credit message is
// deliberately not guessed into either state: only the provider can know which
// condition applies.
func zbEnvelopeError(body []byte) error {
	var probe struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil // not an error envelope; let the real decode report
	}
	return zbMessageError(probe.Error)
}

func zbMessageError(message string) error {
	msg := strings.TrimSpace(message)
	if msg == "" {
		return nil
	}
	lower := strings.ToLower(msg)
	hasCredits := strings.Contains(lower, "credit")
	hasCredential := strings.Contains(lower, "api key") || strings.Contains(lower, "apikey") ||
		strings.Contains(lower, "unauthorized")
	switch {
	case hasCredits && hasCredential:
		return fmt.Errorf("zerobounce: provider rejected the configured account: %w",
			ErrProviderAccountRejected)
	case hasCredits:
		return fmt.Errorf("zerobounce: provider reported exhausted credits: %w", ErrNoCredits)
	case hasCredential:
		return fmt.Errorf("zerobounce: provider rejected the credential: %w", ErrUnauthorized)
	default:
		return fmt.Errorf("zerobounce: provider reported a request failure: %w", ErrProviderUnavailable)
	}
}

// --- shared driver plumbing ---

// DefaultProviderTimeout bounds a single vendor HTTP call.
const DefaultProviderTimeout = 30 * time.Second

// maxProviderResponse caps how much of a vendor response we buffer, so
// a misbehaving or hostile endpoint cannot exhaust memory.
const maxProviderResponse = 8 << 20 // 8 MiB

func providerGet(ctx context.Context, client *http.Client, endpoint string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		// Request-construction errors can quote the complete URL. Both
		// supported providers authenticate in that URL, so the endpoint must
		// be treated as secret-bearing even before any network call occurs.
		return nil, fmt.Errorf("%w: request could not be constructed", ErrProviderUnavailable)
	}
	req.Header.Set("Accept", "application/json")
	return providerDo(client, req)
}

func providerPostJSON(ctx context.Context, client *http.Client, endpoint string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: request could not be constructed", ErrProviderUnavailable)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	return providerDo(client, req)
}

func providerDo(client *http.Client, req *http.Request) ([]byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		// net/http errors commonly embed the full request URL. Both supported
		// vendors authenticate in that URL, so never wrap the raw error.
		return nil, fmt.Errorf("%w: request failed", ErrProviderUnavailable)
	}
	defer func() { _ = resp.Body.Close() }()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
	if readErr != nil {
		return nil, fmt.Errorf("%w: response read failed", ErrProviderUnavailable)
	}
	if len(body) > maxProviderResponse {
		return nil, fmt.Errorf("%w: response exceeded the size limit", ErrProviderUnavailable)
	}

	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return nil, ErrUnauthorized
	case resp.StatusCode == http.StatusPaymentRequired:
		return nil, ErrNoCredits
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, fmt.Errorf("%w: rate limited", ErrProviderUnavailable)
	case resp.StatusCode >= 500:
		return nil, fmt.Errorf("%w: upstream status %d", ErrProviderUnavailable, resp.StatusCode)
	case resp.StatusCode >= 400:
		return nil, fmt.Errorf("%w: upstream status %d", ErrProviderUnavailable, resp.StatusCode)
	}
	return body, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// flexBool decodes a JSON boolean that a provider may send either as a
// real bool or as the string "true"/"false".
type flexBool bool

func (f *flexBool) UnmarshalJSON(data []byte) error {
	s := strings.Trim(strings.TrimSpace(string(data)), `"`)
	switch strings.ToLower(s) {
	case "true", "1":
		*f = true
	case "false", "0", "null", "":
		*f = false
	default:
		return errors.New("verification: provider returned an invalid boolean")
	}
	return nil
}
