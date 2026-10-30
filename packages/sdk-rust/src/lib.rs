//! Official Rust client for the Moosewave API.
//!
//! ```no_run
//! let client = postwave::Client::new("pw_live_…");
//! let res = client.emails().send(postwave::SendEmail {
//!     from: Some("you@you.com".into()),
//!     to: vec!["user@example.com".into()],
//!     subject: "Hi".into(),
//!     html: Some("<b>Hello</b>".into()),
//!     ..Default::default()
//! }).unwrap();
//! ```

mod emails;
mod subscribers;
pub mod webhook;

pub use emails::{Attachment, EmailRecord, Emails, SendEmail, SendResult, Tag};
pub use subscribers::Subscribers;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_BASE_URL: &str = "https://api.moosewave.com";

/// A typed API error: the HTTP status plus the server's error envelope.
#[derive(Debug, Clone)]
pub struct Error {
    pub status: u16,
    pub code: Option<String>,
    pub message: String,
    pub request_id: Option<String>,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "postwave: {} {}", self.status, self.message)
    }
}
impl std::error::Error for Error {}

/// The Moosewave API client.
#[derive(Clone)]
pub struct Client {
    api_key: String,
    base_url: String,
    agent: ureq::Agent,
    max_retries: u32,
}

impl Client {
    /// Build a client with your `pw_live_…` key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Client {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build(),
            max_retries: 3,
        }
    }

    /// Override the API base URL.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into().trim_end_matches('/').to_string();
        self
    }

    /// Override the retry count for 429/5xx.
    pub fn with_max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    /// The transactional email resource.
    pub fn emails(&self) -> Emails<'_> {
        Emails { client: self }
    }

    /// The subscribers resource.
    pub fn subscribers(&self) -> Subscribers<'_> {
        Subscribers { client: self }
    }

    pub(crate) fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Error> {
        let url = format!("{}{}", self.base_url, path);
        let idem = matches!(method, "POST" | "PUT" | "PATCH" | "DELETE").then(idempotency_key);

        let mut attempt = 0u32;
        loop {
            if attempt > 0 {
                std::thread::sleep(backoff(attempt));
            }
            let mut req = self
                .agent
                .request(method, &url)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Accept", "application/json")
                .set("User-Agent", "postwave-rust/0.1.0");
            if let Some(k) = &idem {
                req = req.set("Idempotency-Key", k);
            }

            let result = match &body {
                Some(b) => req.send_json(b.clone()),
                None => req.call(),
            };

            match result {
                Ok(resp) => {
                    return resp
                        .into_json::<serde_json::Value>()
                        .or(Ok(serde_json::Value::Null));
                }
                Err(ureq::Error::Status(status, resp)) => {
                    let err = parse_error(status, resp);
                    let retriable = status == 429 || (status >= 500 && status != 501);
                    if retriable && attempt < self.max_retries {
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
                Err(ureq::Error::Transport(t)) => {
                    if attempt < self.max_retries {
                        attempt += 1;
                        continue;
                    }
                    return Err(Error {
                        status: 0,
                        code: Some("transport".into()),
                        message: t.to_string(),
                        request_id: None,
                    });
                }
            }
        }
    }
}

fn parse_error(status: u16, resp: ureq::Response) -> Error {
    let body: serde_json::Value = resp.into_json().unwrap_or(serde_json::Value::Null);
    let e = body.get("error");
    Error {
        status,
        code: e.and_then(|x| x.get("code")).and_then(|x| x.as_str()).map(String::from),
        message: e
            .and_then(|x| x.get("message"))
            .and_then(|x| x.as_str())
            .unwrap_or("request failed")
            .to_string(),
        request_id: e
            .and_then(|x| x.get("request_id"))
            .and_then(|x| x.as_str())
            .map(String::from),
    }
}

fn backoff(attempt: u32) -> std::time::Duration {
    let ms = (200u64 * 2u64.pow(attempt.saturating_sub(1))).min(5000);
    std::time::Duration::from_millis(ms)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn idempotency_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rs_{:016x}{:08x}", nanos, n)
}
