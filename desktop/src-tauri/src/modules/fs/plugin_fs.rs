use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct PluginDirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
}

/// Resolve a path relative to a plugin's scoped data directory, ensuring it
/// stays within bounds (no path-traversal escape).
fn resolve_plugin_path(plugin_base: &str, relative_path: &str) -> Result<PathBuf, String> {
    let base = Path::new(plugin_base)
        .canonicalize()
        .map_err(|e| format!("Invalid plugin base path: {}", e))?;
    let rel = Path::new(relative_path);
    let joined = base.join(rel);
    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("Path does not exist or is invalid: {}", relative_path))?;
    if !canonical.starts_with(&base) {
        return Err(format!("Path traversal denied: {}", relative_path));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn plugin_read_file(plugin_data_dir: String, relative_path: String) -> Result<String, String> {
    let resolved = resolve_plugin_path(&plugin_data_dir, &relative_path)?;
    if !resolved.is_file() {
        return Err(format!("Not a file: {}", relative_path));
    }
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_write_file(
    plugin_data_dir: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let base = Path::new(&plugin_data_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid plugin base path: {}", e))?;
    let rel = Path::new(&relative_path);
    let joined = base.join(rel);
    // Create parent directories inside the scoped dir BEFORE canonicalizing if
    // the file doesn't exist yet — canonicalize would fail on non-existent paths.
    if let Some(parent) = joined.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create directories: {}", e))?;
    }
    let canonical = joined.canonicalize().or_else(|_| {
        // If the file still doesn't exist after create_dir_all, something is wrong
        Err("Failed to resolve path after creating parent directories".to_string())
    })?;
    if !canonical.starts_with(&base) {
        return Err(format!("Path traversal denied: {}", relative_path));
    }
    fs::write(&canonical, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_list_dir(
    plugin_data_dir: String,
    relative_path: String,
) -> Result<Vec<PluginDirEntry>, String> {
    let resolved = resolve_plugin_path(&plugin_data_dir, &relative_path)?;
    if !resolved.is_dir() {
        return Err(format!("Not a directory: {}", relative_path));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&resolved).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(PluginDirEntry {
            name,
            is_file,
            is_dir,
            size,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[tauri::command]
pub fn plugin_delete_file(plugin_data_dir: String, relative_path: String) -> Result<(), String> {
    let resolved = resolve_plugin_path(&plugin_data_dir, &relative_path)?;
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&resolved).map_err(|e| e.to_string())
    }
}
