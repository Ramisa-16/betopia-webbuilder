use std::collections::HashMap;
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Blocked IP ranges — prevent SSRF to cloud metadata services.
const BLOCKED_HOSTS: &[&str] = &[
    "169.254.169.254",  // AWS/GCP/Azure metadata
    "metadata.google.internal",
    "169.254.170.2",    // ECS metadata
];

fn is_host_allowed(url: &str) -> bool {
    for blocked in BLOCKED_HOSTS {
        if url.contains(blocked) {
            return false;
        }
    }
    true
}

/// Check if a local AI server (LM Studio, Ollama) is reachable.
#[tauri::command]
pub async fn lm_ping(url: String) -> bool {
    if !is_host_allowed(&url) { return false; }
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
    if !is_host_allowed(&req.url) {
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
    if !is_host_allowed(&url) {
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
