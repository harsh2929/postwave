# Moosewave Java SDK

Official Java client for the [Moosewave](https://moosewave.com) API. JDK 11+, zero runtime dependencies.

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```java
Moosewave client = new Moosewave("pw_live_…");
client.emails.send(Map.of(
    "from", "you@yourdomain.com",
    "to", List.of("user@example.com"),
    "subject", "Welcome",
    "html", "<b>Hello!</b>"));
```

Resources: `client.emails` (send / sendBatch / get / list), `client.subscribers` (CRUD).
Webhook verification: `Webhook.verify(header, secret, body)`.
