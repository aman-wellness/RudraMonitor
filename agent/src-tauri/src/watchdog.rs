// Watchdog / guardian process.
//
// Strategy:
//   1. When the agent starts, if no guardian is alive it spawns one (a child
//      of the same binary launched with `--guardian` argument).
//   2. The guardian polls the agent's PID file every 2s. If the agent process
//      no longer exists, the guardian respawns the agent and exits (the new
//      agent will spawn a fresh guardian on its next start-up).
//   3. The agent on exit writes a `shutdown.flag` file ONLY for graceful
//      shutdowns (uninstall, signed-out, etc.). The guardian checks this flag
//      before respawning — so legitimate uninstalls don't loop.
//
// Survival behaviour:
//   - User kills the agent in Task Manager → agent's PID disappears →
//     guardian detects within 2s → respawns within 5s.
//   - User kills BOTH the agent AND the guardian → next agent restart will
//     re-establish the pair. With the OS service registration (see install
//     scripts) that restart happens automatically.
//   - Legitimate exit via uninstaller → shutdown flag set → guardian exits
//     without respawning.
//
// Every persistence layer here is observable: the system tray icon stays
// visible, the install path is documented, and an `uninstall` command writes
// the shutdown flag. No covert behaviour.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::time::Duration;

const GUARDIAN_ARG: &str = "--guardian";
const PID_FILE: &str = "agent.pid";
const GUARDIAN_PID_FILE: &str = "guardian.pid";
const SHUTDOWN_FLAG: &str = "shutdown.flag";

fn data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    let dir = base.join("RudransAgent");
    std::fs::create_dir_all(&dir).ok();
    Ok(dir)
}

fn agent_pid_path() -> Result<PathBuf> { Ok(data_dir()?.join(PID_FILE)) }
fn guardian_pid_path() -> Result<PathBuf> { Ok(data_dir()?.join(GUARDIAN_PID_FILE)) }
fn shutdown_flag_path() -> Result<PathBuf> { Ok(data_dir()?.join(SHUTDOWN_FLAG)) }

fn write_pid(path: &PathBuf, pid: u32) -> Result<()> {
    std::fs::write(path, pid.to_string()).context("write pid")
}

fn read_pid(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    // kill(pid, 0) returns 0 iff the process exists and we have permission to signal it.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(windows)]
fn is_alive(pid: u32) -> bool {
    // OpenProcess with QUERY_LIMITED_INFORMATION: returns null if process doesn't exist.
    use std::ffi::c_void;
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return false; }
        CloseHandle(h);
        true
    }
}

/// Called from main() at startup. Records the agent's PID and (re)spawns a guardian
/// if none is currently alive.
pub fn register_agent_and_ensure_guardian() {
    if let Ok(p) = agent_pid_path() {
        let _ = write_pid(&p, std::process::id());
    }
    // Clear stale shutdown flag from a previous run
    if let Ok(p) = shutdown_flag_path() {
        let _ = std::fs::remove_file(&p);
    }

    let guardian_alive = guardian_pid_path()
        .ok()
        .and_then(|p| read_pid(&p))
        .map(is_alive)
        .unwrap_or(false);

    if !guardian_alive {
        if let Err(e) = spawn_guardian() {
            log::warn!("could not spawn guardian: {e}");
        }
    }
}

/// Mark a graceful shutdown so the guardian doesn't respawn the agent.
/// Call this from the uninstaller / sign-out / quit-and-stay-quit paths.
pub fn mark_graceful_shutdown() {
    if let Ok(p) = shutdown_flag_path() {
        let _ = std::fs::write(p, "1");
    }
}

fn spawn_guardian() -> Result<()> {
    let exe = std::env::current_exe().context("current_exe")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg(GUARDIAN_ARG);

    // Detach: on Windows use DETACHED_PROCESS so it survives the agent.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    // On Unix, setsid via pre_exec so the child survives parent death.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| { libc::setsid(); Ok(()) });
        }
    }

    let _child = cmd.spawn().context("spawn guardian")?;
    Ok(())
}

/// Detect `--guardian` arg as early as possible in main(). Returns true if we are
/// the guardian and the caller should run the guardian loop instead of the
/// normal Tauri app.
pub fn is_guardian_invocation() -> bool {
    std::env::args().any(|a| a == GUARDIAN_ARG)
}

/// Guardian loop: poll the agent every 2s, respawn when missing.
pub fn run_guardian_loop() -> ! {
    // Record our own PID so the next agent restart knows we exist
    if let Ok(p) = guardian_pid_path() {
        let _ = write_pid(&p, std::process::id());
    }

    let mut last_respawn = std::time::Instant::now() - Duration::from_secs(30);
    let min_respawn_gap = Duration::from_secs(5);

    loop {
        std::thread::sleep(Duration::from_secs(2));

        // Graceful shutdown? Exit cleanly.
        if shutdown_flag_path().ok().map(|p| p.exists()).unwrap_or(false) {
            // Clean up our own PID file and exit so a future install isn't confused.
            if let Ok(p) = guardian_pid_path() { let _ = std::fs::remove_file(&p); }
            std::process::exit(0);
        }

        let agent_pid = agent_pid_path().ok().and_then(|p| read_pid(&p));
        let alive = agent_pid.map(is_alive).unwrap_or(false);

        if !alive && last_respawn.elapsed() >= min_respawn_gap {
            if let Err(e) = respawn_agent() {
                eprintln!("guardian: respawn failed: {e}");
            } else {
                last_respawn = std::time::Instant::now();
            }
        }
    }
}

fn respawn_agent() -> Result<()> {
    let exe = std::env::current_exe().context("current_exe")?;
    let mut cmd = std::process::Command::new(&exe);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(DETACHED_PROCESS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
    }

    cmd.spawn().context("respawn agent")?;
    Ok(())
}
