use std::sync::{Arc, Mutex};
#[cfg(windows)]
use tauri::Manager;

mod server;
mod modules;

use server::{LiveServer, StartResult};
use modules::{
    fs::{fs_read_file, fs_read_file_bytes, fs_write_file, fs_append_file, fs_stat, fs_create_dir, fs_delete, fs_rename, fs_read_dir, fs_grep, fs_search, fs_glob, plugin_read_file, plugin_write_file, plugin_list_dir, plugin_delete_file},
    shell::{shell_run_command, shell_bg_start, shell_bg_stop, shell_bg_stop_project, shell_bg_stop_all, shell_bg_logs, shell_bg_list, ShellBgState},
    shell::{stop_project_runtime_artifacts, stop_listening_ports},
    pty::{pty_open, pty_write, pty_resize, pty_close, pty_read_output, detect_shells, PtyState},
    secrets::{secrets_get, secrets_set, secrets_delete, secrets_list_keys},
    net::{lm_ping, ai_http_request, ai_http_stream, http_get},
    agent::{agent_enable_claude_hooks, agent_claude_hooks_status},
    skill_import::skill_import_git_repo,
    subagent_import::subagent_import_git_repo,
    watcher::WatcherState,
};

// ── Preview state ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct PublishResult {
    port: u16,
    url: String,
}

#[derive(serde::Serialize)]
struct LiveStartResult {
    port: u16,
    mode: String,
}

pub struct AppState {
    live_server: Arc<Mutex<LiveServer>>,
}

// ── Preview commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn start_live_server(state: tauri::State<'_, AppState>, project_path: String, port: u16) -> Result<LiveStartResult, String> {
    // Run blocking work (wait_for_port can take up to 30 s) off the async runtime
    // to avoid freezing the Tauri IPC thread / webview event loop.
    let server = Arc::clone(&state.live_server);
    tokio::task::spawn_blocking(move || {
        let mut s = server.lock().unwrap();
        let StartResult { port, mode } = s.start(project_path, port)?;
        Ok::<LiveStartResult, String>(LiveStartResult { port, mode })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn publish_project(state: tauri::State<'_, AppState>, project_path: String, port: u16) -> Result<PublishResult, String> {
    let server = Arc::clone(&state.live_server);
    tokio::task::spawn_blocking(move || {
        let mut s = server.lock().unwrap();
        let publish_port = s.publish(project_path, port)?;
        Ok::<PublishResult, String>(PublishResult { port: publish_port, url: format!("http://127.0.0.1:{}", publish_port) })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_preview_proxy(state: tauri::State<'_, AppState>, upstream_port: u16, port: u16) -> Result<LiveStartResult, String> {
    let server = Arc::clone(&state.live_server);
    tokio::task::spawn_blocking(move || {
        let mut s = server.lock().unwrap();
        let proxy_port = s.proxy_existing(upstream_port, port)?;
        Ok::<LiveStartResult, String>(LiveStartResult {
            port: proxy_port,
            mode: "runtime".to_string(),
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_live_server(state: tauri::State<AppState>) {
    let mut server = state.live_server.lock().unwrap();
    server.stop();
}

#[tauri::command]
fn export_project_zip(project_path: String, output_path: String) -> Result<String, String> {
    server::export_project_zip(&project_path, &output_path)?;
    Ok(output_path)
}

#[tauri::command]
fn export_project_file(project_path: String, file_path: String, output_path: String) -> Result<String, String> {
    server::export_project_file(&project_path, &file_path, &output_path)?;
    Ok(output_path)
}

// ── Port probe ────────────────────────────────────────────────────────────────

/// Check whether a TCP server is listening on localhost:port.
/// Uses a raw TCP connect so there are no CSP/CORS restrictions.
#[tauri::command]
fn probe_port(port: u16) -> bool {
    use std::net::{SocketAddr, Ipv6Addr, TcpStream};
    use std::time::Duration;
    let dur = Duration::from_millis(400);
    // Check 127.0.0.1 first (IPv4), then ::1 (IPv6).
    // Node 18+ resolves 'localhost' to ::1 on Linux, so dev servers may bind either address.
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), dur).is_ok()
        || TcpStream::connect_timeout(&SocketAddr::from((Ipv6Addr::LOCALHOST, port)), dur).is_ok()
}

// ── Window management ─────────────────────────────────────────────────────────

#[tauri::command]
async fn create_window(app: tauri::AppHandle) -> Result<(), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let label = format!("betopia-{}", ts);
    let win = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title("Betopia WebBuilder")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 640.0)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    set_window_icon(&win);
    #[cfg(not(windows))]
    let _ = &win;

    Ok(())
}

// ── Window icon ───────────────────────────────────────────────────────────────

#[cfg(windows)]
fn set_window_icon(win: &tauri::WebviewWindow) {
    let png = include_bytes!("../icons/128x128.png");
    if let Ok(decoded) = image::load_from_memory_with_format(png, image::ImageFormat::Png) {
        let rgba = decoded.into_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        let img = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
        let _ = win.set_icon(img);
    }
}

#[cfg(windows)]
fn set_all_window_icons(app: &tauri::AppHandle) {
    for win in app.webview_windows().values() {
        set_window_icon(win);
    }
}

// ── File watcher commands ─────────────────────────────────────────────────────

#[tauri::command]
fn start_file_watcher(
    project_path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    state.start(&project_path, app)
}

#[tauri::command]
fn stop_file_watcher(state: tauri::State<'_, WatcherState>) {
    state.stop();
}

// ── App bootstrap ─────────────────────────────────────────────────────────────

pub fn run() {
    let app_state = AppState {
        live_server: Arc::new(Mutex::new(LiveServer::new())),
    };
    let shell_bg_state = Arc::new(ShellBgState::new());
    let pty_state = Arc::new(PtyState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .manage(shell_bg_state)
        .manage(pty_state)
        .manage(WatcherState::new())
        .invoke_handler(tauri::generate_handler![
            // Preview
            start_live_server,
            publish_project,
            start_preview_proxy,
            stop_live_server,
            export_project_zip,
            export_project_file,
            // File system
            fs_read_file,
            fs_read_file_bytes,
            fs_write_file,
            fs_append_file,
            fs_stat,
            fs_create_dir,
            fs_delete,
            fs_rename,
            fs_read_dir,
            fs_grep,
            fs_search,
            fs_glob,
            // Plugin scoped file system
            plugin_read_file,
            plugin_write_file,
            plugin_list_dir,
            plugin_delete_file,
            // Shell
            shell_run_command,
            shell_bg_start,
            shell_bg_stop,
            shell_bg_stop_project,
            shell_bg_stop_all,
            shell_bg_logs,
            shell_bg_list,
            stop_project_runtime_artifacts,
            stop_listening_ports,
            // PTY
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_read_output,
            detect_shells,
            // Secrets
            secrets_get,
            secrets_set,
            secrets_delete,
            secrets_list_keys,
            // Network proxy
            lm_ping,
            ai_http_request,
            ai_http_stream,
            http_get,
            // Skill import
            skill_import_git_repo,
            subagent_import_git_repo,
            // Agent detection + Claude hooks
            agent_enable_claude_hooks,
            agent_claude_hooks_status,
            // Port probe (TCP — no CSP restrictions)
            probe_port,
            // Window management
            create_window,
            // File watcher
            start_file_watcher,
            stop_file_watcher,
        ])
        .setup(|app| {
            #[cfg(not(windows))]
            let _ = &app;
            #[cfg(windows)]
            {
                let app_handle = app.handle().clone();
                set_all_window_icons(&app_handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
