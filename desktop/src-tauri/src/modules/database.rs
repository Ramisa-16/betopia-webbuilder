use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;
use url::Url;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTestResult {
    pub ok: bool,
    pub provider: String,
    pub message: String,
    pub url_kind: String,
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_matches(['[', ']']).to_string()
}

fn is_supabase_host(host: &str) -> bool {
    host.ends_with(".supabase.co")
}

fn is_postgres_scheme(scheme: &str) -> bool {
    matches!(scheme, "postgres" | "postgresql")
}

fn default_port(provider: &str) -> Option<u16> {
    match provider {
        "postgres" | "supabase" => Some(5432),
        "mysql" => Some(3306),
        "mongodb" => Some(27017),
        _ => None,
    }
}

fn provider_for_url(parsed: &Url) -> Result<&'static str, String> {
    match parsed.scheme() {
        scheme if is_postgres_scheme(scheme) => {
            let host = parsed
                .host_str()
                .ok_or_else(|| "Database URL is missing a host".to_string())?;
            if is_supabase_host(&normalize_host(host)) {
                Ok("supabase")
            } else {
                Ok("postgres")
            }
        }
        "mysql" => Ok("mysql"),
        "mongodb" | "mongodb+srv" => Ok("mongodb"),
        "sqlite" | "file" => Ok("sqlite"),
        other => Err(format!(
            "Unsupported database URL scheme: {}. Supported: postgres, mysql, mongodb, mongodb+srv, sqlite, file",
            other
        )),
    }
}

fn sqlite_path_from_url(parsed: &Url) -> Option<String> {
    if parsed.scheme() == "file" {
        return parsed
            .to_file_path()
            .ok()
            .map(|p| p.to_string_lossy().to_string());
    }
    if parsed.scheme() == "sqlite" {
        let path = parsed.path().trim();
        if !path.is_empty() {
            return Some(path.to_string());
        }
    }
    None
}

fn test_sqlite_path(raw: &str, parsed: Option<&Url>) -> Result<DatabaseTestResult, String> {
    let path_text = parsed
        .and_then(sqlite_path_from_url)
        .unwrap_or_else(|| raw.to_string());
    let path = Path::new(&path_text);
    if path_text.trim().is_empty() {
        return Err("SQLite path is empty".to_string());
    }
    if path.is_absolute() || path.parent().is_some() {
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
        if let Some(parent) = parent {
            if !parent.exists() {
                return Ok(DatabaseTestResult {
                    ok: false,
                    provider: "sqlite".to_string(),
                    message: format!("SQLite parent folder does not exist: {}", parent.display()),
                    url_kind: "sqlite".to_string(),
                });
            }
        }
        return Ok(DatabaseTestResult {
            ok: true,
            provider: "sqlite".to_string(),
            message:
                "SQLite path is valid. The file can be created or opened by the backend runtime."
                    .to_string(),
            url_kind: "sqlite".to_string(),
        });
    }
    Err("SQLite path must be an absolute path, file:// URL, or sqlite:// URL".to_string())
}

fn test_tcp_url(parsed: &Url, provider: &str) -> Result<DatabaseTestResult, String> {
    if parsed.scheme() == "mongodb+srv" {
        let host = parsed
            .host_str()
            .ok_or_else(|| "MongoDB SRV URL is missing a host".to_string())?;
        return Ok(DatabaseTestResult {
            ok: true,
            provider: "mongodb".to_string(),
            message: format!(
                "MongoDB SRV URL accepted for {}. Driver-level DNS SRV and auth checks run in the backend runtime.",
                normalize_host(host)
            ),
            url_kind: "mongodb-srv".to_string(),
        });
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Database URL is missing a host".to_string())?;
    let port = parsed
        .port()
        .or_else(|| default_port(provider))
        .ok_or_else(|| "Database URL is missing a port".to_string())?;
    let normalized_host = normalize_host(host);

    let addrs = (normalized_host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve database host: {}", e))?;

    let timeout = Duration::from_secs(3);
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return Ok(DatabaseTestResult {
                ok: true,
                provider: provider.to_string(),
                message: format!("Connected to {}:{} (TCP reachable)", normalized_host, port),
                url_kind: provider.to_string(),
            });
        }
    }

    Ok(DatabaseTestResult {
        ok: false,
        provider: provider.to_string(),
        message: format!("Could not reach {}:{}", normalized_host, port),
        url_kind: provider.to_string(),
    })
}

#[tauri::command]
pub fn project_database_test(database_url: String) -> Result<DatabaseTestResult, String> {
    let raw = database_url.trim();
    if raw.is_empty() {
        return Err("Database URL is empty".to_string());
    }

    let parsed = Url::parse(raw);
    if parsed.is_err() && raw.starts_with('/') {
        return test_sqlite_path(raw, None);
    }

    let parsed = parsed.map_err(|e| format!("Invalid database URL: {}", e))?;
    let provider = provider_for_url(&parsed)?;
    if provider == "sqlite" {
        return test_sqlite_path(raw, Some(&parsed));
    }
    test_tcp_url(&parsed, provider)
}

#[cfg(test)]
mod tests {
    use super::{
        default_port, is_postgres_scheme, normalize_host, provider_for_url, sqlite_path_from_url,
    };
    use url::Url;

    #[test]
    fn recognizes_postgres_schemes() {
        assert!(is_postgres_scheme("postgres"));
        assert!(is_postgres_scheme("postgresql"));
        assert!(!is_postgres_scheme("http"));
    }

    #[test]
    fn normalizes_ipv6_brackets() {
        assert_eq!(normalize_host("[::1]"), "::1");
    }

    #[test]
    fn recognizes_supported_providers() {
        assert_eq!(
            provider_for_url(&Url::parse("postgresql://u:p@example.com/db").unwrap()).unwrap(),
            "postgres"
        );
        assert_eq!(
            provider_for_url(&Url::parse("mysql://u:p@example.com/db").unwrap()).unwrap(),
            "mysql"
        );
        assert_eq!(
            provider_for_url(&Url::parse("mongodb://example.com/db").unwrap()).unwrap(),
            "mongodb"
        );
        assert_eq!(
            provider_for_url(&Url::parse("mongodb+srv://cluster.example.com/db").unwrap()).unwrap(),
            "mongodb"
        );
        assert_eq!(
            provider_for_url(&Url::parse("sqlite:///tmp/app.db").unwrap()).unwrap(),
            "sqlite"
        );
    }

    #[test]
    fn recognizes_default_ports() {
        assert_eq!(default_port("postgres"), Some(5432));
        assert_eq!(default_port("supabase"), Some(5432));
        assert_eq!(default_port("mysql"), Some(3306));
        assert_eq!(default_port("mongodb"), Some(27017));
    }

    #[test]
    fn extracts_sqlite_file_paths() {
        assert_eq!(
            sqlite_path_from_url(&Url::parse("sqlite:///tmp/app.db").unwrap()).as_deref(),
            Some("/tmp/app.db")
        );
        assert_eq!(
            sqlite_path_from_url(&Url::parse("file:///tmp/app.db").unwrap()).as_deref(),
            Some("/tmp/app.db")
        );
    }
}
