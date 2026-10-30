//! Picker-scoped, crash-safe file export bridge.
//!
//! The renderer cannot write arbitrary filesystem paths. The official dialog
//! plugin adds only the path explicitly selected by the operator to the fs
//! runtime scope; `transfer_begin_save` verifies that grant, then owns a
//! bounded chunked write into a private sibling temp file. `finish` fsyncs and
//! atomically replaces the selected destination. Reveal accepts an opaque
//! transfer id, never a renderer-supplied path.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tauri_plugin_opener::OpenerExt;

use crate::ipc_guard::ensure_main_bundled_window;

const MAX_ACTIVE_TRANSFERS: usize = 8;
const MAX_COMPLETED_TRANSFERS: usize = 32;
const MAX_TRANSFER_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 512 * 1024;
const STALE_TRANSFER_AGE: Duration = Duration::from_secs(60 * 60);

#[cfg(test)]
static TEST_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct WriteSession {
    picker_path: PathBuf,
    target_path: PathBuf,
    temp_path: PathBuf,
    file: File,
    expected_bytes: u64,
    written_bytes: u64,
    started: Instant,
}

#[derive(Clone)]
struct CompletedTransfer {
    id: String,
    path: PathBuf,
    completed: Instant,
}

#[derive(Default)]
struct TransferInner {
    active: HashMap<String, WriteSession>,
    completed: VecDeque<CompletedTransfer>,
}

#[derive(Default)]
pub struct FileTransferState(Mutex<TransferInner>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSaveRequest {
    target_path: String,
    expected_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSaveResponse {
    transfer_id: String,
    collision: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteChunkResponse {
    written_bytes: u64,
    expected_bytes: u64,
}

#[tauri::command]
pub fn transfer_begin_save<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, FileTransferState>,
    request: BeginSaveRequest,
) -> Result<BeginSaveResponse, String> {
    ensure_main_bundled_window(&window, "File export")?;
    let picker_path = PathBuf::from(request.target_path);
    let result = (|| {
        if request.expected_bytes > MAX_TRANSFER_BYTES {
            return Err("transfer_too_large".to_string());
        }

        let target_path = validate_picker_path(picker_path.clone())?;
        if !app.fs_scope().is_allowed(&target_path) {
            return Err("transfer_path_not_picker_granted".to_string());
        }

        let collision = target_path.exists();
        if collision {
            let metadata = fs::symlink_metadata(&target_path)
                .map_err(|_| "transfer_target_unavailable".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("transfer_target_not_regular_file".to_string());
            }
        }

        let mut inner = state
            .0
            .lock()
            .map_err(|_| "transfer_state_unavailable".to_string())?;
        for (stale_picker_path, stale_target_path) in cleanup_stale(&mut inner) {
            let _ = revoke_picker_scope(&app, &stale_picker_path, Some(&stale_target_path));
        }
        if inner.active.len() >= MAX_ACTIVE_TRANSFERS {
            return Err("transfer_capacity_reached".to_string());
        }

        let id = new_transfer_id()?;
        let temp_path = sibling_temp_path(&target_path, &id)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&temp_path)
            .map_err(|_| "transfer_temp_create_failed".to_string())?;

        inner.active.insert(
            id.clone(),
            WriteSession {
                picker_path: picker_path.clone(),
                target_path,
                temp_path,
                file,
                expected_bytes: request.expected_bytes,
                written_bytes: 0,
                started: Instant::now(),
            },
        );

        Ok(BeginSaveResponse {
            transfer_id: id,
            collision,
        })
    })();

    if result.is_err() {
        let _ = revoke_picker_scope(&app, &picker_path, None);
    }
    result
}

#[tauri::command]
pub fn transfer_write_chunk(
    window: WebviewWindow,
    state: State<'_, FileTransferState>,
    transfer_id: String,
    offset: u64,
    chunk: Vec<u8>,
) -> Result<WriteChunkResponse, String> {
    ensure_main_bundled_window(&window, "File export")?;
    if chunk.is_empty() || chunk.len() > MAX_CHUNK_BYTES {
        return Err("transfer_invalid_chunk".to_string());
    }
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "transfer_state_unavailable".to_string())?;
    let session = inner
        .active
        .get_mut(&transfer_id)
        .ok_or_else(|| "transfer_not_found".to_string())?;
    if offset != session.written_bytes {
        return Err("transfer_invalid_offset".to_string());
    }
    let next = offset
        .checked_add(chunk.len() as u64)
        .ok_or_else(|| "transfer_size_overflow".to_string())?;
    if next > session.expected_bytes {
        return Err("transfer_exceeds_expected_size".to_string());
    }
    session
        .file
        .write_all(&chunk)
        .map_err(|_| "transfer_write_failed".to_string())?;
    session.written_bytes = next;
    Ok(WriteChunkResponse {
        written_bytes: next,
        expected_bytes: session.expected_bytes,
    })
}

#[tauri::command]
pub fn transfer_finish_save<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, FileTransferState>,
    transfer_id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "File export")?;
    let session = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "transfer_state_unavailable".to_string())?;
        let complete = inner
            .active
            .get(&transfer_id)
            .map(|session| session.written_bytes == session.expected_bytes)
            .ok_or_else(|| "transfer_not_found".to_string())?;
        if !complete {
            return Err("transfer_incomplete".to_string());
        }
        inner
            .active
            .remove(&transfer_id)
            .ok_or_else(|| "transfer_not_found".to_string())?
    };

    let picker_path = session.picker_path.clone();
    let target_path = session.target_path.clone();
    let temp_path = session.temp_path.clone();
    if let Err(error) = finish_session(session) {
        let _ = fs::remove_file(&temp_path);
        let _ = revoke_picker_scope(&app, &picker_path, Some(&target_path));
        return Err(error);
    }
    let _ = revoke_picker_scope(&app, &picker_path, Some(&target_path));

    let mut inner = state
        .0
        .lock()
        .map_err(|_| "transfer_state_unavailable".to_string())?;
    inner.completed.push_front(CompletedTransfer {
        id: transfer_id,
        path: target_path,
        completed: Instant::now(),
    });
    while inner.completed.len() > MAX_COMPLETED_TRANSFERS {
        inner.completed.pop_back();
    }
    Ok(())
}

#[tauri::command]
pub fn transfer_cancel_save<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, FileTransferState>,
    transfer_id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "File export")?;
    let session = state
        .0
        .lock()
        .map_err(|_| "transfer_state_unavailable".to_string())?
        .active
        .remove(&transfer_id);
    if let Some(session) = session {
        let picker_path = session.picker_path.clone();
        let target_path = session.target_path.clone();
        drop(session.file);
        let _ = fs::remove_file(session.temp_path);
        let _ = revoke_picker_scope(&app, &picker_path, Some(&target_path));
    }
    Ok(())
}

#[tauri::command]
pub fn transfer_revoke_picker_path<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    path: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "File picker scope")?;
    let picker_path = PathBuf::from(path);
    let normalized_path = validate_picker_path(picker_path.clone())?;
    revoke_picker_scope(&app, &picker_path, Some(&normalized_path))
}

#[tauri::command]
pub fn transfer_reveal_saved<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, FileTransferState>,
    transfer_id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Reveal exported file")?;
    let path = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "transfer_state_unavailable".to_string())?;
        inner
            .completed
            .retain(|entry| entry.completed.elapsed() <= STALE_TRANSFER_AGE);
        inner
            .completed
            .iter()
            .find(|entry| entry.id == transfer_id)
            .map(|entry| entry.path.clone())
            .ok_or_else(|| "transfer_reveal_expired".to_string())?
    };
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "transfer_saved_file_missing".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("transfer_saved_file_missing".to_string());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "transfer_reveal_failed".to_string())
}

fn validate_picker_path(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("transfer_invalid_target_path".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "transfer_invalid_target_path".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "transfer_parent_unavailable".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "transfer_invalid_filename".to_string())?;
    if file_name.is_empty()
        || file_name.len() > 240
        || file_name.chars().any(char::is_control)
        || matches!(file_name, "." | "..")
    {
        return Err("transfer_invalid_filename".to_string());
    }
    Ok(canonical_parent.join(file_name))
}

fn sibling_temp_path(target: &Path, id: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "transfer_invalid_target_path".to_string())?;
    Ok(parent.join(format!(".postwave-{id}.partial")))
}

fn new_transfer_id() -> Result<String, String> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| "transfer_id_generation_failed".to_string())?;
    Ok(format!("xfer-{}", URL_SAFE_NO_PAD.encode(entropy)))
}

fn cleanup_stale(inner: &mut TransferInner) -> Vec<(PathBuf, PathBuf)> {
    let stale: Vec<String> = inner
        .active
        .iter()
        .filter(|(_, session)| session.started.elapsed() > STALE_TRANSFER_AGE)
        .map(|(id, _)| id.clone())
        .collect();
    let mut scope_paths = Vec::with_capacity(stale.len());
    for id in stale {
        if let Some(session) = inner.active.remove(&id) {
            scope_paths.push((session.picker_path.clone(), session.target_path.clone()));
            drop(session.file);
            let _ = fs::remove_file(session.temp_path);
        }
    }
    inner
        .completed
        .retain(|entry| entry.completed.elapsed() <= STALE_TRANSFER_AGE);
    scope_paths
}

fn revoke_picker_scope<R: Runtime>(
    app: &AppHandle<R>,
    picker_path: &Path,
    normalized_path: Option<&Path>,
) -> Result<(), String> {
    let mut failed = false;
    let mut revoke = |path: &Path| {
        if app.fs_scope().is_allowed(path) && app.fs_scope().forbid_file(path).is_err() {
            failed = true;
        }
    };
    revoke(picker_path);
    if let Some(path) = normalized_path {
        if path != picker_path {
            revoke(path);
        }
    }
    if failed {
        Err("transfer_scope_revoke_failed".to_string())
    } else {
        Ok(())
    }
}

fn finish_session(session: WriteSession) -> Result<(), String> {
    session
        .file
        .sync_all()
        .map_err(|_| "transfer_sync_failed".to_string())?;
    drop(session.file);
    replace_file_atomically(&session.temp_path, &session.target_path)?;
    #[cfg(unix)]
    {
        let parent = session
            .target_path
            .parent()
            .ok_or_else(|| "transfer_invalid_target_path".to_string())?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "transfer_directory_sync_failed".to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|_| "transfer_atomic_replace_failed".to_string())
}

#[cfg(windows)]
fn replace_file_atomically(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both buffers are NUL-terminated and live for the entire call.
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err("transfer_atomic_replace_failed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_stale, finish_session, new_transfer_id, sibling_temp_path, validate_picker_path,
        TransferInner, WriteSession, STALE_TRANSFER_AGE,
    };
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "postwave-transfer-{label}-{}-{}",
            std::process::id(),
            super::TEST_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    // The filename rules in validate_picker_path had no test at all: deleting
    // the whole block left every existing case green. They are the last check
    // between a picker-granted directory and the name actually written, and
    // each rejects a different real failure — a control character can spoof how
    // a name renders in a file manager, an overlong name fails differently on
    // every filesystem (silently truncating on some), and "." / ".." are
    // directory entries rather than files.
    #[test]
    fn filenames_with_control_characters_are_rejected() {
        let dir = test_dir("ctrl");
        for name in [
            "re\u{0}port.csv",
            "re\nport.csv",
            "re\rport.csv",
            "bell\u{7}.csv",
        ] {
            assert!(
                validate_picker_path(dir.join(name)).is_err(),
                "control character accepted in {name:?}"
            );
        }
        // Guard the guard: an ordinary name must still pass.
        assert!(validate_picker_path(dir.join("report.csv")).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn overlong_filenames_are_rejected_at_the_documented_bound() {
        let dir = test_dir("long");
        let at_limit = "a".repeat(240);
        let over_limit = "a".repeat(241);
        assert!(
            validate_picker_path(dir.join(&at_limit)).is_ok(),
            "240 bytes is the documented limit and must be accepted"
        );
        assert!(
            validate_picker_path(dir.join(&over_limit)).is_err(),
            "241 bytes must be rejected"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parent_dir_components_are_rejected() {
        // `..` survives Path::components() as Component::ParentDir and is
        // rejected by the traversal check.
        //
        // `.` deliberately is NOT asserted here: Rust normalises CurDir away
        // ("/a/b/." yields [RootDir, a, b]), so the component never reaches the
        // check and file_name() returns "b". The result is the DIRECTORY
        // itself, which begin_save then refuses via its symlink_metadata
        // is_file() test — "transfer_target_not_regular_file". Asserting an
        // error here would have been asserting something the language does not
        // do, and the first draft of this test did exactly that.
        let dir = test_dir("dots");
        assert!(validate_picker_path(dir.join("..")).is_err());
        assert!(validate_picker_path(dir.join("sub").join("..")).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn picker_paths_must_be_absolute_and_normalized() {
        assert!(validate_picker_path(PathBuf::from("relative.csv")).is_err());
        assert!(validate_picker_path(PathBuf::from("/tmp/../secret.csv")).is_err());
        let dir = test_dir("paths");
        let validated = validate_picker_path(dir.join("report.csv")).unwrap();
        assert_eq!(validated.file_name().unwrap(), "report.csv");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn temp_file_is_private_sibling_not_the_destination() {
        let dir = test_dir("temp");
        let target = dir.join("report.csv");
        let temp = sibling_temp_path(&target, "xfer-1").unwrap();
        assert_eq!(temp.parent(), target.parent());
        assert_ne!(temp, target);
        assert!(temp.file_name().unwrap().to_string_lossy().starts_with('.'));
        assert!(!temp.to_string_lossy().contains("report.csv"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn transfer_ids_are_random_opaque_and_path_safe() {
        let first = new_transfer_id().unwrap();
        let second = new_transfer_id().unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("xfer-"));
        assert!(first.len() <= 32);
        assert!(first
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')));
    }

    #[test]
    fn stale_sessions_remove_partial_files_and_return_scope_paths() {
        let dir = test_dir("stale");
        let target = dir.join("report.csv");
        let temp = sibling_temp_path(&target, "xfer-stale").unwrap();
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .unwrap();
        let mut inner = TransferInner::default();
        inner.active.insert(
            "xfer-stale".to_string(),
            WriteSession {
                picker_path: target.clone(),
                target_path: target.clone(),
                temp_path: temp.clone(),
                file,
                expected_bytes: 1,
                written_bytes: 0,
                started: Instant::now() - STALE_TRANSFER_AGE - Duration::from_secs(1),
            },
        );

        assert_eq!(cleanup_stale(&mut inner), vec![(target.clone(), target)]);
        assert!(inner.active.is_empty());
        assert!(!temp.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn finish_replaces_existing_file_after_sync() {
        let dir = test_dir("replace");
        let target = dir.join("report.csv");
        let temp = sibling_temp_path(&target, "xfer-test").unwrap();
        fs::write(&target, b"old").unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .unwrap();
        file.write_all(b"new report").unwrap();
        let session = WriteSession {
            picker_path: target.clone(),
            target_path: target.clone(),
            temp_path: temp,
            file,
            expected_bytes: 10,
            written_bytes: 10,
            started: Instant::now(),
        };
        finish_session(session).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new report");
        let _ = fs::remove_dir_all(dir);
    }
}
