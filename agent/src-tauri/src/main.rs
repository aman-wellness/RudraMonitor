// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Guardian invocation: `--guardian` runs the watchdog loop instead of the
    // Tauri app. The guardian respawns the main agent if it gets killed.
    if rudrans_agent_lib::is_guardian_invocation() {
        rudrans_agent_lib::run_guardian_loop();
    }

    // Self-uninstall: writes a graceful-shutdown flag so the guardian exits
    // cleanly without respawning, then strips every footprint.
    if std::env::args().any(|a| a == "--uninstall") {
        rudrans_agent_lib::mark_graceful_shutdown();
        match rudrans_agent_lib::uninstall_self() {
            Ok(()) => {
                println!("Rudrans Agent uninstalled successfully.");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("Uninstall failed: {e}");
                std::process::exit(1);
            }
        }
    }
    rudrans_agent_lib::run();
}
