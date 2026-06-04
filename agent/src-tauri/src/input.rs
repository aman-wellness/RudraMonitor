// Remote-control input injection for the WebRTC Remote tab.
//
// One dedicated OS thread (`"wellness-extract-input"`) owns the `enigo::Enigo` and
// `arboard::Clipboard` instances; the rest of the agent talks to it via an
// unbounded mpsc channel of `InputEvent`s. Two reasons:
//
//   1. macOS `enigo` uses CGEvent under the hood. Even though current enigo
//      doesn't strictly require a CFRunLoop on the calling thread, keeping
//      the Enigo instance pinned to ONE thread sidesteps any thread-locality
//      assumptions the underlying CG APIs might make on future macOS releases.
//   2. Input events should serialize naturally — two clicks shouldn't race.
//      A single-consumer thread enforces order without us juggling mutexes.
//
// On first call, macOS triggers the TCC Accessibility prompt; the agent's
// signing identity (Rudrans Software Code Signing) means the grant survives
// auto-updates. Windows needs no permission for same-session input.

use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot};

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

/// One payload pushed onto the input channel per remote-control event.
/// Coordinates are absolute pixels — translation from normalized 0..1 to
/// pixels happens in the WebRTC handler where the agent's chosen display
/// dimensions are known.
pub enum InputEvent {
    MouseMove {
        x: i32,
        y: i32,
    },
    MouseButton {
        button: MouseButton,
        down: bool,
    },
    MouseWheel {
        dx: i32,
        dy: i32,
    },
    Key {
        code: String,
        down: bool,
    },
    ClipSet {
        text: String,
    },
    /// Reply via the oneshot with the current clipboard text (best-effort).
    ClipGet(oneshot::Sender<Option<String>>),
}

#[derive(Clone, Copy)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

static SENDER: OnceLock<mpsc::UnboundedSender<InputEvent>> = OnceLock::new();

/// Get a clone of the input sender. None means `spawn()` was never called
/// (shouldn't happen in production — only during very early startup).
pub fn sender() -> Option<mpsc::UnboundedSender<InputEvent>> {
    SENDER.get().cloned()
}

/// Spawn the dedicated input thread. Idempotent — calling twice is a no-op.
/// Call this once from the agent's startup hook before WebRTC traffic could
/// arrive.
pub fn spawn() {
    if SENDER.get().is_some() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<InputEvent>();
    if SENDER.set(tx).is_err() {
        return;
    }

    std::thread::Builder::new()
        .name("wellness-extract-input".into())
        .spawn(move || {
            let mut enigo = match Enigo::new(&Settings::default()) {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("input: Enigo init failed: {e}");
                    return;
                }
            };
            let mut clipboard = arboard::Clipboard::new().ok();
            log::info!("input: thread ready");

            // tokio Receiver::blocking_recv exists on UnboundedReceiver too.
            //
            // A single-slot "next event" buffer lets us coalesce consecutive
            // MouseMove events. The dashboard sends pixel-precise mousemove
            // at >60 Hz; each enigo.move_mouse on Windows takes ~2-5 ms, so
            // a serial drain quickly falls behind, the unbounded mpsc fills,
            // and the cursor appears laggy by 1-2 seconds. Coalescing means
            // we apply only the LATEST position when several moves queued up
            // back-to-back — the customer reports of "mouse lag bahut" while
            // remoting fix here without changing the wire protocol.
            let mut pending: Option<InputEvent> = None;
            loop {
                let ev = if let Some(p) = pending.take() {
                    p
                } else {
                    match rx.blocking_recv() {
                        Some(e) => e,
                        None => break,
                    }
                };
                match ev {
                    InputEvent::MouseMove { mut x, mut y } => {
                        // Drain the queue, keeping only the latest mouse
                        // coordinate. Any non-MouseMove gets parked in
                        // `pending` so the next loop iteration handles it
                        // in original order.
                        loop {
                            match rx.try_recv() {
                                Ok(InputEvent::MouseMove { x: nx, y: ny }) => {
                                    x = nx; y = ny;
                                }
                                Ok(other) => { pending = Some(other); break; }
                                Err(_) => break,
                            }
                        }
                        if let Err(e) = enigo.move_mouse(x, y, Coordinate::Abs) {
                            log::warn!("move_mouse: {e}");
                        }
                    }
                    InputEvent::MouseButton { button, down } => {
                        let btn = match button {
                            MouseButton::Left => Button::Left,
                            MouseButton::Right => Button::Right,
                            MouseButton::Middle => Button::Middle,
                        };
                        let dir = if down { Direction::Press } else { Direction::Release };
                        if let Err(e) = enigo.button(btn, dir) {
                            log::warn!("button: {e}");
                        }
                    }
                    InputEvent::MouseWheel { dx, dy } => {
                        if dy != 0 {
                            let _ = enigo.scroll(dy, Axis::Vertical);
                        }
                        if dx != 0 {
                            let _ = enigo.scroll(dx, Axis::Horizontal);
                        }
                    }
                    InputEvent::Key { code, down } => {
                        let dir = if down { Direction::Press } else { Direction::Release };
                        // Prefer the platform-raw keycode path. That sends a
                        // real WM_KEYDOWN (Windows) / kCGEventKeyDown (macOS)
                        // / XK_* (Linux) so the OS sees a physical key press
                        // — shortcuts, modifier composition and IME-aware
                        // keyboards all work as expected.
                        if let Some(vk) = os_keycode(&code) {
                            if let Err(e) = enigo.key(Key::Other(vk), dir) {
                                log::warn!("key {code} (raw {vk:#x}): {e}");
                            }
                        } else if let Some(k) = map_code(&code) {
                            // Named/named-modifier keys (Shift, Ctrl, Alt,
                            // Meta, arrows, function keys, etc.) — enigo
                            // already exposes platform-correct presses for
                            // these via the typed `Key` variants.
                            if let Err(e) = enigo.key(k, dir) {
                                log::warn!("key {code}: {e}");
                            }
                        } else {
                            log::warn!("input: unmapped key code {code}");
                        }
                    }
                    InputEvent::ClipSet { text } => {
                        if let Some(c) = clipboard.as_mut() {
                            let _ = c.set_text(text);
                        }
                    }
                    InputEvent::ClipGet(reply) => {
                        let v = clipboard.as_mut().and_then(|c| c.get_text().ok());
                        let _ = reply.send(v);
                    }
                }
            }
            log::info!("input: thread exiting (channel closed)");
        })
        .expect("spawn wellness-extract-input thread");
}

/// Map a browser `KeyboardEvent.code` to `enigo::Key`. Layout-independent —
/// physical key position only, so the same code works on QWERTY / DVORAK /
/// AZERTY etc. Returns None for codes we don't know (caller logs + drops).
///
/// For PRINTABLE keys (letters, digits, punctuation) we map to the platform
/// raw virtual keycode via `Key::Other`. enigo's `Key::Unicode` types the
/// literal character but bypasses real WM_KEYDOWN / kCGEventKeyDown events,
/// which breaks every shortcut (Ctrl+A, Cmd+V, Shift+letter) — the agent
/// looked unusable for typing. Using the platform VK / kVK_ANSI_* codes
/// lets the OS keyboard layer see a genuine physical-key press, so modifiers
/// like Shift/Ctrl/Cmd compose correctly with whatever letter follows.
///
/// Letters / digits previously used `Key::Unicode`; that's the original
/// reason the customer reported "keyboard kaam nahi kar raha" — typing
/// felt wrong, shortcuts didn't fire, modifier+letter combos failed. The
/// mapping below replaces it with the OS's physical keycode tables.

#[cfg(target_os = "windows")]
fn os_keycode(code: &str) -> Option<u32> {
    // Windows Virtual-Key codes (winuser.h). Letters/digits are their ASCII
    // values. Special keys come from named constants.
    if let Some(rest) = code.strip_prefix("Key") {
        let mut ch = rest.chars();
        if let (Some(c), None) = (ch.next(), ch.next()) {
            if c.is_ascii_alphabetic() {
                return Some(c.to_ascii_uppercase() as u32);
            }
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        if rest.len() == 1 {
            let c = rest.chars().next().unwrap();
            if c.is_ascii_digit() { return Some(c as u32); }
        }
    }
    Some(match code {
        // OEM punctuation keys (US layout — the OS still produces locale-
        // correct characters because we're sending the physical key).
        "Minus"        => 0xBD, // VK_OEM_MINUS
        "Equal"        => 0xBB, // VK_OEM_PLUS
        "BracketLeft"  => 0xDB, // VK_OEM_4
        "BracketRight" => 0xDD, // VK_OEM_6
        "Backslash"    => 0xDC, // VK_OEM_5
        "Semicolon"    => 0xBA, // VK_OEM_1
        "Quote"        => 0xDE, // VK_OEM_7
        "Backquote"    => 0xC0, // VK_OEM_3
        "Comma"        => 0xBC, // VK_OEM_COMMA
        "Period"       => 0xBE, // VK_OEM_PERIOD
        "Slash"        => 0xBF, // VK_OEM_2
        // Numpad digits emit VK_NUMPAD0..9 specifically so shift-state
        // produces the digit instead of nav-keys.
        "Numpad0" => 0x60, "Numpad1" => 0x61, "Numpad2" => 0x62, "Numpad3" => 0x63,
        "Numpad4" => 0x64, "Numpad5" => 0x65, "Numpad6" => 0x66, "Numpad7" => 0x67,
        "Numpad8" => 0x68, "Numpad9" => 0x69,
        "NumpadAdd"      => 0x6B, // VK_ADD
        "NumpadSubtract" => 0x6D, // VK_SUBTRACT
        "NumpadMultiply" => 0x6A, // VK_MULTIPLY
        "NumpadDivide"   => 0x6F, // VK_DIVIDE
        "NumpadDecimal"  => 0x6E, // VK_DECIMAL
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
fn os_keycode(code: &str) -> Option<u32> {
    // macOS kVK_ANSI_* keycodes from <Carbon/HIToolbox/Events.h>. We use
    // raw integers so we don't need a Carbon dependency at compile time.
    Some(match code {
        // Letters (ANSI A..Z)
        "KeyA" => 0x00, "KeyS" => 0x01, "KeyD" => 0x02, "KeyF" => 0x03,
        "KeyH" => 0x04, "KeyG" => 0x05, "KeyZ" => 0x06, "KeyX" => 0x07,
        "KeyC" => 0x08, "KeyV" => 0x09, "KeyB" => 0x0B, "KeyQ" => 0x0C,
        "KeyW" => 0x0D, "KeyE" => 0x0E, "KeyR" => 0x0F, "KeyY" => 0x10,
        "KeyT" => 0x11, "KeyO" => 0x1F, "KeyU" => 0x20, "KeyI" => 0x22,
        "KeyP" => 0x23, "KeyL" => 0x25, "KeyJ" => 0x26, "KeyK" => 0x28,
        "KeyN" => 0x2D, "KeyM" => 0x2E,
        // Digits (top row): kVK_ANSI_0..9
        "Digit1" => 0x12, "Digit2" => 0x13, "Digit3" => 0x14, "Digit4" => 0x15,
        "Digit6" => 0x16, "Digit5" => 0x17, "Digit9" => 0x19, "Digit7" => 0x1A,
        "Digit8" => 0x1C, "Digit0" => 0x1D,
        // Punctuation
        "Equal"        => 0x18,
        "Minus"        => 0x1B,
        "BracketRight" => 0x1E,
        "BracketLeft"  => 0x21,
        "Quote"        => 0x27,
        "Semicolon"    => 0x29,
        "Backslash"    => 0x2A,
        "Comma"        => 0x2B,
        "Slash"        => 0x2C,
        "Period"       => 0x2F,
        "Backquote"    => 0x32,
        // Numpad
        "Numpad0" => 0x52, "Numpad1" => 0x53, "Numpad2" => 0x54, "Numpad3" => 0x55,
        "Numpad4" => 0x56, "Numpad5" => 0x57, "Numpad6" => 0x58, "Numpad7" => 0x59,
        "Numpad8" => 0x5B, "Numpad9" => 0x5C,
        "NumpadAdd"      => 0x45,
        "NumpadSubtract" => 0x4E,
        "NumpadMultiply" => 0x43,
        "NumpadDivide"   => 0x4B,
        "NumpadDecimal"  => 0x41,
        _ => return None,
    })
}

#[cfg(target_os = "linux")]
fn os_keycode(code: &str) -> Option<u32> {
    // Linux evdev codes from <linux/input-event-codes.h>. enigo's X11 backend
    // accepts these via Key::Other.
    if let Some(rest) = code.strip_prefix("Key") {
        let mut ch = rest.chars();
        if let (Some(c), None) = (ch.next(), ch.next()) {
            if c.is_ascii_alphabetic() {
                return Some(match c.to_ascii_uppercase() {
                    'A' => 30, 'B' => 48, 'C' => 46, 'D' => 32, 'E' => 18, 'F' => 33,
                    'G' => 34, 'H' => 35, 'I' => 23, 'J' => 36, 'K' => 37, 'L' => 38,
                    'M' => 50, 'N' => 49, 'O' => 24, 'P' => 25, 'Q' => 16, 'R' => 19,
                    'S' => 31, 'T' => 20, 'U' => 22, 'V' => 47, 'W' => 17, 'X' => 45,
                    'Y' => 21, 'Z' => 44,
                    _ => return None,
                });
            }
        }
    }
    None
}

/// Letters and digits use `Key::Unicode` so the OS's current layout decides
/// the character — that gives the customer the same typing behavior they'd
/// get with a physical keyboard. Special keys use enigo's named variants.
fn map_code(code: &str) -> Option<Key> {
    // Letters: KeyA..KeyZ
    if let Some(rest) = code.strip_prefix("Key") {
        let mut ch = rest.chars();
        if let (Some(c), None) = (ch.next(), ch.next()) {
            if c.is_ascii_alphabetic() {
                return Some(Key::Unicode(c.to_ascii_lowercase()));
            }
        }
    }
    // Digits (top row): Digit0..Digit9
    if let Some(rest) = code.strip_prefix("Digit") {
        if rest.len() == 1 {
            let c = rest.chars().next().unwrap();
            if c.is_ascii_digit() {
                return Some(Key::Unicode(c));
            }
        }
    }
    // Numpad digits: Numpad0..Numpad9 → same character; enigo doesn't
    // expose a distinct numpad-digit variant on every platform.
    if let Some(rest) = code.strip_prefix("Numpad") {
        if rest.len() == 1 {
            let c = rest.chars().next().unwrap();
            if c.is_ascii_digit() {
                return Some(Key::Unicode(c));
            }
        }
    }
    // Function keys F1..F24 (enigo exposes F1..F12 reliably; higher ones rare).
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            return match n {
                1 => Some(Key::F1),
                2 => Some(Key::F2),
                3 => Some(Key::F3),
                4 => Some(Key::F4),
                5 => Some(Key::F5),
                6 => Some(Key::F6),
                7 => Some(Key::F7),
                8 => Some(Key::F8),
                9 => Some(Key::F9),
                10 => Some(Key::F10),
                11 => Some(Key::F11),
                12 => Some(Key::F12),
                _ => None,
            };
        }
    }
    Some(match code {
        "Enter" | "NumpadEnter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Space" => Key::Space,
        "Escape" => Key::Escape,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        // macOS Cmd, Windows Meta key
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        // Punctuation — best-effort Unicode passthrough. The OS layout maps
        // these to whatever the user expects in their current language.
        "Minus" => Key::Unicode('-'),
        "Equal" => Key::Unicode('='),
        "BracketLeft" => Key::Unicode('['),
        "BracketRight" => Key::Unicode(']'),
        "Backslash" => Key::Unicode('\\'),
        "Semicolon" => Key::Unicode(';'),
        "Quote" => Key::Unicode('\''),
        "Backquote" => Key::Unicode('`'),
        "Comma" => Key::Unicode(','),
        "Period" => Key::Unicode('.'),
        "Slash" => Key::Unicode('/'),
        "NumpadAdd" => Key::Unicode('+'),
        "NumpadSubtract" => Key::Unicode('-'),
        "NumpadMultiply" => Key::Unicode('*'),
        "NumpadDivide" => Key::Unicode('/'),
        "NumpadDecimal" => Key::Unicode('.'),
        _ => return None,
    })
}
