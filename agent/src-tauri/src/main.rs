// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Self-uninstall path: invoking the binary with `--uninstall` strips every footprint
    // (autolaunch entry, on-disk config, installed app bundle) and exits without starting
    // Tauri. Works the same on macOS, Windows and Linux.
    if std::env::args().any(|a| a == "--uninstall") {
        match trackforce_agent_lib::uninstall_self() {
            Ok(()) => {
                println!("TrackForce Agent uninstalled successfully.");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("Uninstall failed: {e}");
                std::process::exit(1);
            }
        }
    }
    trackforce_agent_lib::run();
}
