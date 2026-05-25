// Remote-control input injection for the WebRTC Remote tab.
//
// One dedicated OS thread (`"rudrans-input"`) owns the `enigo::Enigo` and
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
        .name("rudrans-input".into())
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
                        if let Some(k) = map_code(&code) {
                            let dir = if down { Direction::Press } else { Direction::Release };
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
        .expect("spawn rudrans-input thread");
}

/// Map a browser `KeyboardEvent.code` to `enigo::Key`. Layout-independent —
/// physical key position only, so the same code works on QWERTY / DVORAK /
/// AZERTY etc. Returns None for codes we don't know (caller logs + drops).
///
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
