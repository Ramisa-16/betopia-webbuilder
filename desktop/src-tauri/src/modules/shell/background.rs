use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use serde::Serialize;

const LOG_RING_SIZE: usize = 500;

#[derive(Clone, Serialize)]
pub struct BgProcessInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub running: bool,
}

struct BgProcess {
    child: Child,
    logs: Arc<Mutex<Vec<String>>>,
    command: String,
    cwd: String,
}

pub struct ShellBgState {
    processes: Mutex<HashMap<String, BgProcess>>,
}

impl ShellBgState {
    pub fn new() -> Self {
        Self { processes: Mutex::new(HashMap::new()) }
    }
}

#[tauri::command]
pub fn shell_bg_start(
    state: tauri::State<Arc<ShellBgState>>,
    id: String,
    command: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut procs = state.processes.lock().unwrap();

    // Kill existing process with same id
    if let Some(mut existing) = procs.remove(&id) {
        let _ = existing.child.kill();
        let _ = existing.child.wait();
    }

    let work_dir = cwd.unwrap_or_else(|| ".".to_string());

    let (shell, flag) = if cfg!(windows) { ("cmd.exe", "/C") } else { ("sh", "-c") };

    let mut cmd = Command::new(shell);
    cmd.arg(flag)
        .arg(&command)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Prevent a visible CMD window from flashing on Windows
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let logs = Arc::new(Mutex::new(Vec::<String>::new()));

    // Capture stdout in background thread
    if let Some(stdout) = child.stdout.take() {
        let logs_clone = Arc::clone(&logs);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let mut l = logs_clone.lock().unwrap();
                if l.len() >= LOG_RING_SIZE { l.remove(0); }
                l.push(line);
            }
        });
    }

    // Capture stderr in background thread
    if let Some(stderr) = child.stderr.take() {
        let logs_clone = Arc::clone(&logs);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let mut l = logs_clone.lock().unwrap();
                if l.len() >= LOG_RING_SIZE { l.remove(0); }
                l.push(format!("[stderr] {}", line));
            }
        });
    }

    procs.insert(id, BgProcess { child, logs, command, cwd: work_dir });
    Ok(())
}

#[tauri::command]
pub fn shell_bg_stop(state: tauri::State<Arc<ShellBgState>>, id: String) -> Result<(), String> {
    let mut procs = state.processes.lock().unwrap();
    if let Some(mut proc) = procs.remove(&id) {
        proc.child.kill().map_err(|e| e.to_string())?;
        let _ = proc.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn shell_bg_logs(state: tauri::State<Arc<ShellBgState>>, id: String) -> Vec<String> {
    let procs = state.processes.lock().unwrap();
    procs.get(&id).map(|p| p.logs.lock().unwrap().clone()).unwrap_or_default()
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<Arc<ShellBgState>>) -> Vec<BgProcessInfo> {
    let procs = state.processes.lock().unwrap();
    procs
        .iter()
        .map(|(id, p)| BgProcessInfo {
            id: id.clone(),
            command: p.command.clone(),
            cwd: p.cwd.clone(),
            running: true,
        })
        .collect()
}
