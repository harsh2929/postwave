# Moosewave Rust SDK

Official Rust client for the [Moosewave](https://moosewave.com) API.

> **Limited SDK surface:** This is a stub-tier client with a deliberately limited
> resource set. It does not provide full OpenAPI endpoint coverage or a generic
> API request client. Use the TypeScript, Python, or PHP SDK for full-tier coverage.

```rust
let client = postwave::Client::new("pw_live_…");
let res = client.emails().send(postwave::SendEmail {
    from: Some("you@yourdomain.com".into()),
    to: vec!["user@example.com".into()],
    subject: "Welcome".into(),
    html: Some("<b>Hello!</b>".into()),
    ..Default::default()
})?;
```

Resources: `client.emails()` (send / send_batch / get / list), `client.subscribers()` (CRUD).
Webhook verification: `postwave::webhook::verify(header, secret, body)`.
