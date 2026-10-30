# Moosewave Go SDK

Official Go client for the [Moosewave](https://moosewave.com) API.

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```go
import "github.com/postwave/postwave-go"

client := postwave.New("pw_live_…")
res, err := client.Emails.Send(ctx, &postwave.SendEmailInput{
    From: "you@yourdomain.com", To: []string{"user@example.com"},
    Subject: "Welcome", HTML: "<b>Hello!</b>",
})
```

Resources: `Emails` (Send / SendBatch / Get / List), `Subscribers` (CRUD).
Webhook verification: `postwave.VerifyWebhook(header, secret, body)`.

Server-side conversions use a separate key-bound HMAC credential and never
send the dashboard bearer or a tenant header:

```go
client := postwave.New("")
receipt, err := client.ConversionIngest.Ingest(ctx, &postwave.SignedConversionInput{
    EventName: "purchase",
    Identity: postwave.SignedConversionIdentity{ExternalID: "customer-123"},
}, postwave.SignedConversionCredentials{
    KeyID: "orders-primary", Secret: os.Getenv("POSTWAVE_CONVERSION_SECRET"),
}, postwave.SignedConversionIngestOptions{IdempotencyKey: "order-123"})
```

`IngestBatch` commits 1–500 items atomically. Use `json.Number` for an exact
major-unit decimal value; plaintext email is not part of the typed input.
Auto-retries 429/5xx (honoring Retry-After) and auto-mints an Idempotency-Key on writes.

Admin callers manage these HMAC credentials through
`client.ConversionIngestSecrets.List`, `Issue`, and `Revoke`. `List` returns one
page of at most 100 metadata rows and never auto-walks. `Issue` is reveal-once:
it makes exactly one attempt and sends no `Idempotency-Key`. If its result is
ambiguous, never retry blindly—list the register, identify any newly issued
key ID, revoke it, and then issue a replacement. The CLI intentionally exposes
no mint command.
