//! Canonical timestamped outbound-webhook HMAC verification.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

/// Compute the lowercase v1 HMAC of `timestamp + "." + exact raw body`.
pub fn compute(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

pub fn compute_header(secret: &str, timestamp: i64, body: &[u8]) -> String {
    format!("t={timestamp},v1={}", compute(secret, timestamp, body))
}

/// Verify with the recommended five-minute replay window.
pub fn verify(header: &str, secret: &str, body: &[u8]) -> bool {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_secs() as i64,
        Err(_) => return false,
    };
    verify_at(header, secret, body, now, 300)
}

/// Deterministic verifier for tests or a custom replay tolerance.
pub fn verify_at(
    header: &str,
    secret: &str,
    body: &[u8],
    now_unix_seconds: i64,
    tolerance_seconds: i64,
) -> bool {
    if secret.is_empty() || now_unix_seconds < 0 || tolerance_seconds < 0 {
        return false;
    }
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for raw_part in header.split(',') {
        let Some((key, value)) = raw_part.trim().split_once('=') else {
            continue;
        };
        match key {
            "t" if timestamp.is_some() => return false,
            "t" => timestamp = value.parse::<i64>().ok(),
            "v1" => signatures.push(value),
            _ => {}
        }
    }
    let Some(signed_at) = timestamp else {
        return false;
    };
    if signed_at <= 0 {
        return false;
    }
    if tolerance_seconds > 0
        && now_unix_seconds.abs_diff(signed_at) > tolerance_seconds as u64
    {
        return false;
    }
    signatures.into_iter().any(|signature| {
        let Ok(supplied) = hex::decode(signature) else {
            return false;
        };
        let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
            Ok(value) => value,
            Err(_) => return false,
        };
        mac.update(signed_at.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);
        mac.verify_slice(&supplied).is_ok()
    })
}
