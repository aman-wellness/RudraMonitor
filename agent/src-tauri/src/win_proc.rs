// Helpers for spawning child processes on Windows without a console window.
//
// The agent's main binary is built with `windows_subsystem = "windows"` so it
// has NO console of its own. When it spawns a console-subsystem child
// (ffmpeg.exe, taskkill.exe, cmd.exe, reg.exe...), Windows allocates a brand
// new console for the child. On Windows 11 / Windows Terminal that console is
// hosted by Windows Terminal, which means a tab pops up titled with the
// child's working directory ("C:\Program Files\Security Assistant\…") every
// time the agent ticks. Customers see these tabs flicker every few seconds
// and reasonably think the app is misbehaving — see v0.2.36 bug report.
//
// The fix is to set CREATE_NO_WINDOW (0x08000000) on every Command we spawn
// on Windows. There is no equivalent flag on unix, so the helpers are a no-op
// on other platforms and the calling sites stay portable.

use std::process::Command;

/// Apply CREATE_NO_WINDOW to a Command on Windows; no-op on other platforms.
/// Use this for every external-process spawn that doesn't already attach to
/// an existing console — ffmpeg, taskkill, reg, cmd, launchctl wrappers,
/// pkill on macOS (no-op), etc.
#[inline]
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW. Documented at
        // https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
