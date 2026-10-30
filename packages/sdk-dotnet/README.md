# Moosewave .NET SDK

Official .NET client for the [Moosewave](https://moosewave.com) API. Zero external dependencies (.NET 6+).

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```csharp
var client = new PostwaveClient("pw_live_…");
await client.Emails.SendAsync(new SendEmailInput {
    From = "you@yourdomain.com",
    To = new[] { "user@example.com" },
    Subject = "Welcome",
    Html = "<b>Hello!</b>"
});
```

Resources: `client.Emails` (SendAsync / SendBatchAsync / GetAsync / ListAsync), `client.Subscribers` (CRUD).
Webhook verification: `Webhook.Verify(header, secret, body)`.
