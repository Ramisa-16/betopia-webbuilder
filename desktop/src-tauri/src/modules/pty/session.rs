use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;
use tauri::Emitter;
use serde::Serialize;

use super::agent_detect::{AgentDetector, Transition};

// Keep enough terminal history to survive hide/show restores and large outputs
// like `dir` / build logs. 64 KB was too small and truncated the reopened view.
const OUTPUT_BUFFER_MAX: usize = 8 * 1024 * 1024; // 8 MB per session

#[derive(Clone, Serialize)]
pub struct PtyEvent {
    pub data: String,
    pub session_id: String,
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    pair: PtyPair,
    output_buf: Arc<Mutex<Vec<u8>>>,
    // Last (cols, rows) forwarded to ResizePseudoConsole.  On Windows, calling
    // ResizePseudoConsole with the same size still triggers a full screen repaint
    // that overwrites xterm's scrollback with only the last N visible rows.
    // Caching the size here lets us skip the call when nothing has changed.
    last_size: Mutex<(u16, u16)>,
}

pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[derive(Clone, serde::Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

#[cfg(windows)]
fn where_first(exe: &str) -> Option<String> {
    let out = std::process::Command::new("where").arg(exe).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.trim().lines().next()?.trim().to_string();
    if !line.is_empty() && std::path::Path::new(&line).exists() { Some(line) } else { None }
}

#[tauri::command]
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    #[cfg(windows)]
    {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());

        // Windows PowerShell — always present
        let ps1 = format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", system_root);
        if std::path::Path::new(&ps1).exists() {
            shells.push(ShellInfo { name: "Windows PowerShell".to_string(), path: ps1.clone(), args: vec![] });
        }

        // Command Prompt — always present
        let cmd_exe = std::env::var("COMSPEC")
            .unwrap_or_else(|_| format!("{}\\System32\\cmd.exe", system_root));
        if std::path::Path::new(&cmd_exe).exists() {
            shells.push(ShellInfo { name: "Command Prompt".to_string(), path: cmd_exe.clone(), args: vec![] });
        }

        // PowerShell 7 — check PATH and known install locations
        let pwsh7 = where_first("pwsh.exe").or_else(|| {
            let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
            for sub in &["PowerShell\\7\\pwsh.exe", "PowerShell\\7-preview\\pwsh.exe"] {
                let p = format!("{}\\{}", pf, sub);
                if std::path::Path::new(&p).exists() { return Some(p); }
            }
            None
        });
        if let Some(p) = pwsh7 {
            shells.push(ShellInfo { name: "PowerShell 7".to_string(), path: p, args: vec![] });
        }

        // Git Bash
        if let Some(p) = where_first("bash.exe") {
            shells.push(ShellInfo { name: "Git Bash".to_string(), path: p, args: vec![] });
        }

        // WSL
        if let Some(p) = where_first("wsl.exe") {
            shells.push(ShellInfo { name: "WSL".to_string(), path: p, args: vec![] });
        }

    }

    #[cfg(not(windows))]
    {
        let candidates: &[(&str, &str)] = &[
            ("/bin/zsh",               "zsh"),
            ("/usr/bin/zsh",           "zsh"),
            ("/bin/bash",              "bash"),
            ("/usr/bin/bash",          "bash"),
            ("/usr/local/bin/fish",    "fish"),
            ("/usr/bin/fish",          "fish"),
            ("/opt/homebrew/bin/fish", "fish"),
            ("/usr/local/bin/pwsh",    "PowerShell 7"),
            ("/opt/homebrew/bin/pwsh", "PowerShell 7"),
            ("/bin/sh",                "sh"),
            ("/bin/tcsh",              "tcsh"),
            ("/bin/csh",               "csh"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (path, name) in candidates {
            if std::path::Path::new(path).exists() && seen.insert(*name) {
                shells.push(ShellInfo { name: name.to_string(), path: path.to_string(), args: vec![] });
            }
        }
    }

    shells
}

#[tauri::command]
pub fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<Arc<PtyState>>,
    session_id: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    on_data: Channel<PtyEvent>,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let shell = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(args) = shell_args {
        for arg in args { cmd.arg(arg); }
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Signal to Claude Code hooks that this is a Betopia terminal
    cmd.env("BETOPIA_TERMINAL", "1");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }

    pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let output_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let output_buf_thread = Arc::clone(&output_buf);

    let sid = session_id.clone();
    let app_thread = app.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut detector = AgentDetector::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    // PTY closed — emit exited signal if agent was armed
                    let sid_exit = sid.clone();
                    detector.finish(|t: Transition| {
                        let sig = t.into_signal(sid_exit.clone());
                        let _ = app_thread.emit("betopia:agent-signal", sig);
                    });
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];

                    // Buffer output (keep last 64 KB)
                    {
                        let mut b = output_buf_thread.lock().unwrap();
                        b.extend_from_slice(chunk);
                        if b.len() > OUTPUT_BUFFER_MAX {
                            let start = b.len() - OUTPUT_BUFFER_MAX;
                            *b = b[start..].to_vec();
                        }
                    }

                    // Agent signal detection
                    let sid_sig = sid.clone();
                    let app_sig = app_thread.clone();
                    detector.process(chunk, |t: Transition| {
                        let sig = t.into_signal(sid_sig.clone());
                        let _ = app_sig.emit("betopia:agent-signal", sig);
                    });

                    // Forward decoded output to frontend
                    let data = String::from_utf8_lossy(chunk).to_string();
                    let _ = on_data.send(PtyEvent { data, session_id: sid.clone() });
                }
            }
        }
    });

    let initial_size = (size.cols, size.rows);
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(session_id, PtySession {
        writer,
        pair,
        output_buf,
        last_size: Mutex::new(initial_size),
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<Arc<PtyState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&session_id).ok_or("Session not found")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<Arc<PtyState>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&session_id).ok_or("Session not found")?;

    // Skip the resize when dimensions are unchanged.  On Windows,
    // ResizePseudoConsole fires a full ConPTY screen repaint even for same-size
    // calls, overwriting xterm's scrollback with only the last N visible rows.
    let mut last = session.last_size.lock().unwrap();
    if last.0 == cols && last.1 == rows {
        return Ok(());
    }
    *last = (cols, rows);
    drop(last);

    session.pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(
    state: tauri::State<Arc<PtyState>>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    sessions.remove(&session_id);
    Ok(())
}

fn trim_output_by_lines(text: String, lines: Option<usize>) -> String {
    let Some(n) = lines else {
        return text;
    };

    let result: Vec<&str> = text.lines().collect();
    if result.len() > n {
        result[result.len() - n..].join("\n")
    } else {
        text
    }
}

/// Read the buffered terminal output for a session.
///
/// - `lines = Some(n)`: return the last `n` lines.
/// - `lines = None`: return the full buffered output up to the 64 KB cap.
#[tauri::command]
pub fn pty_read_output(
    state: tauri::State<Arc<PtyState>>,
    session_id: String,
    lines: Option<usize>,
) -> Result<String, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&session_id).ok_or("Session not found")?;
    let buf = session.output_buf.lock().unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    drop(buf);
    drop(sessions);
    Ok(trim_output_by_lines(text, lines))
}

#[cfg(test)]
mod tests {
    use super::trim_output_by_lines;

    #[test]
    fn returns_full_output_when_line_limit_is_none() {
        let input = "line 1\nline 2\nline 3".to_string();
        assert_eq!(trim_output_by_lines(input.clone(), None), input);
    }

    #[test]
    fn returns_last_n_lines_when_output_is_longer() {
        let input = "line 1\nline 2\nline 3\nline 4\nline 5".to_string();
        assert_eq!(trim_output_by_lines(input, Some(3)), "line 3\nline 4\nline 5");
    }

    #[test]
    fn returns_full_output_when_limit_exceeds_length() {
        let input = "line 1\nline 2".to_string();
        assert_eq!(trim_output_by_lines(input.clone(), Some(10)), input);
    }
}
