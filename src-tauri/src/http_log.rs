//! Outbound HTTP with one structured log line per call.
//!
//! Only method, host, path, status and duration are recorded. Query strings,
//! headers and bodies are never logged: they carry API keys, transcripts and
//! note content.

use std::time::Instant;

use reqwest::{RequestBuilder, Response};

pub async fn send(operation: &'static str, request: RequestBuilder) -> reqwest::Result<Response> {
    let (client, request) = request.build_split();
    let request = request?;
    let method = request.method().clone();
    let host = request.url().host_str().unwrap_or("-").to_owned();
    let path = request.url().path().to_owned();
    let started = Instant::now();

    let result = client.execute(request).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(response) if response.status().is_success() => tracing::info!(
            target: "http",
            operation, %method, host, path, status = response.status().as_u16(), duration_ms,
            "http.response"
        ),
        Ok(response) => tracing::warn!(
            target: "http",
            operation, %method, host, path, status = response.status().as_u16(), duration_ms,
            "http.response"
        ),
        Err(error) => tracing::warn!(
            target: "http",
            operation, %method, host, path, duration_ms,
            kind = error_kind(error),
            // reqwest's Display embeds the full URL; the source chain does not.
            error = %std::error::Error::source(error).map(ToString::to_string).unwrap_or_default(),
            "http.request_failed"
        ),
    }
    result
}

fn error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        "request"
    }
}
