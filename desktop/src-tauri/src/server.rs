use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::{Server, Response, Header};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

// Suppress the CMD window that would otherwise flash on Windows
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Copy)]
enum PreviewMode {
    Static,
    Runtime,
}

impl PreviewMode {
    fn as_str(self) -> &'static str {
        match self {
            PreviewMode::Static => "static",
            PreviewMode::Runtime => "runtime",
        }
    }
}

pub struct StartResult {
    pub port: u16,
    pub mode: String,
}

pub struct LiveServer {
    thread_handle: Option<JoinHandle<()>>,
    server: Option<Arc<Server>>,
    runtime_process: Option<Child>,
    project_path: Arc<Mutex<String>>,
}

impl LiveServer {
    pub fn new() -> Self {
        LiveServer {
            thread_handle: None,
            server: None,
            runtime_process: None,
            project_path: Arc::new(Mutex::new(String::new())),
        }
    }

    pub fn start(&mut self, project_path: String, port: u16) -> Result<StartResult, String> {
        self.stop();
        let selected_port = reserve_preview_port(port)?;
        let mut runtime_error_message: Option<String> = None;
        match try_start_runtime_preview(&project_path, selected_port) {
            Ok(Some(child)) => {
                *self.project_path.lock().unwrap() = project_path;
                self.runtime_process = Some(child);
                return Ok(StartResult {
                    port: selected_port,
                    mode: PreviewMode::Runtime.as_str().to_string(),
                });
            }
            Ok(None) => {}
            Err(runtime_error) => {
                runtime_error_message = Some(runtime_error);
            }
        }

        let static_port = match self.start_with_root(project_path, selected_port) {
            Ok(port) => port,
            Err(static_error) => {
                if let Some(runtime_error) = runtime_error_message {
                    return Err(format!(
                        "Runtime preview failed: {} | Static preview failed: {}",
                        runtime_error, static_error
                    ));
                }
                return Err(static_error);
            }
        };
        Ok(StartResult {
            port: static_port,
            mode: PreviewMode::Static.as_str().to_string(),
        })
    }

    pub fn publish(&mut self, project_path: String, port: u16) -> Result<u16, String> {
        self.stop();
        let build_root = build_project(&project_path)?;
        let selected_port = reserve_preview_port(port)?;
        self.start_with_root(build_root.to_string_lossy().to_string(), selected_port)
    }

    fn start_with_root(&mut self, project_path: String, port: u16) -> Result<u16, String> {
        // For Node/React source projects: serve the built output folder.
        // Checks common output dirs in priority order; falls back to project root.
        let serve_root = {
            let p = Path::new(&project_path);
            if p.join("package.json").exists() {
                let candidates = ["dist", "build", "out", ".next/static"];
                candidates.iter()
                    .map(|d| p.join(d))
                    .find(|d| d.join("index.html").exists())
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_else(|| project_path.clone())
            } else {
                project_path.clone()
            }
        };

        // Stop any existing server first
        self.stop();

        // Small delay to ensure socket is released
        std::thread::sleep(Duration::from_millis(100));

        let project_path = serve_root;

        // Try to bind to the specified port
        let addr = format!("127.0.0.1:{}", port);
        let server = Arc::new(
            Server::http(&addr)
                .map_err(|e| format!("Failed to start server on port {}: {}", port, e))?,
        );

        *self.project_path.lock().unwrap() = project_path.clone();

        let project_path_arc = Arc::clone(&self.project_path);
        let server_for_thread = Arc::clone(&server);

        // Spawn server thread
        let handle = thread::spawn(move || {
            for request in server_for_thread.incoming_requests() {
                let project_path = project_path_arc.lock().unwrap().clone();
                let response = handle_request(&project_path, request.url());
                let _ = request.respond(response);
            }
        });

        self.thread_handle = Some(handle);
        self.server = Some(server);
        Ok(port)
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.runtime_process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Unblock the request loop first, then join thread.
        if let Some(server) = self.server.take() {
            server.unblock();
        }

        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

fn build_project(project_path: &str) -> Result<PathBuf, String> {
    let npm_command = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let mut build_cmd = Command::new(npm_command);
    build_cmd.arg("run").arg("build").current_dir(project_path);
    #[cfg(windows)]
    build_cmd.creation_flags(CREATE_NO_WINDOW);
    let status = build_cmd
        .status()
        .map_err(|error| format!("Failed to start build: {}", error))?;

    if !status.success() {
        return Err("Project build failed".to_string());
    }

    let dist_path = Path::new(project_path).join("dist");
    if !dist_path.exists() {
        return Err("Build completed but dist folder was not created".to_string());
    }

    Ok(dist_path)
}

fn reserve_preview_port(preferred: u16) -> Result<u16, String> {
    // Scan preferred..preferred+100 for next available port.
    let end = preferred.saturating_add(100);
    for port in preferred..=end {
        if is_port_available(port) {
            return Ok(port);
        }
    }
    Err(format!("No available port in range {}–{}", preferred, end))
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn try_start_runtime_preview(project_path: &str, port: u16) -> Result<Option<Child>, String> {
    let root = Path::new(project_path);
    let candidate = detect_runtime_command(root, port)?;
    let Some((exec, args)) = candidate else {
        return Ok(None);
    };

    if !command_available(&exec) {
        return Err(format!("Preview command not available: {}", exec));
    }

    let mut command = Command::new(&exec);
    command
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("HOSTNAME", "127.0.0.1")
        .env("BIND_ADDR", "127.0.0.1")
        .env("ROCKET_ADDRESS", "127.0.0.1")
        .env("ROCKET_PORT", port.to_string())
        .env("FLASK_RUN_HOST", "127.0.0.1")
        .env("FLASK_RUN_PORT", port.to_string());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start runtime preview: {}", error))?;

    if !wait_for_port("127.0.0.1", port, Duration::from_secs(30)) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Runtime preview did not become ready on port {}", port));
    }

    Ok(Some(child))
}

fn detect_runtime_command(root: &Path, port: u16) -> Result<Option<(String, Vec<String>)>, String> {
    if root.join("package.json").exists() {
        // Skip npm/node runtime if node_modules not installed — would block 30s for nothing
        if !root.join("node_modules").exists() {
            return Ok(None);
        }
        // If the project has a vite config, always prefer the dev server (it has the
        // API proxy, hot-reload, and the correct port). Only fall back to static serving
        // when dist/index.html exists AND there is no vite config (i.e. this is a pure
        // deployment artifact dropped into the project folder, not an active dev project).
        let has_vite_config = root.join("vite.config.js").exists()
            || root.join("vite.config.ts").exists()
            || root.join("vite.config.mjs").exists()
            || root.join("vite.config.cjs").exists();
        if !has_vite_config && root.join("dist").join("index.html").exists() {
            return Ok(None);
        }
        let scripts = read_package_scripts(root)?;
        if scripts.contains("dev") {
            return Ok(Some(node_dev_command(root, port)));
        }
        if scripts.contains("start") {
            return Ok(Some(node_start_command(root)));
        }
        if scripts.contains("preview") {
            return Ok(Some(node_preview_command(root, port)));
        }
    }

    if root.join("Cargo.toml").exists() {
        if root.join("Trunk.toml").exists() || root.join("index.html").exists() {
            return Ok(Some((
                platform_exec("trunk"),
                vec![
                    "serve".to_string(),
                    "--address".to_string(),
                    "127.0.0.1".to_string(),
                    "--port".to_string(),
                    port.to_string(),
                ],
            )));
        }
        return Ok(Some((platform_exec("cargo"), vec!["run".to_string()])));
    }

    if root.join("go.mod").exists() || root.join("main.go").exists() {
        return Ok(Some((platform_exec("go"), vec!["run".to_string(), ".".to_string()])));
    }

    // Django
    if root.join("manage.py").exists() {
        return Ok(Some((
            python_exec(),
            vec!["manage.py".to_string(), "runserver".to_string(), format!("127.0.0.1:{}", port)],
        )));
    }

    // Flask / FastAPI / generic Python
    if root.join("requirements.txt").exists() || root.join("pyproject.toml").exists() {
        if let Some(cmd) = detect_python_server(root, port) {
            return Ok(Some(cmd));
        }
    }

    Ok(None)
}

fn detect_package_manager(root: &Path) -> &'static str {
    if root.join("bun.lockb").exists() || root.join("bun.lock").exists() { return "bun"; }
    if root.join("pnpm-lock.yaml").exists() { return "pnpm"; }
    if root.join("yarn.lock").exists() { return "yarn"; }
    "npm"
}

// Returns a short string identifying the JS framework in use.
fn detect_node_framework(root: &Path) -> &'static str {
    let configs: &[(&str, &str)] = &[
        ("next.config.js", "next"),  ("next.config.ts", "next"),
        ("next.config.mjs", "next"), ("next.config.cjs", "next"),
        ("vite.config.js", "vite"),  ("vite.config.ts", "vite"),
        ("vite.config.mjs", "vite"), ("vite.config.cjs", "vite"),
        ("angular.json", "angular"),
        ("nuxt.config.js", "nuxt"),  ("nuxt.config.ts", "nuxt"),
        ("nuxt.config.mjs", "nuxt"),
        ("svelte.config.js", "vite"), ("svelte.config.ts", "vite"),
        ("astro.config.js", "astro"), ("astro.config.ts", "astro"),
        ("astro.config.mjs", "astro"),
        ("remix.config.js", "remix"), ("remix.config.cjs", "remix"),
    ];
    for (file, fw) in configs {
        if root.join(file).exists() { return fw; }
    }
    if let Ok(raw) = fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let has = |name: &str| -> bool {
                json.get("dependencies").and_then(|d| d.get(name)).is_some()
                    || json.get("devDependencies").and_then(|d| d.get(name)).is_some()
            };
            if has("next") { return "next"; }
            if has("vite") { return "vite"; }
            if has("react-scripts") { return "cra"; }
            if has("@angular/core") { return "angular"; }
            if has("nuxt") { return "nuxt"; }
            if has("astro") { return "astro"; }
            if has("@remix-run/react") || has("@remix-run/node") { return "remix"; }
        }
    }
    "generic"
}

fn node_dev_command(root: &Path, port: u16) -> (String, Vec<String>) {
    let pm = detect_package_manager(root);
    let fw = detect_node_framework(root);

    // Extra args forwarded to the underlying dev script, chosen per framework.
    // CRA and PORT-respecting frameworks get no args — PORT env var is already set.
    let extra: Vec<String> = match fw {
        "next" => vec!["-p".to_string(), port.to_string(), "-H".to_string(), "127.0.0.1".to_string()],
        "angular" => vec!["--port".to_string(), port.to_string(), "--host".to_string(), "127.0.0.1".to_string()],
        "cra" => vec![], // react-scripts reads PORT env var
        // Vite, Nuxt, Svelte (SvelteKit), Astro, Remix, generic — all accept Vite-style flags
        _ => vec!["--host".to_string(), "127.0.0.1".to_string(), "--port".to_string(), port.to_string(), "--no-open".to_string()],
    };

    match pm {
        "bun" => {
            let mut args = vec!["run".to_string(), "dev".to_string()];
            args.extend(extra);
            (platform_exec("bun"), args)
        }
        "pnpm" => {
            let mut args = vec!["dev".to_string()];
            args.extend(extra);
            (platform_exec("pnpm"), args)
        }
        "yarn" => {
            let mut args = vec!["dev".to_string()];
            args.extend(extra);
            (platform_exec("yarn"), args)
        }
        _ => {
            let mut args = vec!["run".to_string(), "dev".to_string()];
            if !extra.is_empty() { args.push("--".to_string()); args.extend(extra); }
            (platform_exec("npm"), args)
        }
    }
}

fn node_start_command(root: &Path) -> (String, Vec<String>) {
    match detect_package_manager(root) {
        "bun" => (platform_exec("bun"), vec!["run".to_string(), "start".to_string()]),
        "pnpm" => (platform_exec("pnpm"), vec!["start".to_string()]),
        "yarn" => (platform_exec("yarn"), vec!["start".to_string()]),
        _ => (platform_exec("npm"), vec!["run".to_string(), "start".to_string()]),
    }
}

fn node_preview_command(root: &Path, port: u16) -> (String, Vec<String>) {
    let pm = detect_package_manager(root);
    let extra = vec!["--host".to_string(), "127.0.0.1".to_string(), "--port".to_string(), port.to_string()];
    match pm {
        "bun" => {
            let mut args = vec!["run".to_string(), "preview".to_string()];
            args.extend(extra);
            (platform_exec("bun"), args)
        }
        "pnpm" => {
            let mut args = vec!["preview".to_string()];
            args.extend(extra);
            (platform_exec("pnpm"), args)
        }
        "yarn" => {
            let mut args = vec!["preview".to_string()];
            args.extend(extra);
            (platform_exec("yarn"), args)
        }
        _ => {
            let mut args = vec!["run".to_string(), "preview".to_string(), "--".to_string()];
            args.extend(extra);
            (platform_exec("npm"), args)
        }
    }
}

fn python_exec() -> String {
    if cfg!(windows) { "python".to_string() } else { "python3".to_string() }
}

fn detect_python_server(root: &Path, port: u16) -> Option<(String, Vec<String>)> {
    let req = fs::read_to_string(root.join("requirements.txt")).unwrap_or_default().to_lowercase();
    let pyproject = fs::read_to_string(root.join("pyproject.toml")).unwrap_or_default().to_lowercase();
    let all = format!("{}\n{}", req, pyproject);

    if all.contains("fastapi") || all.contains("uvicorn") {
        let entry = if root.join("main.py").exists() { "main:app" } else { "app:app" };
        return Some((
            "uvicorn".to_string(),
            vec![
                entry.to_string(),
                "--host".to_string(), "127.0.0.1".to_string(),
                "--port".to_string(), port.to_string(),
                "--reload".to_string(),
            ],
        ));
    }

    if all.contains("flask") {
        return Some((
            "flask".to_string(),
            vec!["run".to_string(), "--host".to_string(), "127.0.0.1".to_string(), "--port".to_string(), port.to_string()],
        ));
    }

    for entry in &["app.py", "main.py", "server.py", "run.py", "index.py"] {
        if root.join(entry).exists() {
            return Some((python_exec(), vec![entry.to_string()]));
        }
    }
    None
}

fn read_package_scripts(root: &Path) -> Result<std::collections::HashSet<String>, String> {
    let package_path = root.join("package.json");
    let raw = fs::read_to_string(&package_path)
        .map_err(|error| format!("Failed to read package.json: {}", error))?;
    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid package.json: {}", error))?;

    let mut scripts = std::collections::HashSet::new();
    if let Some(obj) = json.get("scripts").and_then(|value| value.as_object()) {
        for key in obj.keys() {
            scripts.insert(key.to_string());
        }
    }
    Ok(scripts)
}

fn platform_exec(base: &str) -> String {
    if cfg!(windows) {
        match base {
            "npm" | "pnpm" | "yarn" => format!("{}.cmd", base),
            _ => format!("{}.exe", base),
        }
    } else {
        base.to_string()
    }
}

fn command_available(executable: &str) -> bool {
    for arg in ["--version", "version", "-V"] {
        let mut cmd = Command::new(executable);
        cmd.arg(arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let status = cmd.status();
        if status.map(|s| s.success()).unwrap_or(false) {
            return true;
        }
    }
    false
}

fn wait_for_port(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if TcpStream::connect((host, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn export_project_zip(project_path: &str, output_path: &str) -> Result<(), String> {
    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let out_path = Path::new(output_path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }
    if out_path.exists() {
        fs::remove_file(out_path)
            .map_err(|e| format!("Failed to replace existing ZIP file: {}", e))?;
    }

    if cfg!(target_os = "windows") {
        return export_zip_windows(root, out_path);
    }

    export_zip_unix(root, out_path)
}

pub fn export_project_file(project_path: &str, file_path: &str, output_path: &str) -> Result<(), String> {
    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let rel = Path::new(file_path);
    if rel.is_absolute() {
        return Err("File path must be relative".to_string());
    }
    for component in rel.components() {
        use std::path::Component;
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid file path".to_string());
            }
            _ => {}
        }
    }

    let source = root.join(rel);
    if !source.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    if !source.is_file() {
        return Err(format!("Path is not a file: {}", file_path));
    }

    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    let source_canonical = source
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;
    if !source_canonical.starts_with(&root_canonical) {
        return Err("File is outside the project directory".to_string());
    }

    let out_path = Path::new(output_path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }
    if out_path.exists() {
        fs::remove_file(out_path)
            .map_err(|e| format!("Failed to replace existing file: {}", e))?;
    }

    fs::copy(&source_canonical, out_path)
        .map_err(|e| format!("Failed to export file: {}", e))?;
    Ok(())
}

fn export_zip_windows(root: &Path, out_path: &Path) -> Result<(), String> {
    let source_glob = root.join("*");
    let cmd = format!(
        "Compress-Archive -Path '{}' -DestinationPath '{}' -Force",
        escape_powershell_single_quote(source_glob.to_string_lossy().as_ref()),
        escape_powershell_single_quote(out_path.to_string_lossy().as_ref()),
    );

    let mut ps_cmd = Command::new("powershell");
    ps_cmd.arg("-NoProfile").arg("-NonInteractive").arg("-Command").arg(cmd);
    #[cfg(windows)]
    ps_cmd.creation_flags(CREATE_NO_WINDOW);
    let status = ps_cmd
        .status()
        .map_err(|e| format!("Failed to start ZIP export: {}", e))?;

    if !status.success() {
        return Err("ZIP export failed".to_string());
    }
    Ok(())
}

fn export_zip_unix(root: &Path, out_path: &Path) -> Result<(), String> {
    let out_name = out_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid output ZIP filename".to_string())?;

    let status = Command::new("zip")
        .arg("-r")
        .arg(out_name)
        .arg(".")
        .current_dir(root)
        .status()
        .map_err(|e| format!("Failed to start ZIP export: {}", e))?;

    if !status.success() {
        return Err("ZIP export failed".to_string());
    }

    let produced = root.join(out_name);
    if produced != out_path {
        fs::rename(&produced, out_path)
            .or_else(|_| {
                fs::copy(&produced, out_path)?;
                fs::remove_file(&produced)?;
                Ok::<(), std::io::Error>(())
            })
            .map_err(|e| format!("Failed to move ZIP file to destination: {}", e))?;
    }

    Ok(())
}

fn escape_powershell_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn handle_request(project_path: &str, url: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    if project_path.is_empty() {
        return Response::from_string("Server not initialized").with_status_code(500);
    }

    let path_only = url
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(url)
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(url);

    let mut file_path = path_only.trim_start_matches('/').to_string();

    if let Some(rest) = file_path.strip_prefix("preview/") {
        file_path = rest.to_string();
    } else if file_path == "preview" {
        file_path.clear();
    }

    // If root or directory, try index.html
    if file_path.is_empty() || file_path.ends_with('/') {
        file_path = "index.html".to_string();
    }

    let root_path = Path::new(project_path);
    let full_path = root_path.join(&file_path);

    // Security: prevent directory traversal
    if !full_path.starts_with(root_path) {
        return Response::from_string("Forbidden").with_status_code(403);
    }

    // Try to read the file
    match fs::read(&full_path) {
        Ok(content) => {
            let mime_type = get_mime_type(&file_path);
            Response::from_data(content)
                .with_header(Header::from_bytes(&b"Content-Type"[..], mime_type.as_bytes()).unwrap())
        }
        Err(_) => {
            // Try index.html if file not found
            if !file_path.ends_with("index.html") {
                let index_path = Path::new(project_path).join("index.html");
                if let Ok(content) = fs::read(&index_path) {
                    return Response::from_data(content)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], b"text/html").unwrap());
                }
            }
            if let Some(fallback_html) = find_fallback_html(root_path) {
                if let Ok(content) = fs::read(&fallback_html) {
                    return Response::from_data(content)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], b"text/html").unwrap());
                }
            }
            Response::from_string("Not Found").with_status_code(404)
        }
    }
}

fn find_fallback_html(root: &Path) -> Option<PathBuf> {
    let preferred = ["index.html", "main.html", "app.html", "home.html", "login.html"];
    let mut stack = vec![root.to_path_buf()];
    let mut first_html: Option<PathBuf> = None;
    let mut best_match: Option<(usize, PathBuf)> = None;

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                if matches!(dir_name, ".git" | ".betopia" | "node_modules") {
                    continue;
                }
                stack.push(path);
                continue;
            }

            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
            if !file_name.ends_with(".html") && !file_name.ends_with(".htm") {
                continue;
            }

            if first_html.is_none() {
                first_html = Some(path.clone());
            }

            if let Some(rank) = preferred.iter().position(|name| *name == file_name) {
                if best_match.as_ref().map(|(current, _)| rank < *current).unwrap_or(true) {
                    best_match = Some((rank, path.clone()));
                }
            }
        }
    }

    best_match.map(|(_, path)| path).or(first_html)
}

fn get_mime_type(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8".to_string()
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8".to_string()
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        "application/javascript; charset=utf-8".to_string()
    } else if lower.ends_with(".json") || lower.ends_with(".map") {
        "application/json".to_string()
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".jsx") {
        "application/javascript; charset=utf-8".to_string()
    } else if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else if lower.ends_with(".webp") {
        "image/webp".to_string()
    } else if lower.ends_with(".avif") {
        "image/avif".to_string()
    } else if lower.ends_with(".ico") {
        "image/x-icon".to_string()
    } else if lower.ends_with(".woff") {
        "font/woff".to_string()
    } else if lower.ends_with(".woff2") {
        "font/woff2".to_string()
    } else if lower.ends_with(".ttf") {
        "font/ttf".to_string()
    } else if lower.ends_with(".otf") {
        "font/otf".to_string()
    } else if lower.ends_with(".eot") {
        "application/vnd.ms-fontobject".to_string()
    } else if lower.ends_with(".mp4") {
        "video/mp4".to_string()
    } else if lower.ends_with(".webm") {
        "video/webm".to_string()
    } else if lower.ends_with(".mp3") {
        "audio/mpeg".to_string()
    } else if lower.ends_with(".ogg") {
        "audio/ogg".to_string()
    } else if lower.ends_with(".xml") {
        "application/xml".to_string()
    } else if lower.ends_with(".txt") || lower.ends_with(".md") {
        "text/plain; charset=utf-8".to_string()
    } else if lower.ends_with(".pdf") {
        "application/pdf".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::get_mime_type;

    #[test]
    fn detects_html_mime_type() {
        assert_eq!(get_mime_type("index.html"), "text/html");
    }

    #[test]
    fn detects_js_mime_type() {
        assert_eq!(get_mime_type("assets/app.js"), "application/javascript");
    }
}
