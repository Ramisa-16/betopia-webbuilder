use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, BTreeSet},
    fs,
    hash::{Hash, Hasher},
    path::Path,
    process::Command,
};
use walkdir::WalkDir;

const MAX_SOURCE_FILES: usize = 12;
const MAX_FILE_BYTES: u64 = 64_000;
const MAX_PROMPT_SEED_CHARS: usize = 12_000;
const READ_ONLY_TOOLS: [&str; 7] = [
    "view_file",
    "list_dir",
    "grep_search",
    "list_files",
    "project_structure",
    "read_files",
    "read_with_deps",
];
const WRITE_TOOLS: [&str; 12] = [
    "view_file",
    "list_dir",
    "grep_search",
    "list_files",
    "project_structure",
    "read_files",
    "read_with_deps",
    "write_file",
    "edit",
    "bash",
    "delete_file",
    "rename_file",
];

#[derive(Debug, Clone)]
struct GitHubRepo {
    owner: String,
    repo: String,
    branch: Option<String>,
    base_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedRepoSourceFile {
    path: String,
    body: String,
    category: String,
    suspicious: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentImportAnalysis {
    readme_paths: Vec<String>,
    skill_paths: Vec<String>,
    manifest_paths: Vec<String>,
    mcp_config_paths: Vec<String>,
    script_paths: Vec<String>,
    example_paths: Vec<String>,
    warnings: Vec<String>,
    risk_flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentImportCandidate {
    suggested_id: String,
    suggested_name: String,
    suggested_description: String,
    suggested_model: Option<String>,
    suggested_writable: bool,
    suggested_tools: Vec<String>,
    source_path: String,
    source_files: Vec<ImportedRepoSourceFile>,
    linked_skills: Vec<String>,
    import_notes: Vec<String>,
    manifests_detected: Vec<String>,
    prompt_seed: String,
    risk_flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentImportResult {
    cache_id: String,
    repo_path: String,
    analysis: SubagentImportAnalysis,
    warnings: Vec<String>,
    candidate: SubagentImportCandidate,
}

#[derive(Default)]
struct ScanState {
    readme_paths: Vec<String>,
    skill_paths: Vec<String>,
    manifest_paths: Vec<String>,
    mcp_config_paths: Vec<String>,
    script_paths: Vec<String>,
    example_paths: Vec<String>,
    warnings: BTreeSet<String>,
    risk_flags: BTreeSet<String>,
    source_files: Vec<ImportedRepoSourceFile>,
    extracted_models: Vec<String>,
    explicit_write_signal: bool,
}

#[tauri::command]
pub async fn subagent_import_git_repo(repo_url: String) -> Result<SubagentImportResult, String> {
    tokio::task::spawn_blocking(move || import_repo_blocking(&repo_url))
        .await
        .map_err(|e| e.to_string())?
}

fn import_repo_blocking(repo_url: &str) -> Result<SubagentImportResult, String> {
    let repo = parse_github_url(repo_url).ok_or_else(|| {
        "Only public GitHub repository URLs are supported for subagent import.".to_string()
    })?;
    let clone_url = format!("https://github.com/{}/{}.git", repo.owner, repo.repo);
    let cache_id = cache_id(repo_url);
    let cache_root = std::env::temp_dir().join("betopia-subagent-imports");
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
        return Err(if stderr.is_empty() {
            "git clone failed. Ensure the repo is public and accessible.".to_string()
        } else {
            format!("git clone failed: {stderr}")
        });
    }

    let scan_root = repo
        .base_path
        .as_ref()
        .map(|p| repo_path.join(p))
        .unwrap_or_else(|| repo_path.clone());
    if !scan_root.exists() {
        return Err("Repository path from the GitHub URL was not found after cloning.".to_string());
    }

    let mut state = ScanState::default();
    scan_repo(&repo_path, &scan_root, &mut state)?;
    let analysis = build_analysis(&state);
    let candidate = build_candidate(repo_url, &repo, &repo_path, &scan_root, &state)?;
    let warnings = analysis.warnings.clone();

    Ok(SubagentImportResult {
        cache_id,
        repo_path: repo_path.to_string_lossy().to_string(),
        analysis,
        warnings,
        candidate,
    })
}

fn scan_repo(repo_root: &Path, scan_root: &Path, state: &mut ScanState) -> Result<(), String> {
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

        let path = entry.path();
        let rel = rel_path(repo_root, path);
        let rel_lower = rel.to_lowercase();
        let file_name_lower = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let category = classify_file(&rel_lower, &file_name_lower);

        if category == "other" && !looks_like_mcp_config_path(&rel_lower) {
            continue;
        }

        let body = read_limited(path)?;
        let suspicious = scan_text_risks(&body, &rel, state);

        if looks_like_readme(&file_name_lower, &rel_lower) {
            state.readme_paths.push(rel.clone());
        }
        if file_name_lower == "skill.md" {
            state.skill_paths.push(rel.clone());
        }
        if is_manifest_path(&rel_lower) {
            state.manifest_paths.push(rel.clone());
        }
        if looks_like_mcp_config_path(&rel_lower) || looks_like_mcp_config_content(&body) {
            state.mcp_config_paths.push(rel.clone());
        }
        if looks_like_script_path(&rel_lower, &file_name_lower) || looks_like_script_content(&body)
        {
            state.script_paths.push(rel.clone());
        }
        if rel_lower.contains("/docs/")
            || rel_lower.contains("/examples/")
            || rel_lower.starts_with("docs/")
            || rel_lower.starts_with("examples/")
        {
            state.example_paths.push(rel.clone());
        }

        if let Some(model) = extract_model_hint(&body) {
            state.extracted_models.push(model);
        }
        if infer_explicit_write_signal(&body, &rel_lower) {
            state.explicit_write_signal = true;
        }

        maybe_add_source_file(
            &mut state.source_files,
            ImportedRepoSourceFile {
                path: rel,
                body,
                category: category.to_string(),
                suspicious,
            },
        );
    }

    if state.source_files.is_empty() {
        return Err("No readable repo guidance files were found during import.".to_string());
    }

    if !state.script_paths.is_empty() {
        state.warnings.insert(
            "Repository contains executable scripts. Betopia imported them as text only and did not run anything."
                .to_string(),
        );
    }
    if !state.mcp_config_paths.is_empty() {
        state.warnings.insert(
            "Repository includes MCP-like configuration. Dangerous capabilities stay disabled until you explicitly review and enable them."
                .to_string(),
        );
    }
    Ok(())
}

fn build_analysis(state: &ScanState) -> SubagentImportAnalysis {
    SubagentImportAnalysis {
        readme_paths: dedupe_sorted(&state.readme_paths),
        skill_paths: dedupe_sorted(&state.skill_paths),
        manifest_paths: dedupe_sorted(&state.manifest_paths),
        mcp_config_paths: dedupe_sorted(&state.mcp_config_paths),
        script_paths: dedupe_sorted(&state.script_paths),
        example_paths: dedupe_sorted(&state.example_paths),
        warnings: state.warnings.iter().cloned().collect(),
        risk_flags: state.risk_flags.iter().cloned().collect(),
    }
}

fn build_candidate(
    repo_url: &str,
    repo: &GitHubRepo,
    repo_root: &Path,
    scan_root: &Path,
    state: &ScanState,
) -> Result<SubagentImportCandidate, String> {
    let preferred_manifest = state
        .manifest_paths
        .first()
        .cloned()
        .or_else(|| state.readme_paths.first().cloned())
        .unwrap_or_else(|| rel_path(repo_root, scan_root));
    let suggested_name = infer_name(repo, state);
    let suggested_id = slugify(&suggested_name);
    let suggested_description = infer_description(repo_url, state);
    let suggested_model = state.extracted_models.first().cloned();
    let suggested_writable = state.explicit_write_signal;
    let suggested_tools = if suggested_writable {
        WRITE_TOOLS.iter().map(|tool| (*tool).to_string()).collect()
    } else {
        READ_ONLY_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect()
    };
    let linked_skills = state
        .skill_paths
        .iter()
        .filter_map(|path| {
            Path::new(path)
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .map(title_case)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let manifests_detected = dedupe_sorted(&state.manifest_paths);
    let mut import_notes = Vec::new();
    if !manifests_detected.is_empty() {
        import_notes.push(format!(
            "Detected agent manifests: {}",
            manifests_detected.join(", ")
        ));
    }
    if !state.skill_paths.is_empty() {
        import_notes.push(format!(
            "Detected reusable skills: {}",
            dedupe_sorted(&state.skill_paths).join(", ")
        ));
    }
    if !state.mcp_config_paths.is_empty() {
        import_notes.push(
            "Detected MCP/server configuration. Review tool access before enabling write actions."
                .to_string(),
        );
    }
    if !state.script_paths.is_empty() {
        import_notes.push("Executable scripts were analyzed as text only; no repository code was run during import.".to_string());
    }
    if state.explicit_write_signal {
        import_notes.push("Repo guidance appears to expect write-capable operation. Betopia will still keep imported agents conservative unless you choose a higher trust level.".to_string());
    } else {
        import_notes.push("No explicit write-capable signal was detected, so the draft defaults to read-only behavior.".to_string());
    }

    let prompt_seed = build_prompt_seed(repo_url, &state.source_files);
    if prompt_seed.is_empty() {
        return Err("Could not extract enough repo guidance to draft a subagent.".to_string());
    }

    Ok(SubagentImportCandidate {
        suggested_id,
        suggested_name,
        suggested_description,
        suggested_model,
        suggested_writable,
        suggested_tools,
        source_path: preferred_manifest,
        source_files: state.source_files.clone(),
        linked_skills,
        import_notes,
        manifests_detected,
        prompt_seed,
        risk_flags: state.risk_flags.iter().cloned().collect(),
    })
}

fn classify_file(rel_lower: &str, file_name_lower: &str) -> &'static str {
    if is_manifest_path(rel_lower) {
        "manifest"
    } else if file_name_lower == "skill.md" {
        "skill"
    } else if looks_like_readme(file_name_lower, rel_lower) {
        "doc"
    } else if looks_like_script_path(rel_lower, file_name_lower) {
        "script"
    } else if looks_like_mcp_config_path(rel_lower) {
        "config"
    } else if rel_lower.contains("/docs/")
        || rel_lower.contains("/examples/")
        || rel_lower.starts_with("docs/")
        || rel_lower.starts_with("examples/")
    {
        "example"
    } else {
        "other"
    }
}

fn looks_like_readme(file_name_lower: &str, rel_lower: &str) -> bool {
    file_name_lower == "readme.md"
        || file_name_lower == "agents.md"
        || file_name_lower == "claude.md"
        || rel_lower.ends_with("/readme.md")
}

fn is_manifest_path(rel_lower: &str) -> bool {
    (rel_lower.starts_with(".codex/agents/") && rel_lower.ends_with(".toml"))
        || (rel_lower.starts_with(".claude/agents/") && rel_lower.ends_with(".md"))
}

fn looks_like_mcp_config_path(rel_lower: &str) -> bool {
    rel_lower.contains("mcp")
        && (rel_lower.ends_with(".json")
            || rel_lower.ends_with(".yaml")
            || rel_lower.ends_with(".yml")
            || rel_lower.ends_with(".toml")
            || rel_lower.ends_with(".md"))
}

fn looks_like_mcp_config_content(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("mcpservers")
        || lower.contains("\"mcpservers\"")
        || lower.contains("[mcp")
        || lower.contains("model context protocol")
}

fn looks_like_script_path(rel_lower: &str, file_name_lower: &str) -> bool {
    rel_lower.ends_with(".sh")
        || rel_lower.ends_with(".ps1")
        || rel_lower.ends_with(".bat")
        || rel_lower.ends_with(".cmd")
        || file_name_lower == "package.json"
        || rel_lower.contains("/scripts/")
}

fn looks_like_script_content(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("\"scripts\"")
        || lower.contains("#!/bin/")
        || lower.contains("npm run")
        || lower.contains("pnpm ")
        || lower.contains("cargo ")
}

fn infer_explicit_write_signal(body: &str, rel_lower: &str) -> bool {
    let lower = body.to_lowercase();
    rel_lower.starts_with(".codex/agents/")
        && (lower.contains("write_file")
            || lower.contains("rename_file")
            || lower.contains("delete_file")
            || lower.contains("tool") && (lower.contains("bash") || lower.contains("edit")))
        || lower.contains("write-capable")
        || lower.contains("can write files")
}

fn extract_model_hint(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if lower.starts_with("model =") || lower.starts_with("model:") {
            let value = trimmed
                .split_once('=')
                .map(|(_, rhs)| rhs)
                .or_else(|| trimmed.split_once(':').map(|(_, rhs)| rhs))
                .map(|rhs| rhs.trim().trim_matches('"').trim_matches('\''))
                .unwrap_or_default();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn infer_name(repo: &GitHubRepo, state: &ScanState) -> String {
    for source in &state.source_files {
        if source.category == "manifest" || source.category == "skill" {
            if let Some(name) = parse_named_field(&source.body, &["name =", "name:", "title:"]) {
                return title_case(&name);
            }
        }
    }
    title_case(&repo.repo)
}

fn infer_description(repo_url: &str, state: &ScanState) -> String {
    for source in &state.source_files {
        if source.category == "manifest" || source.category == "doc" || source.category == "skill" {
            if let Some(description) =
                parse_named_field(&source.body, &["description =", "description:"])
            {
                return trim_sentence(&description, 180);
            }
            for line in source.body.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---" {
                    continue;
                }
                return trim_sentence(trimmed, 180);
            }
        }
    }
    format!("Imported specialist guidance from {repo_url}.")
}

fn parse_named_field(body: &str, prefixes: &[&str]) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        for prefix in prefixes {
            if lower.starts_with(prefix) {
                let value = trimmed[prefix.len()..]
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn build_prompt_seed(repo_url: &str, source_files: &[ImportedRepoSourceFile]) -> String {
    let mut sections = vec![
        format!("Repository: {repo_url}"),
        "Import mode: static analysis only; no repository code was executed.".to_string(),
    ];

    for file in source_files.iter().take(6) {
        sections.push(format!(
            "### {} ({})\n{}",
            file.path,
            file.category,
            file.body.trim()
        ));
    }

    let joined = sections.join("\n\n");
    if joined.len() <= MAX_PROMPT_SEED_CHARS {
        joined
    } else {
        joined[..MAX_PROMPT_SEED_CHARS].trim().to_string()
    }
}

fn scan_text_risks(body: &str, rel: &str, state: &mut ScanState) -> bool {
    let lower = body.to_lowercase();
    let mut suspicious = false;

    if lower.contains("ignore previous instructions")
        || lower.contains("ignore system instructions")
        || lower.contains("ignore developer instructions")
    {
        state.risk_flags.insert(format!(
            "{rel}: prompt-injection style instructions detected"
        ));
        suspicious = true;
    }
    if lower.contains("rm -rf /")
        || lower.contains("rm -rf *")
        || lower.contains("del /s /q c:\\")
        || lower.contains("format c:")
    {
        state
            .risk_flags
            .insert(format!("{rel}: destructive command pattern detected"));
        suspicious = true;
    }
    if lower.contains("curl ")
        && (lower.contains("| sh") || lower.contains("| bash") || lower.contains("| python"))
    {
        state
            .warnings
            .insert(format!("{rel}: pipe-to-shell install command detected"));
        suspicious = true;
    }
    if lower.contains("api_key")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("password")
    {
        if lower.contains("print")
            || lower.contains("echo")
            || lower.contains("send")
            || lower.contains("upload")
        {
            state.risk_flags.insert(format!(
                "{rel}: potential secret exposure guidance detected"
            ));
            suspicious = true;
        }
    }
    suspicious
}

fn maybe_add_source_file(target: &mut Vec<ImportedRepoSourceFile>, file: ImportedRepoSourceFile) {
    if target.iter().any(|existing| existing.path == file.path) {
        return;
    }
    if target.len() >= MAX_SOURCE_FILES {
        return;
    }
    target.push(file);
    target.sort_by(|a, b| {
        file_priority(&a.category)
            .cmp(&file_priority(&b.category))
            .then(a.path.cmp(&b.path))
    });
    target.truncate(MAX_SOURCE_FILES);
}

fn file_priority(category: &str) -> u8 {
    match category {
        "manifest" => 0,
        "skill" => 1,
        "doc" => 2,
        "config" => 3,
        "example" => 4,
        "script" => 5,
        _ => 9,
    }
}

fn parse_github_url(repo_url: &str) -> Option<GitHubRepo> {
    let url = repo_url.trim().trim_end_matches('/');
    let without_scheme = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))?;
    let parts: Vec<&str> = without_scheme
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let tree_idx = parts.iter().position(|part| *part == "tree");
    let (branch, base_path) = if let Some(idx) = tree_idx {
        let branch = parts.get(idx + 1).map(|s| s.to_string());
        let base = if parts.len() > idx + 2 {
            Some(parts[idx + 2..].join("/"))
        } else {
            None
        };
        (branch, base)
    } else {
        (None, None)
    };
    Some(GitHubRepo {
        owner,
        repo,
        branch,
        base_path,
    })
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
            "[File excerpt omitted because {} exceeds {} bytes.]",
            path.display(),
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
                ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".venv" | "venv"
            )
        })
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn dedupe_sorted(values: &[String]) -> Vec<String> {
    values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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
        "Imported Subagent".to_string()
    } else {
        out
    }
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            prev_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if prev_dash {
            None
        } else {
            prev_dash = true;
            Some('-')
        };
        if let Some(c) = normalized {
            out.push(c);
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "imported-subagent".to_string()
    } else {
        trimmed
    }
}

fn trim_sentence(value: &str, max_chars: usize) -> String {
    if value.len() <= max_chars {
        return value.to_string();
    }
    format!("{}…", value[..max_chars].trim())
}
