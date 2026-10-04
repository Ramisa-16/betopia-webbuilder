use std::collections::HashMap;

use keyring::Entry;

const SERVICE: &str = "betopia-ai";
const PROJECT_SECRET_KEYS: &[&str] = &[
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "MYSQL_URL",
    "MONGODB_URI",
    "SQLITE_DATABASE_URL",
];

fn normalize_project_path(project_path: &str) -> String {
    project_path
        .replace('\\', "/")
        .trim()
        .trim_end_matches('/')
        .to_lowercase()
}

fn fnv1a_64(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn project_secret_name(project_path: &str, key: &str) -> String {
    let normalized_path = normalize_project_path(project_path);
    let normalized_key = key.trim().to_uppercase();
    format!("project:{}:{}", fnv1a_64(&normalized_path), normalized_key)
}

fn project_entry(project_path: &str, key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &project_secret_name(project_path, key)).map_err(|e| e.to_string())
}

/// Get API key from OS keychain.
#[tauri::command]
pub fn secrets_get(key: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Store a project-scoped secret in the OS keychain.
#[tauri::command]
pub fn project_secret_set(project_path: String, key: String, value: String) -> Result<(), String> {
    let entry = project_entry(&project_path, &key)?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// Read a project-scoped secret from the OS keychain.
#[tauri::command]
pub fn project_secret_get(project_path: String, key: String) -> Result<Option<String>, String> {
    let entry = project_entry(&project_path, &key)?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a project-scoped secret from the OS keychain.
#[tauri::command]
pub fn project_secret_delete(project_path: String, key: String) -> Result<(), String> {
    let entry = project_entry(&project_path, &key)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Return known project-scoped secrets that are present for a workspace.
pub fn project_runtime_env(project_path: &str) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    let normalized = normalize_project_path(project_path);
    let candidate_paths: Vec<String> = std::path::Path::new(&normalized)
        .ancestors()
        .filter_map(|ancestor| {
            let text = ancestor
                .to_string_lossy()
                .replace('\\', "/")
                .trim()
                .trim_end_matches('/')
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .collect();

    for candidate in candidate_paths {
        for key in PROJECT_SECRET_KEYS {
            if env.contains_key(*key) {
                continue;
            }
            let entry = project_entry(&candidate, key)?;
            match entry.get_password() {
                Ok(val) => {
                    env.insert((*key).to_string(), val);
                }
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    Ok(env)
}

/// Store API key in OS keychain.
#[tauri::command]
pub fn secrets_set(key: String, value: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// Remove API key from OS keychain.
#[tauri::command]
pub fn secrets_delete(key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// List all known API key names (not values).
#[tauri::command]
pub fn secrets_list_keys() -> Vec<String> {
    vec![
        "anthropic_api_key".to_string(),
        "openai_api_key".to_string(),
        "google_api_key".to_string(),
        "groq_api_key".to_string(),
        "openrouter_api_key".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::project_secret_name;

    #[test]
    fn project_secret_name_is_canonicalized() {
        let a = project_secret_name("/tmp/Project/", "database_url");
        let b = project_secret_name("\\tmp\\project", "DATABASE_URL");
        assert_eq!(a, b);
        assert!(a.contains("DATABASE_URL"));
    }
}
