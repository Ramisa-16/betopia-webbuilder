use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    process::Command,
};
use url::Url;
use walkdir::WalkDir;

const MAX_SKILL_FILES: usize = 80;
const MAX_SOURCE_FILES_PER_CANDIDATE: usize = 8;
const MAX_FILE_BYTES: u64 = 64_000;

#[derive(Debug, Clone)]
struct GitHubRepo {
    owner: String,
    repo: String,
    branch: Option<String>,
    base_path: Option<String>,
}

#[derive(Serialize)]
pub struct ImportedSourceFile {
    path: String,
    url: String,
    body: String,
}

#[derive(Serialize)]
pub struct SkillImportCandidate {
    id: String,
    name: String,
    description: String,
    source_path: String,
    source_files: Vec<ImportedSourceFile>,
    fallback: bool,
}

#[derive(Serialize)]
pub struct SkillImportResult {
    cache_id: String,
    repo_path: String,
    candidates: Vec<SkillImportCandidate>,
    warnings: Vec<String>,
}

#[tauri::command]
pub async fn skill_import_git_repo(repo_url: String) -> Result<SkillImportResult, String> {
    tokio::task::spawn_blocking(move || import_repo_blocking(&repo_url))
        .await
        .map_err(|e| e.to_string())?
}

fn import_repo_blocking(repo_url: &str) -> Result<SkillImportResult, String> {
    let repo = parse_github_url(repo_url)?;
    let clone_url = format!("https://github.com/{}/{}.git", repo.owner, repo.repo);
    let cache_id = cache_id(repo_url);
    let cache_root = std::env::temp_dir().join("betopia-skill-imports");
    let repo_path = cache_root.join(&cache_id);

    fs::create_dir_all(&cache_root).map_err(|e| format!("create import cache: {e}"))?;
    if repo_path.exists() {
        fs::remove_dir_all(&repo_path).map_err(|e| format!("clean import cache: {e}"))?;
    }

    let mut cmd = Command::new("git");
    cmd.arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--no-tags")
        .arg("--single-branch");
    if let Some(branch) = &repo.branch {
        cmd.arg("--branch").arg(branch);
    }
    cmd.arg(&clone_url).arg(&repo_path);
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    let output = cmd
        .output()
        .map_err(|e| format!("failed to start git clone: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "git clone failed. If the repo is private, clone it locally and import the folder."
                .to_string()
        } else {
            format!("git clone failed: {stderr}")
        };
        return Err(msg);
    }

    let canonical_repo_path = fs::canonicalize(&repo_path)
        .map_err(|e| format!("canonicalize cloned repo: {e}"))?;
    let scan_root = resolve_scan_root(&canonical_repo_path, repo.base_path.as_deref())?;

    let mut warnings = Vec::new();
    let mut candidates =
        scan_skill_candidates(&repo_url, &canonical_repo_path, &scan_root, &mut warnings)?;
    if candidates.is_empty() {
        if let Some(candidate) =
            build_docs_fallback_candidate(&repo_url, &repo, &canonical_repo_path, &scan_root)?
        {
            warnings.push("No SKILL.md files were found. Generated a fallback candidate from repository docs.".to_string());
            candidates.push(candidate);
        }
    }

    Ok(SkillImportResult {
        cache_id,
        repo_path: repo_path.to_string_lossy().to_string(),
        candidates,
        warnings,
    })
}

fn resolve_scan_root(repo_path: &Path, base_path: Option<&str>) -> Result<PathBuf, String> {
    let joined = base_path
        .map(|path| repo_path.join(path))
        .unwrap_or_else(|| repo_path.to_path_buf());
    if !joined.exists() {
        return Err("Repository path from the URL was not found after cloning.".to_string());
    }
    let canonical_repo_path =
        fs::canonicalize(repo_path).map_err(|e| format!("canonicalize repo root: {e}"))?;
    let canonical_scan_root =
        fs::canonicalize(&joined).map_err(|e| format!("canonicalize import path: {e}"))?;
    if !canonical_scan_root.starts_with(&canonical_repo_path) {
        return Err("Repository path from the URL escapes the cloned repository.".to_string());
    }
    Ok(canonical_scan_root)
}

fn scan_skill_candidates(
    repo_url: &str,
    repo_root: &Path,
    scan_root: &Path,
    warnings: &mut Vec<String>,
) -> Result<Vec<SkillImportCandidate>, String> {
    let mut candidates = Vec::new();
    for entry in WalkDir::new(scan_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_ignored_dir(e.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().to_string_lossy().to_uppercase() != "SKILL.MD" {
            continue;
        }
        if candidates.len() >= MAX_SKILL_FILES {
            warnings.push("Stopped scanning after 80 skill files.".to_string());
            break;
        }
        if let Some(candidate) = build_skill_candidate(repo_url, repo_root, entry.path())? {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then(a.source_path.cmp(&b.source_path)));
    Ok(candidates)
}

fn build_skill_candidate(
    repo_url: &str,
    repo_root: &Path,
    skill_path: &Path,
) -> Result<Option<SkillImportCandidate>, String> {
    let main_body = read_limited(skill_path)?;
    let rel_path = rel_path(repo_root, skill_path);
    let (name, description) = parse_skill_header(&main_body, skill_path);
    let mut source_files = vec![ImportedSourceFile {
        path: rel_path.clone(),
        url: format!("{repo_url}#{rel_path}"),
        body: main_body,
    }];

    if let Some(parent) = skill_path.parent() {
        let mut companions = collect_companion_markdown(repo_root, parent, skill_path)?;
        source_files.append(&mut companions);
    }

    Ok(Some(SkillImportCandidate {
        id: rel_path.clone(),
        name,
        description,
        source_path: rel_path,
        source_files,
        fallback: false,
    }))
}

fn collect_companion_markdown(
    repo_root: &Path,
    skill_dir: &Path,
    skill_path: &Path,
) -> Result<Vec<ImportedSourceFile>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(skill_dir)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_ignored_dir(e.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() || entry.path() == skill_path {
            continue;
        }
        if !is_markdown(entry.path()) {
            continue;
        }
        if files.len() >= MAX_SOURCE_FILES_PER_CANDIDATE - 1 {
            break;
        }
        let rel = rel_path(repo_root, entry.path());
        files.push(ImportedSourceFile {
            path: rel.clone(),
            url: format!("#{rel}"),
            body: read_limited(entry.path())?,
        });
    }
    Ok(files)
}

fn build_docs_fallback_candidate(
    repo_url: &str,
    repo: &GitHubRepo,
    repo_root: &Path,
    scan_root: &Path,
) -> Result<Option<SkillImportCandidate>, String> {
    let doc_names = ["README.md", "AGENTS.md", "CLAUDE.md", "docs/README.md"];
    let mut source_files = Vec::new();
    for name in doc_names {
        let path = scan_root.join(name);
        if path.is_file() {
            source_files.push(ImportedSourceFile {
                path: rel_path(repo_root, &path),
                url: format!("{repo_url}#{}", rel_path(repo_root, &path)),
                body: read_limited(&path)?,
            });
        }
    }
    if source_files.is_empty() {
        return Ok(None);
    }
    let name = title_case(&repo.repo);
    Ok(Some(SkillImportCandidate {
        id: "repo-docs-fallback".to_string(),
        name: name.clone(),
        description: format!(
            "Use when applying workflows, conventions, or documentation from {repo_url}."
        ),
        source_path: rel_path(repo_root, scan_root),
        source_files,
        fallback: true,
    }))
}

fn parse_skill_header(body: &str, skill_path: &Path) -> (String, String) {
    let fallback = skill_path
        .parent()
        .and_then(Path::file_name)
        .map(|s| title_case(&s.to_string_lossy()))
        .unwrap_or_else(|| "Imported Skill".to_string());
    let mut name = fallback;
    let mut description = String::new();
    if let Some(rest) = body.strip_prefix("---") {
        if let Some((frontmatter, _)) = rest.split_once("---") {
            for line in frontmatter.lines() {
                if let Some(value) = line.strip_prefix("name:") {
                    name = value.trim().trim_matches('"').to_string();
                }
                if let Some(value) = line.strip_prefix("description:") {
                    description = value.trim().trim_matches('"').to_string();
                }
            }
        }
    }
    if description.is_empty() {
        description = body
            .lines()
            .find(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty() && !trimmed.starts_with('#') && trimmed != "---"
            })
            .unwrap_or("Imported skill from repository.")
            .trim()
            .chars()
            .take(180)
            .collect();
    }
    (name, description)
}

fn parse_github_url(repo_url: &str) -> Result<GitHubRepo, String> {
    let url = repo_url.trim().trim_end_matches('/');
    let parsed = Url::parse(url).map_err(|_| {
        "Only public GitHub repository URLs are supported for direct import. For private repos, clone locally and import the folder.".to_string()
    })?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or_default();
    if !matches!(scheme, "https" | "http") || !host.eq_ignore_ascii_case("github.com") {
        return Err("Only public GitHub repository URLs are supported for direct import. For private repos, clone locally and import the folder.".to_string());
    }
    let raw_path = url
        .strip_prefix("https://github.com")
        .or_else(|| url.strip_prefix("http://github.com"))
        .ok_or_else(|| {
            "Only public GitHub repository URLs are supported for direct import. For private repos, clone locally and import the folder.".to_string()
        })?;
    let raw_path = raw_path
        .split(['?', '#'])
        .next()
        .unwrap_or(raw_path)
        .trim_end_matches('/');
    let parts: Vec<&str> = raw_path
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("Only public GitHub repository URLs are supported for direct import. For private repos, clone locally and import the folder.".to_string());
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err("Only public GitHub repository URLs are supported for direct import. For private repos, clone locally and import the folder.".to_string());
    }
    let tree_idx = parts.iter().position(|part| *part == "tree");
    let (branch, base_path) = if let Some(idx) = tree_idx {
        let branch = parts
            .get(idx + 1)
            .filter(|segment| !segment.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| "GitHub tree URLs must include a branch name.".to_string())?;
        let base = if parts.len() > idx + 2 {
            Some(sanitize_repo_base_path_segments(&parts[idx + 2..])?)
        } else {
            None
        };
        (Some(branch), base)
    } else {
        (None, None)
    };
    Ok(GitHubRepo {
        owner,
        repo,
        branch,
        base_path,
    })
}

fn sanitize_repo_base_path_segments(segments: &[&str]) -> Result<String, String> {
    let mut clean = PathBuf::new();
    for raw in segments {
        let decoded = percent_decode_path_segment(raw)?;
        if decoded.is_empty() {
            continue;
        }
        if decoded.contains('/') || decoded.contains('\\') {
            return Err("GitHub tree path contains an encoded path separator and cannot be imported safely.".to_string());
        }
        if is_windows_prefixed_path(&decoded) {
            return Err("GitHub tree path cannot use Windows-style absolute paths.".to_string());
        }
        let path = Path::new(&decoded);
        if path.is_absolute() {
            return Err("GitHub tree path must stay relative to the repository root.".to_string());
        }
        let mut components = path.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(component)), None) => clean.push(component),
            _ => {
                return Err(
                    "GitHub tree path contains unsafe path traversal and cannot be imported."
                        .to_string(),
                )
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("GitHub tree path is empty.".to_string());
    }
    Ok(clean.to_string_lossy().replace('\\', "/"))
}

fn percent_decode_path_segment(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            if idx + 2 >= bytes.len() {
                return Err("GitHub tree path contains invalid percent-encoding.".to_string());
            }
            let hi = decode_hex(bytes[idx + 1])?;
            let lo = decode_hex(bytes[idx + 2])?;
            out.push((hi << 4) | lo);
            idx += 3;
        } else {
            out.push(bytes[idx]);
            idx += 1;
        }
    }
    String::from_utf8(out)
        .map_err(|_| "GitHub tree path contains invalid UTF-8 after decoding.".to_string())
}

fn decode_hex(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("GitHub tree path contains invalid percent-encoding.".to_string()),
    }
}

fn is_windows_prefixed_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn cache_id(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn read_limited(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Ok(format!(
            "{}\n\n[File omitted during import because it exceeds {} bytes.]",
            path.file_name().unwrap_or_default().to_string_lossy(),
            MAX_FILE_BYTES
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))
}

fn is_ignored_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git" | "node_modules" | "target" | "dist" | "build" | ".next"
            )
        })
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn title_case(value: &str) -> String {
    let mut out = String::new();
    for word in value
        .trim_end_matches(".git")
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        if !out.is_empty() {
            out.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() {
        "Imported Skill".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_github_url, resolve_scan_root};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("betopia-skill-import-test-{name}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_safe_nested_tree_path() {
        let repo = parse_github_url("https://github.com/acme/skills/tree/main/team/debug")
            .expect("safe nested path should parse");
        assert_eq!(repo.owner, "acme");
        assert_eq!(repo.repo, "skills");
        assert_eq!(repo.branch.as_deref(), Some("main"));
        assert_eq!(repo.base_path.as_deref(), Some("team/debug"));
    }

    #[test]
    fn rejects_parent_dir_traversal_in_tree_path() {
        let err = parse_github_url("https://github.com/acme/skills/tree/main/../secret")
            .expect_err("parent traversal should be rejected");
        assert!(err.contains("unsafe path traversal"));
    }

    #[test]
    fn rejects_encoded_parent_dir_traversal_in_tree_path() {
        let err = parse_github_url("https://github.com/acme/skills/tree/main/%2e%2e/secret")
            .expect_err("encoded parent traversal should be rejected");
        assert!(err.contains("unsafe path traversal"));
    }

    #[test]
    fn rejects_absolute_tree_path() {
        let err = parse_github_url("https://github.com/acme/skills/tree/main/%2Fetc")
            .expect_err("absolute path should be rejected");
        assert!(
            err.contains("encoded path separator") || err.contains("relative to the repository root")
        );
    }

    #[test]
    fn rejects_windows_style_tree_path() {
        let err = parse_github_url("https://github.com/acme/skills/tree/main/C:%5CWindows")
            .expect_err("windows path should be rejected");
        assert!(
            err.contains("Windows-style absolute paths") || err.contains("encoded path separator")
        );
    }

    #[test]
    fn canonical_scan_root_cannot_escape_repo() {
        let repo_root = temp_dir("repo-root");
        let outside_root = temp_dir("outside-root");
        let outside_target = outside_root.join("target");
        fs::create_dir_all(&outside_target).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside_target, repo_root.join("linked")).unwrap();
            let err = resolve_scan_root(&repo_root, Some("linked"))
                .expect_err("symlink escape should be rejected");
            assert!(err.contains("escapes the cloned repository"));
        }

        #[cfg(not(unix))]
        {
            let nested = repo_root.join("nested");
            fs::create_dir_all(&nested).unwrap();
            let resolved = resolve_scan_root(&repo_root, Some("nested"))
                .expect("non-unix fallback should still resolve safely");
            assert!(resolved.starts_with(fs::canonicalize(&repo_root).unwrap()));
        }

        let _ = fs::remove_dir_all(&repo_root);
        let _ = fs::remove_dir_all(&outside_root);
    }
}
