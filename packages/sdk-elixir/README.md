# Moosewave Elixir SDK

Official Elixir client for the [Moosewave](https://moosewave.com) API.

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```elixir
client = Moosewave.new("pw_live_…")

Moosewave.Emails.send(client,
  from: "you@yourdomain.com", to: "user@example.com",
  subject: "Welcome", html: "<b>Hello!</b>")
```

Resources: `Moosewave.Emails` (send / send_batch / get / list), `Moosewave.Subscribers` (CRUD).
Webhook verification: `Moosewave.Webhook.verify(header, secret, raw_body)`.
