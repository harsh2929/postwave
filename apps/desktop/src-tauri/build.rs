fn main() {
    // The updater module reads these with option_env!() — make sure cargo
    // rebuilds when the build environment flips between configured and
    // unconfigured, otherwise a stale build could keep the previous state.
    println!("cargo:rerun-if-env-changed=POSTWAVE_UPDATER_PUBKEY");
    println!("cargo:rerun-if-env-changed=POSTWAVE_UPDATER_ENDPOINT");

    tauri_build::build()
}
