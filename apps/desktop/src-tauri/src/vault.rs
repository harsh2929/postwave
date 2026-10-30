//! Native AES-GCM boundary for the renderer's encrypted offline cache.
//!
//! The renderer stores ciphertext envelopes, but the 256-bit key never
//! crosses IPC. Existing v1 WebCrypto envelopes remain compatible.

use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use zeroize::Zeroize;

use crate::ipc_guard::ensure_main_bundled_window;

const SECRET_SERVICE: &str = "com.moosewave.desktop";
const VAULT_ACCOUNT: &str = "vault_key";
const MAX_PLAINTEXT_BYTES: usize = 512 * 1024;
const MAX_ENVELOPE_BYTES: usize = 768 * 1024;

pub struct VaultState {
    key_lock: Mutex<()>,
    ephemeral_demo_key: Option<[u8; 32]>,
}

impl Default for VaultState {
    fn default() -> Self {
        #[cfg(debug_assertions)]
        let ephemeral_demo_key = ephemeral_demo_vault_key();
        #[cfg(not(debug_assertions))]
        let ephemeral_demo_key = None;
        Self {
            key_lock: Mutex::new(()),
            ephemeral_demo_key,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct VaultEnvelope {
    alg: String,
    iv: String,
    data: String,
}

#[tauri::command]
pub fn vault_seal(
    window: WebviewWindow,
    state: State<'_, VaultState>,
    plaintext: String,
) -> Result<String, String> {
    ensure_main_bundled_window(&window, "Local vault")?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err("Encrypted local vault item is too large".to_string());
    }
    let _guard = state
        .key_lock
        .lock()
        .map_err(|_| "Local vault is unavailable".to_string())?;
    let mut key = resolve_key(&state)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| "Local vault key is invalid".to_string())?;
    let mut iv = [0u8; 12];
    getrandom::fill(&mut iv).map_err(|_| "Could not generate vault nonce".to_string())?;
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .map_err(|_| "Could not encrypt local vault item".to_string())?;
    key.zeroize();
    let envelope = serde_json::to_string(&VaultEnvelope {
        alg: "AES-GCM".to_string(),
        iv: B64.encode(iv),
        data: B64.encode(encrypted),
    })
    .map_err(|error| error.to_string())?;
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err("Encrypted local vault envelope is too large".to_string());
    }
    Ok(envelope)
}

#[tauri::command]
pub fn vault_open(
    window: WebviewWindow,
    state: State<'_, VaultState>,
    envelope: String,
) -> Result<Option<String>, String> {
    ensure_main_bundled_window(&window, "Local vault")?;
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Ok(None);
    }
    let parsed: VaultEnvelope = match serde_json::from_str(&envelope) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if parsed.alg != "AES-GCM" {
        return Ok(None);
    }
    let iv = match B64.decode(parsed.iv) {
        Ok(value) if value.len() == 12 => value,
        _ => return Ok(None),
    };
    let data = match B64.decode(parsed.data) {
        Ok(value) if value.len() <= MAX_PLAINTEXT_BYTES + 16 => value,
        _ => return Ok(None),
    };
    let _guard = state
        .key_lock
        .lock()
        .map_err(|_| "Local vault is unavailable".to_string())?;
    let mut key = match read_key(&state)? {
        Some(value) => value,
        None => return Ok(None),
    };
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| "Local vault key is invalid".to_string())?;
    let plaintext = match cipher.decrypt(Nonce::from_slice(&iv), data.as_ref()) {
        Ok(value) if value.len() <= MAX_PLAINTEXT_BYTES => value,
        _ => {
            key.zeroize();
            return Ok(None);
        }
    };
    key.zeroize();
    Ok(String::from_utf8(plaintext).ok())
}

#[tauri::command]
pub fn vault_purge_key(window: WebviewWindow, state: State<'_, VaultState>) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Local vault")?;
    let _guard = state
        .key_lock
        .lock()
        .map_err(|_| "Local vault is unavailable".to_string())?;
    if state.ephemeral_demo_key.is_some() {
        return Ok(());
    }
    match keyring::Entry::new(SECRET_SERVICE, VAULT_ACCOUNT)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn resolve_key(state: &VaultState) -> Result<Vec<u8>, String> {
    if let Some(key) = read_key(state)? {
        return Ok(key);
    }
    let mut key = vec![0u8; 32];
    getrandom::fill(&mut key).map_err(|_| "Could not generate local vault key".to_string())?;
    let encoded = B64.encode(&key);
    keyring::Entry::new(SECRET_SERVICE, VAULT_ACCOUNT)
        .map_err(|error| error.to_string())?
        .set_password(&encoded)
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn read_key(state: &VaultState) -> Result<Option<Vec<u8>>, String> {
    if let Some(key) = state.ephemeral_demo_key {
        return Ok(Some(key.to_vec()));
    }
    let entry =
        keyring::Entry::new(SECRET_SERVICE, VAULT_ACCOUNT).map_err(|error| error.to_string())?;
    let encoded = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    match B64.decode(encoded) {
        Ok(value) if value.len() == 32 => Ok(Some(value)),
        _ => Ok(None),
    }
}

/// Keep fixture-backed debug walkthroughs fully process-local. Ordinary debug
/// sessions and every release build continue to use the native credential
/// store; only the explicit launcher profile receives this random key.
#[cfg(debug_assertions)]
fn ephemeral_demo_vault_key() -> Option<[u8; 32]> {
    if std::env::var("POSTWAVE_DESKTOP_DEMO").ok().as_deref() != Some("1") {
        return None;
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).ok()?;
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_webcrypto_envelope_shape_is_accepted() {
        let envelope: VaultEnvelope = serde_json::from_str(
            r#"{"alg":"AES-GCM","iv":"AAAAAAAAAAAAAAAA","data":"AA==","written_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(envelope.alg, "AES-GCM");
    }

    #[test]
    fn envelope_serialization_never_contains_key_material() {
        let envelope = VaultEnvelope {
            alg: "AES-GCM".to_string(),
            iv: B64.encode([1u8; 12]),
            data: B64.encode([2u8; 32]),
        };
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert_eq!(encoded.matches(':').count(), 3);
        assert!(!encoded.contains("key"));
    }
}
