use crate::{Client, Error};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// One file on a message. Set exactly one of `content` (base64) or `path`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Attachment {
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
}

/// A per-message tag.
#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub name: String,
    pub value: String,
}

/// Body of a send. One of `html`/`text` is required.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SendEmail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub to: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bcc: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reply_to: Vec<String>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<Tag>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
}

/// Result of a send.
#[derive(Debug, Clone, Deserialize)]
pub struct SendResult {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub suppressed: Option<u32>,
}

/// A transactional email status record.
#[derive(Debug, Clone, Deserialize)]
pub struct EmailRecord {
    pub id: String,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub status: String,
    #[serde(default)]
    pub source: Option<String>,
}

/// The transactional email API.
pub struct Emails<'a> {
    pub(crate) client: &'a Client,
}

impl Emails<'_> {
    /// Send one transactional email.
    pub fn send(&self, input: SendEmail) -> Result<SendResult, Error> {
        let v = self
            .client
            .request("POST", "/api/v1/emails", Some(serde_json::to_value(input).unwrap()))?;
        Ok(serde_json::from_value(v).map_err(decode_err)?)
    }

    /// Send up to 100 distinct emails in one call.
    pub fn send_batch(&self, emails: Vec<SendEmail>) -> Result<Vec<SendResult>, Error> {
        let v = self
            .client
            .request("POST", "/api/v1/emails/batch", Some(json!({ "emails": emails })))?;
        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
        Ok(serde_json::from_value(data).unwrap_or_default())
    }

    /// Fetch one email's status.
    pub fn get(&self, id: &str) -> Result<EmailRecord, Error> {
        let path = format!("/api/v1/emails/{}", urlencode(id));
        let v = self.client.request("GET", &path, None)?;
        Ok(serde_json::from_value(v).map_err(decode_err)?)
    }

    /// List recent transactional sends.
    pub fn list(&self, limit: Option<u32>) -> Result<Vec<EmailRecord>, Error> {
        let path = match limit {
            Some(n) => format!("/api/v1/emails?limit={}", n),
            None => "/api/v1/emails".to_string(),
        };
        let v = self.client.request("GET", &path, None)?;
        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
        Ok(serde_json::from_value(data).unwrap_or_default())
    }
}

fn decode_err(e: serde_json::Error) -> Error {
    Error {
        status: 0,
        code: Some("decode".into()),
        message: e.to_string(),
        request_id: None,
    }
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}
