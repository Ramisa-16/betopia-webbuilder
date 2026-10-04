use keyring::Entry;

const SERVICE: &str = "betopia-ai";

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
