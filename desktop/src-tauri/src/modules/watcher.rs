use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct FileChangedPayload {
    pub paths: Vec<String>,
}

pub struct WatcherState {
    inner: Mutex<Option<RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn start(&self, project_path: &str, app: AppHandle) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<notify::Event, notify::Error>>();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        watcher
            .watch(Path::new(project_path), RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch project path: {}", e))?;

        let app_clone = app.clone();
        thread::spawn(move || {
            let mut pending: Vec<String> = Vec::new();
            let debounce = Duration::from_millis(200);

            loop {
                match rx.recv_timeout(debounce) {
                    Ok(Ok(event)) => {
                        match event.kind {
                            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                            _ => continue,
                        }
                        for path in &event.paths {
                            let s = path.to_string_lossy().to_string();
                            if should_ignore(&s) {
                                continue;
                            }
                            pending.push(s);
                        }
                    }
                    Ok(Err(_)) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !pending.is_empty() {
                            let _ = app_clone.emit(
                                "betopia:file-changed",
                                FileChangedPayload {
                                    paths: pending.drain(..).collect(),
                                },
                            );
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            let _ = app_clone.emit(
                                "betopia:file-changed",
                                FileChangedPayload { paths: pending },
                            );
                        }
                        return;
                    }
                }
            }
        });

        *self.inner.lock().unwrap() = Some(watcher);
        Ok(())
    }

    pub fn stop(&self) {
        self.inner.lock().unwrap().take();
    }
}

fn should_ignore(p: &str) -> bool {
    let segments: Vec<&str> = p.split('/').collect();
    for seg in &segments {
        match *seg {
            ".git" | "node_modules" | "dist" | "build" | ".next" | ".svelte-kit" | ".betopia" => {
                return true;
            }
            _ => {}
        }
    }
    p.ends_with(".DS_Store")
}
