use std::path::Path;
use serde::Serialize;
use ignore::WalkBuilder;
use glob::Pattern;

#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn fs_search(root: String, query: String, max_results: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", root));
    }

    let limit = max_results.unwrap_or(100);
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let walker = WalkBuilder::new(root_path)
        .hidden(false)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        if results.len() >= limit { break }
        let path = entry.path();
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if name.to_lowercase().contains(&query_lower) {
            let rel = path.strip_prefix(root_path).unwrap_or(path).to_string_lossy().replace('\\', "/");
            results.push(SearchResult { path: rel, name, is_dir: path.is_dir() });
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn fs_glob(root: String, pattern: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    let glob_pattern = Pattern::new(&pattern).map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    let walker = WalkBuilder::new(root_path)
        .hidden(false)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if path.is_dir() { continue }
        let rel = path.strip_prefix(root_path).unwrap_or(path).to_string_lossy().replace('\\', "/");
        if glob_pattern.matches(&rel) {
            results.push(rel);
        }
    }

    Ok(results)
}
