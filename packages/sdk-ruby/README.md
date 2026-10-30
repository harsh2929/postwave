# Moosewave Ruby SDK

Official Ruby client for the [Moosewave](https://moosewave.com) API. Pure stdlib — no runtime dependencies.

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```ruby
require "postwave"

client = Moosewave::Client.new(api_key: "pw_live_…")
client.emails.send(
  from: "you@yourdomain.com", to: "user@example.com",
  subject: "Welcome", html: "<b>Hello!</b>"
)
```

Resources: `client.emails` (send / send_batch / get / list), `client.subscribers` (CRUD).
Webhook verification: `Moosewave::Webhook.verify(header, secret, raw_body)`.
