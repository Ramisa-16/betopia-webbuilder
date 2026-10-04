use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".betopia",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
];

#[tauri::command]
pub fn fs_read_dir(root: String, respect_gitignore: bool) -> Result<Vec<FileNode>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", root));
    }
    Ok(read_dir_recursive(root_path, &root, respect_gitignore))
}

fn read_dir_recursive(dir: &Path, root: &str, respect_gitignore: bool) -> Vec<FileNode> {
    let mut builder = WalkBuilder::new(dir);
    builder
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(respect_gitignore)
        .git_global(false)
        .git_exclude(false);

    let mut entries: Vec<FileNode> = builder
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.path() != dir)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();

            // Skip hidden/system dirs
            if path.is_dir() && SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }

            let rel_path = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches('/')
                .to_string();

            let size = path.metadata().map(|m| m.len()).unwrap_or(0);

            if path.is_dir() {
                let children = read_dir_recursive(path, root, respect_gitignore);
                Some(FileNode {
                    name,
                    path: rel_path,
                    is_dir: true,
                    size: 0,
                    children: Some(children),
                })
            } else {
                Some(FileNode {
                    name,
                    path: rel_path,
                    is_dir: false,
                    size,
                    children: None,
                })
            }
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}
