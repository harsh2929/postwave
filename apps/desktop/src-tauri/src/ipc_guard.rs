use tauri::{Runtime, WebviewWindow};

/// Custom commands do not inherit plugin ACL permissions. Security-sensitive
/// commands therefore verify both the one allowed window label and the exact
/// bundled/dev renderer origin before touching credentials or plaintext.
pub fn ensure_main_bundled_window<R: Runtime>(
    window: &WebviewWindow<R>,
    capability: &str,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err(format!("{capability} is restricted to the main window"));
    }
    let url = window
        .url()
        .map_err(|_| "cannot verify renderer origin".to_string())?;
    if is_trusted_renderer(window.label(), &url) {
        Ok(())
    } else {
        Err("untrusted renderer origin".to_string())
    }
}

fn is_trusted_renderer(label: &str, url: &url::Url) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                && url.port_or_known_default() == Some(1420)))
}

#[cfg(test)]
mod tests {
    use super::is_trusted_renderer;
    use url::Url;

    // The dev branch had no test at all. It is a separate `||` arm, so nothing
    // downstream catches a weakening of it: dropping the loopback-host check
    // makes `http://evil.example:1420/` TRUSTED, and dropping the port check
    // makes any http://localhost:* trusted. Verified by probing both mutations
    // — neither changed a single assertion in the suite.
    //
    // This is the guard every security-sensitive Tauri command calls before
    // touching credentials, plaintext or the filesystem
    // (ensure_main_bundled_window), so its trust decision is the widest blast
    // radius in the crate.
    //
    // These run under cfg!(debug_assertions), which is true for `cargo test`.
    // A release build compiles the arm out entirely; that cannot be asserted
    // from inside a debug binary, and pretending otherwise would be a test that
    // proves nothing.
    #[test]
    fn dev_renderer_is_trusted_only_on_loopback_and_the_vite_port() {
        let trusted = |raw: &str| is_trusted_renderer("main", &Url::parse(raw).unwrap());

        // The two origins `pnpm tauri dev` actually serves.
        assert!(trusted("http://localhost:1420/"));
        assert!(trusted("http://127.0.0.1:1420/"));

        // Right port, wrong host — the case a weakened host check would admit.
        assert!(
            !trusted("http://evil.example:1420/"),
            "a non-loopback host was trusted on the dev port"
        );
        assert!(!trusted("http://192.168.1.10:1420/"));

        // Right host, wrong port. `http://localhost/` has no explicit port, so
        // port_or_known_default() is 80 — it must not be treated as the dev
        // server.
        assert!(!trusted("http://localhost:9999/"));
        assert!(!trusted("http://localhost/"));

        // https on the dev port is not the dev server either.
        assert!(!trusted("https://localhost:1420/"));
    }

    #[test]
    fn only_the_bundled_main_renderer_has_custom_command_capabilities() {
        assert!(is_trusted_renderer(
            "main",
            &Url::parse("tauri://localhost/settings").unwrap()
        ));
        assert!(is_trusted_renderer(
            "main",
            &Url::parse("http://tauri.localhost/settings").unwrap()
        ));
        assert!(!is_trusted_renderer(
            "secondary",
            &Url::parse("tauri://localhost/").unwrap()
        ));
        assert!(!is_trusted_renderer(
            "main",
            &Url::parse("tauri://attacker/").unwrap()
        ));
        assert!(!is_trusted_renderer(
            "main",
            &Url::parse("https://app.moosewave.com/").unwrap()
        ));
    }
}
