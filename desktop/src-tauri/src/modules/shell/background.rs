use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use serde::Serialize;

#[cfg(windows)]
use std::ptr::null_mut;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE, TerminateProcess,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

pub struct ShellBgState {
    processes: Mutex<HashMap<String, BgProcess>>,
}

impl ShellBgState {
    pub fn new() -> Self {
        Self { processes: Mutex::new(HashMap::new()) }
    }
}

#[cfg(windows)]
struct WindowsJob(HANDLE);

#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn new_for_child(child: &Child) -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(null_mut(), null_mut());
            if handle == null_mut() {
                return Err(format!("CreateJobObjectW failed: {}", std::io::Error::last_os_error()));
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return Err(format!("SetInformationJobObject failed: {}", std::io::Error::last_os_error()));
            }

            let process = OpenProcess(
                PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                child.id(),
            );
            if process == null_mut() {
                CloseHandle(handle);
                return Err(format!("OpenProcess failed: {}", std::io::Error::last_os_error()));
            }

            let assigned = AssignProcessToJobObject(handle, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(handle);
                return Err(format!("AssignProcessToJobObject failed: {}", std::io::Error::last_os_error()));
            }

            Ok(Self(handle))
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            if self.0 != null_mut() {
                CloseHandle(self.0);
            }
        }
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
        #[cfg(windows)]
        let _ = existing.job.take();
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

    // On Unix, put each bg process in its own process group (pgid = child pid).
    // This lets kill_process_group() send SIGKILL to the entire subtree (sh + npm + vite/node)
    // without accidentally killing the Tauri app's own process group.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let job = WindowsJob::new_for_child(&child).ok();

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

    procs.insert(id, BgProcess {
        child,
        logs,
        command,
        cwd: work_dir,
        #[cfg(windows)]
        job,
    });
    Ok(())
}

fn kill_process_tree(proc: &mut BgProcess) {
    #[cfg(windows)]
    {
        let _ = proc.job.take();
    }
    #[cfg(unix)]
    {
        let pid = proc.child.id() as i32;
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -9 -- -{} 2>/dev/null; true", pid))
            .status();
    }
    let _ = proc.child.kill();
    let _ = proc.child.wait();
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        unsafe {
            let handle = OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if handle != null_mut() {
                let _ = TerminateProcess(handle, 1);
                CloseHandle(handle);
                return;
            }
        }

        let _ = Command::new("taskkill.exe")
            .arg("/F")
            .arg("/T")
            .arg("/PID")
            .arg(pid.to_string())
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -9 {} 2>/dev/null; true", pid))
            .status();
    }
}

#[tauri::command]
pub fn stop_project_runtime_artifacts(project_path: String) -> Result<usize, String> {
    let pid_file = Path::new(&project_path).join(".betopia_pids.json");
    let mut stopped = 0usize;

    if let Ok(raw) = fs::read_to_string(&pid_file) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(obj) = value.as_object() {
                for v in obj.values() {
                    if let Some(pid) = v.as_u64().map(|n| n as u32) {
                        kill_pid(pid);
                        stopped += 1;
                    }
                }
            }
        }
        let _ = fs::remove_file(&pid_file);
    }

    Ok(stopped)
}

#[tauri::command]
pub fn stop_listening_ports(ports: Vec<u16>) -> Result<usize, String> {
    let target_ports: HashSet<u16> = ports.into_iter().filter(|p| *p > 0).collect();
    if target_ports.is_empty() {
        return Ok(0);
    }

    let mut stopped = 0usize;

    #[cfg(windows)]
    {
        let output = Command::new("netstat.exe")
            .arg("-ano")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut pids = HashSet::<u32>::new();

        for line in stdout.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 {
                continue;
            }
            if cols[3] != "LISTENING" {
                continue;
            }
            let port = cols[1]
                .rsplit(':')
                .next()
                .and_then(|s| s.parse::<u16>().ok());
            if let Some(port) = port {
                if target_ports.contains(&port) {
                    if let Ok(pid) = cols[4].parse::<u32>() {
                        pids.insert(pid);
                    }
                }
            }
        }

        for pid in pids {
            kill_pid(pid);
            stopped += 1;
        }

    }

    #[cfg(not(windows))]
    {
        for port in target_ports {
            let mut pids = HashSet::<u32>::new();

            if let Ok(output) = Command::new("lsof")
                .arg("-ti")
                .arg(format!("tcp:{port}"))
                .output()
            {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        pids.insert(pid);
                    }
                }
            }

            for pid in pids {
                let _ = Command::new("kill")
                    .arg("-9")
                    .arg(pid.to_string())
                    .status();
                stopped += 1;
            }
        }
    }

    Ok(stopped)
}

#[tauri::command]
pub fn shell_bg_stop(state: tauri::State<Arc<ShellBgState>>, id: String) -> Result<(), String> {
    let mut procs = state.processes.lock().unwrap();
    if let Some(mut proc) = procs.remove(&id) {
        kill_process_tree(&mut proc);
    }
    Ok(())
}

fn normalize_scope_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized = normalized.trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized = normalized.to_lowercase();
    }
    normalized
}

fn is_path_under_scope(cwd: &str, scope: &str) -> bool {
    let cwd = normalize_scope_path(cwd);
    let scope = normalize_scope_path(scope);
    if cwd.is_empty() || scope.is_empty() {
        return false;
    }
    cwd == scope || cwd.starts_with(&(scope.to_string() + "/"))
}

#[tauri::command]
pub fn shell_bg_stop_project(state: tauri::State<Arc<ShellBgState>>, project_path: String) -> Result<usize, String> {
    let mut procs = state.processes.lock().unwrap();
    let mut kept = HashMap::new();
    let mut stopped = 0usize;

    for (id, mut proc) in procs.drain() {
        if is_path_under_scope(&proc.cwd, &project_path) {
            kill_process_tree(&mut proc);
            stopped += 1;
        } else {
            kept.insert(id, proc);
        }
    }

    *procs = kept;
    Ok(stopped)
}

/// Kill ALL background processes at once â€” called on project close to free memory/ports.
#[tauri::command]
pub fn shell_bg_stop_all(state: tauri::State<Arc<ShellBgState>>) -> () {
    let mut procs = state.processes.lock().unwrap();
    for (_, mut proc) in procs.drain() {
        kill_process_tree(&mut proc);
    }
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
