//! Network state watcher.
//!
//! The renderer's onlineManager already combines `navigator.onLine`, the
//! /api/health heartbeat, and observed real-request success/failure — the
//! JS heartbeat REMAINS the source of truth for reachability. What Rust
//! adds are fast hints the WebView can't see promptly:
//!
//! * On window focus, emit `net:state` = "probe" so the renderer fires an
//!   immediate heartbeat — catches macOS sleep/resume from the UI side.
//! * An OS-level interface watcher ([`spawn_watcher`], gaps doc B7): when
//!   addresses appear/change we emit "probe" (interface-up does not prove
//!   internet — captive portals, VPN-up-no-route — so the renderer
//!   verifies with a real heartbeat); when the LAST routable address
//!   disappears we emit "offline" (a hard signal worth trusting
//!   immediately). Events are debounced so DHCP renews and VPN flaps
//!   collapse into one emission.
//!
//! The IPC event name and payload shape are stable: renderer code in
//! apps/desktop/src/lib/online-manager.ts depends on this contract
//! (`net:state` = {state: "online" | "offline" | "probe"}).

use std::collections::HashSet;
use std::future::poll_fn;
use std::net::IpAddr;
use std::time::Duration;

use if_watch::{tokio::IfWatcher, IfEvent, IpNet};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
use tracing::{debug, warn};

/// Quiet period after the last interface event before we evaluate +
/// emit. Interface churn (DHCP renew, VPN connect, Wi-Fi roam) tends to
/// produce bursts of Up/Down events within a second or two.
const DEBOUNCE: Duration = Duration::from_millis(1_500);

/// Grace window after [`spawn_watcher`] starts during which evaluations
/// are absorbed silently. IfWatcher replays every pre-existing address
/// as an Up event right after construction; that replay lands within
/// this window and must not emit (the renderer already probes on boot).
/// A genuine first transition — e.g. the machine launches with no
/// interfaces and connects a minute later — arrives after the window
/// and IS emitted, unlike the old "always swallow the first event"
/// rule, which dropped it until the JS heartbeat caught up.
const STARTUP_GRACE: Duration = Duration::from_secs(2);

/// Payload of the `net:state` event. Keep this tiny — it crosses the IPC
/// boundary on every emission.
#[derive(Debug, Clone, Serialize)]
pub struct NetState {
    /// "probe"   — renderer, please re-run your heartbeat now (window
    ///             focus, or interfaces changed while some address is
    ///             still present).
    /// "offline" — no routable address left on any interface; the
    ///             renderer flips immediately without waiting for a
    ///             heartbeat timeout.
    /// "online"  — accepted by the renderer but deliberately never sent:
    ///             an interface having an address does not prove the API
    ///             is reachable, so we only ever *hint* via "probe".
    pub state: &'static str,
}

/// Hook the window event stream so window focus triggers a `net:state`
/// probe nudge. The renderer's `tauri://focus` listener catches the
/// focus separately; this is the Rust-side belt-and-suspenders that
/// also works when the window already had focus and the OS just came
/// out of sleep (focus is not re-fired in that case on all platforms).
pub fn install_focus_probe<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(true) = event {
            let _ = handle.emit("net:state", NetState { state: "probe" });
        }
    });
}

/// Spawn the OS-level interface watcher (replaces the no-op hourly
/// scaffold the 2026-06-10 audit removed — this one watches real OS
/// events instead of sleeping in a loop).
///
/// `if-watch` delivers address add/remove events from the platform's
/// native notification source (rtnetlink on Linux, the routing socket on
/// macOS, IP Helper on Windows) — no polling. The task runs for the
/// process lifetime; if the watcher can't be constructed (sandboxed CI,
/// exotic platforms) we log and fall back to the JS heartbeat alone,
/// which remains fully functional without this hint source.
pub fn spawn_watcher<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut watcher = match IfWatcher::new() {
            Ok(w) => w,
            Err(err) => {
                warn!("net watcher unavailable ({err}); JS heartbeat only");
                return;
            }
        };

        let mut addrs: HashSet<IpNet> = HashSet::new();
        // See STARTUP_GRACE: the initial enumeration burst (suppressed)
        // is distinguished from a genuine first transition (emitted) by
        // the event's arrival time relative to spawn — NOT by "is this
        // the first event", which would drop a real first transition on
        // a machine that booted with no interfaces.
        let started = tokio::time::Instant::now();
        let mut last: Option<&'static str> = None;

        loop {
            let event = poll_fn(|cx| watcher.poll_if_event(cx)).await;
            // Sample grace at event ARRIVAL, before the debounce sleep
            // stretches the elapsed time past the window.
            let within_grace = in_startup_grace(started, tokio::time::Instant::now());
            match event {
                Ok(ev) => apply_event(&mut addrs, ev),
                Err(err) => {
                    debug!("net watcher event error: {err}");
                    continue;
                }
            }

            // Debounce: keep absorbing events until DEBOUNCE elapses with
            // no further changes, then evaluate once.
            loop {
                match tokio::time::timeout(DEBOUNCE, poll_fn(|cx| watcher.poll_if_event(cx))).await
                {
                    Ok(Ok(ev)) => apply_event(&mut addrs, ev),
                    Ok(Err(err)) => debug!("net watcher event error: {err}"),
                    Err(_elapsed) => break,
                }
            }

            let state = derive_state(&addrs);
            let emit = should_emit(last, state, within_grace);
            last = Some(state);
            if !emit {
                continue;
            }
            debug!("net watcher: interfaces changed -> {state}");
            let _ = handle.emit("net:state", NetState { state });
        }
    });
}

/// True while `now` is inside the post-spawn [`STARTUP_GRACE`] window.
fn in_startup_grace(started: tokio::time::Instant, now: tokio::time::Instant) -> bool {
    now.saturating_duration_since(started) < STARTUP_GRACE
}

/// Decide whether a debounced evaluation emits `net:state`.
///
/// * No change since the last evaluation → never emit.
/// * Changed, but the triggering event arrived inside the startup grace
///   window → suppress (IfWatcher's initial address enumeration; the
///   renderer probes on boot anyway).
/// * Changed after the grace window → emit, INCLUDING when this is the
///   very first evaluation (`last == None`) — that's a genuine first
///   transition, e.g. a machine that started with no interfaces and
///   just connected.
fn should_emit(last: Option<&'static str>, state: &'static str, within_grace: bool) -> bool {
    if last == Some(state) {
        return false;
    }
    !within_grace
}

fn apply_event(addrs: &mut HashSet<IpNet>, event: IfEvent) {
    match event {
        IfEvent::Up(net) => {
            addrs.insert(net);
        }
        IfEvent::Down(net) => {
            addrs.remove(&net);
        }
    }
}

/// Map the current address set to the hint we emit. "probe" while any
/// routable address exists (the heartbeat decides whether the API is
/// actually reachable); "offline" when none do.
fn derive_state(addrs: &HashSet<IpNet>) -> &'static str {
    if addrs.iter().any(|net| is_routable(net.addr())) {
        "probe"
    } else {
        "offline"
    }
}

/// An address that suggests the machine might reach a network. Loopback
/// and link-local addresses don't count — a machine whose only addresses
/// are 127.0.0.1 / 169.254.x.x / fe80:: is effectively offline.
fn is_routable(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
        IpAddr::V6(v6) => {
            !v6.is_loopback()
                && !v6.is_unspecified()
                // fe80::/10 — IPv6 link-local (is_unicast_link_local is
                // unstable on std, so match the prefix directly).
                && (v6.segments()[0] & 0xffc0) != 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_event, derive_state, in_startup_grace, is_routable, should_emit, STARTUP_GRACE,
    };
    use if_watch::{IfEvent, IpNet};
    use std::collections::HashSet;
    use std::net::IpAddr;
    use std::time::Duration;

    fn net(s: &str) -> IpNet {
        s.parse().expect("test net")
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test ip")
    }

    #[test]
    fn loopback_and_link_local_are_not_routable() {
        assert!(!is_routable(ip("127.0.0.1")));
        assert!(!is_routable(ip("169.254.10.20")));
        assert!(!is_routable(ip("0.0.0.0")));
        assert!(!is_routable(ip("::1")));
        assert!(!is_routable(ip("fe80::1")));
        assert!(!is_routable(ip("::")));
    }

    #[test]
    fn lan_and_global_addresses_are_routable() {
        assert!(is_routable(ip("192.168.1.5")));
        assert!(is_routable(ip("10.0.0.2")));
        assert!(is_routable(ip("8.8.8.8")));
        assert!(is_routable(ip("2001:db8::1")));
    }

    #[test]
    fn state_follows_the_address_set() {
        let mut addrs: HashSet<IpNet> = HashSet::new();
        // Empty / loopback-only → offline.
        assert_eq!(derive_state(&addrs), "offline");
        apply_event(&mut addrs, IfEvent::Up(net("127.0.0.1/8")));
        assert_eq!(derive_state(&addrs), "offline");
        // A LAN address appears → probe (heartbeat confirms real reach).
        apply_event(&mut addrs, IfEvent::Up(net("192.168.1.5/24")));
        assert_eq!(derive_state(&addrs), "probe");
        // It disappears again → offline.
        apply_event(&mut addrs, IfEvent::Down(net("192.168.1.5/24")));
        assert_eq!(derive_state(&addrs), "offline");
    }

    #[test]
    fn startup_grace_window_is_time_based() {
        let started = tokio::time::Instant::now();
        assert!(in_startup_grace(started, started));
        assert!(in_startup_grace(
            started,
            started + STARTUP_GRACE - Duration::from_millis(1)
        ));
        assert!(!in_startup_grace(started, started + STARTUP_GRACE));
        assert!(!in_startup_grace(
            started,
            started + STARTUP_GRACE + Duration::from_secs(60)
        ));
    }

    #[test]
    fn startup_enumeration_inside_grace_is_suppressed() {
        // App launch with interfaces present: IfWatcher replays them
        // immediately, the evaluation lands in the grace window → no emit.
        assert!(!should_emit(None, "probe", true));
        assert!(!should_emit(None, "offline", true));
        // Subsequent changes still inside the window stay silent too.
        assert!(!should_emit(Some("probe"), "offline", true));
    }

    #[test]
    fn genuine_first_transition_after_grace_emits() {
        // Machine started with NO interfaces (no startup burst at all,
        // `last` still None), then connects after the grace window —
        // this must emit instead of being swallowed as "first event".
        assert!(should_emit(None, "probe", false));
        assert!(should_emit(None, "offline", false));
    }

    #[test]
    fn post_grace_changes_emit_only_on_state_change() {
        assert!(should_emit(Some("probe"), "offline", false));
        assert!(should_emit(Some("offline"), "probe", false));
        // DHCP renew that leaves the state unchanged → silent.
        assert!(!should_emit(Some("probe"), "probe", false));
        assert!(!should_emit(Some("offline"), "offline", false));
    }
}
