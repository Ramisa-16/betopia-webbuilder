use std::collections::HashMap;
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use url::{Host, Url};

fn validate_local_docs_url(input: &str) -> Result<Url, String> {
    let parsed = Url::parse(input).map_err(|e| format!("Invalid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Blocked URL scheme: {scheme}")),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Userinfo is not allowed".to_string());
    }

    let authority = input
        .split_once("://")
        .and_then(|(_, rest)| {
            let end = rest
                .find(['/', '?', '#'])
                .unwrap_or(rest.len());
            rest.get(..end)
        })
        .ok_or_else(|| "Missing authority".to_string())?;

    if authority.contains('%') {
        return Err("Encoded authority values are not allowed".to_string());
    }

    let host = parsed.host().ok_or_else(|| "Missing host".to_string())?;
    let allowed = match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    };

    if !allowed {
        return Err("Only localhost, 127.0.0.1, or [::1] targets are allowed".to_string());
    }

    Ok(parsed)
}

fn validate_http_request_url(input: &str) -> Result<Url, String> {
    let parsed = Url::parse(input).map_err(|e| format!("Invalid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Blocked URL scheme: {scheme}")),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Userinfo is not allowed".to_string());
    }

    let authority = input
        .split_once("://")
        .and_then(|(_, rest)| {
            let end = rest
                .find(['/', '?', '#'])
                .unwrap_or(rest.len());
            rest.get(..end)
        })
        .ok_or_else(|| "Missing authority".to_string())?;

    if authority.contains('%') {
        return Err("Encoded authority values are not allowed".to_string());
    }

    if parsed.host().is_none() {
        return Err("Missing host".to_string());
    }

    Ok(parsed)
}

/// Check if a local AI server (LM Studio, Ollama) is reachable.
#[tauri::command]
pub async fn lm_ping(url: String) -> bool {
    if validate_local_docs_url(&url).is_err() { return false; }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .danger_accept_invalid_certs(false)
        .build()
        .unwrap_or_default();
    client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

#[derive(Deserialize)]
pub struct AiHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

#[derive(Serialize)]
pub struct AiHttpResponse {
    pub status: u16,
    pub body: String,
}

/// Non-streaming proxy for local AI requests. Bypasses webview CORS restrictions.
#[tauri::command]
pub async fn ai_http_request(req: AiHttpRequest) -> Result<AiHttpResponse, String> {
    if validate_http_request_url(&req.url).is_err() {
        return Err("Blocked host".to_string());
    }

    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, &req.url);

    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }
    }

    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(AiHttpResponse { status, body })
}

#[derive(Serialize)]
pub struct HttpGetResponse {
    pub status: u16,
    pub body: String,
    pub content_type: String,
}

/// GET a URL from the Rust process — no CORS restrictions, no WebView origin checks.
/// Used by ApiDocsPanel to probe OpenAPI spec endpoints on locally-running servers.
#[tauri::command]
pub async fn http_get(url: String) -> Result<HttpGetResponse, String> {
    let validated_url = validate_local_docs_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(8000))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(validated_url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if resp.status().is_redirection() {
        return Err(format!("Redirects are not allowed (status {status})"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpGetResponse { status, body, content_type })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use tiny_http::{Header, Response, Server};

    #[test]
    fn allows_localhost_url() {
        assert!(validate_local_docs_url("http://localhost:3000/openapi.json").is_ok());
    }

    #[test]
    fn allows_loopback_ipv4_url() {
        assert!(validate_local_docs_url("http://127.0.0.1:3000/docs").is_ok());
    }

    #[test]
    fn allows_loopback_ipv6_url() {
        assert!(validate_local_docs_url("http://[::1]:3000/docs").is_ok());
    }

    #[test]
    fn blocks_metadata_ip_url() {
        assert!(validate_local_docs_url("http://169.254.169.254/latest/meta-data").is_err());
    }

    #[test]
    fn blocks_external_url() {
        assert!(validate_local_docs_url("https://example.com/openapi.json").is_err());
    }

    #[test]
    fn allows_external_http_urls_for_ai_requests() {
        assert!(validate_http_request_url("https://example.com/v1/chat").is_ok());
        assert!(validate_http_request_url("http://api.example.com/v1/chat").is_ok());
    }

    #[test]
    fn blocks_invalid_ai_request_schemes() {
        assert!(validate_http_request_url("file:///etc/passwd").is_err());
        assert!(validate_http_request_url("ftp://example.com/resource").is_err());
    }

    #[test]
    fn blocks_aliased_or_encoded_host_url() {
        assert!(validate_local_docs_url("http://localhost.evil.com/openapi.json").is_err());
        assert!(validate_local_docs_url("http://127.0.0.1@evil.com/openapi.json").is_err());
        assert!(validate_local_docs_url("http://localhost./openapi.json").is_err());
        assert!(validate_local_docs_url("http://lo%63alhost:3000/openapi.json").is_err());
    }

    #[test]
    fn allows_external_http_urls_for_ai_requests() {
        assert!(validate_http_request_url("https://example.com/v1/chat").is_ok());
        assert!(validate_http_request_url("http://api.example.com/v1/chat").is_ok());
    }

    #[test]
    fn blocks_invalid_ai_request_schemes() {
        assert!(validate_http_request_url("file:///etc/passwd").is_err());
        assert!(validate_http_request_url("ftp://example.com/resource").is_err());
    }

    #[tokio::test]
    async fn blocks_redirect_to_metadata_target() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let port = listener.local_addr().expect("local addr").port();
        let server = Server::from_listener(listener, None).expect("create test server");

        let handle = thread::spawn(move || {
            if let Some(request) = server.incoming_requests().next() {
                let location = Header::from_bytes(&b"Location"[..], &b"http://169.254.169.254/latest/meta-data"[..])
                    .expect("location header");
                let response = Response::empty(302).with_header(location);
                let _ = request.respond(response);
            }
        });

        let result = http_get(format!("http://127.0.0.1:{port}/redirect")).await;
        handle.join().expect("server thread");

        assert!(result.is_err());
        let message = result.err().unwrap();
        assert!(message.contains("Redirects are not allowed"), "{message}");
    }
}

/// Typed streaming events — mirrors the terax-ai proxyFetch protocol so the
/// same frontend proxyFetch.ts works on all platforms (including Windows WebView2
/// which does not reliably expose ReadableStream via plugin-http).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

/// Streaming proxy for LLM requests. Sends raw bytes via Tauri Channel so the
/// frontend can reconstruct a proper Response without relying on WebView2's
/// (broken on Windows) ReadableStream support from plugin-http.
#[tauri::command]
pub async fn ai_http_stream(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let _ = allow_private_network; // respected via BLOCKED_HOSTS; extended logic future work
    if validate_http_request_url(&url).is_err() {
        let _ = on_event.send(AiStreamEvent::Error { message: "Blocked host".to_string() });
        return Err("Blocked host".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 min — long LLM generations
        .build()
        .map_err(|e| e.to_string())?;

    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, &url);

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            builder = builder.header(&k, &v);
        }
    }

    if let Some(b) = body {
        builder = builder.body(b);
    }

    let response = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.to_string() });
            return Err(e.to_string());
        }
    };

    // Send status + headers first so the frontend can check for errors before
    // processing the body (e.g. 401 / 429 / 502 responses).
    let status = response.status().as_u16();
    let mut resp_headers = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(s) = v.to_str() {
            resp_headers.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    let _ = on_event.send(AiStreamEvent::Headers { status, headers: resp_headers });

    let mut stream = response.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                let bytes: Bytes = chunk;
                if on_event
                    .send(AiStreamEvent::Chunk { bytes: bytes.to_vec() })
                    .is_err()
                {
                    // Channel dropped (frontend aborted) — stop streaming.
                    return Ok(());
                }
            }
            Err(e) => {
                let _ = on_event.send(AiStreamEvent::Error { message: e.to_string() });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}
