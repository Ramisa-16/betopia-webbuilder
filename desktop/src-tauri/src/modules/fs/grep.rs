use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[tauri::command]
pub fn fs_grep(
    root: String,
    pattern: String,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<Vec<GrepMatch>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", root));
    }

    let limit = max_results.unwrap_or(500);
    let mut results = Vec::new();

    let walker = WalkBuilder::new(root_path)
        .hidden(false)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        if results.len() >= limit {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        // Skip binary-like files
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if matches!(
            ext.as_str(),
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "svg"
                | "ico"
                | "woff"
                | "woff2"
                | "ttf"
                | "eot"
                | "zip"
                | "tar"
                | "gz"
                | "pdf"
                | "exe"
                | "dll"
                | "so"
                | "dylib"
        ) {
            continue;
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let rel = path
            .strip_prefix(root_path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        for (line_idx, line_text) in content.lines().enumerate() {
            if results.len() >= limit {
                break;
            }
            let haystack = if case_sensitive {
                line_text.to_string()
            } else {
                line_text.to_lowercase()
            };
            let needle = if case_sensitive {
                pattern.clone()
            } else {
                pattern.to_lowercase()
            };
            if let Some(col) = haystack.find(&needle) {
                results.push(GrepMatch {
                    path: rel.to_string(),
                    line: (line_idx + 1) as u32,
                    column: (col + 1) as u32,
                    text: line_text.to_string(),
                });
            }
        }
    }

    Ok(results)
}
