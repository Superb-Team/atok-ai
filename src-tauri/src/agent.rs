// AI Backend — all API calls go through here (keys never exposed to frontend). Providers: DeepInfra (OpenAI-compatible chat/streaming/Whisper) and Agent API (custom transcription, RAG).

use reqwest::Client;
use std::future::Future;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

// ==================== Config ====================

fn get_deepinfra_config() -> Result<(String, String, String), String> {
    let api_key = std::env::var("DEEPINFRA_API_KEY")
        .map_err(|_| "DEEPINFRA_API_KEY not configured in .env".to_string())?;
    let model = std::env::var("DEEPINFRA_MODEL")
        .unwrap_or_else(|_| "deepseek-ai/DeepSeek-V4-Flash".to_string());
    let base_url = std::env::var("DEEPINFRA_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepinfra.com/v1/openai".to_string());

    if api_key.is_empty() {
        return Err("DEEPINFRA_API_KEY is empty".to_string());
    }

    Ok((base_url, api_key, model))
}

fn parse_model_chain(primary: &str, fallbacks: Option<&str>) -> Vec<String> {
    let mut models = Vec::new();
    for model in std::iter::once(primary).chain(fallbacks.unwrap_or_default().split(',')) {
        let model = model.trim();
        if !model.is_empty() && !models.iter().any(|existing| existing == model) {
            models.push(model.to_string());
        }
    }
    models
}

fn configured_chat_models(primary: &str) -> Vec<String> {
    let fallbacks = std::env::var("DEEPINFRA_FALLBACK_MODELS")
        .unwrap_or_else(|_| "XiaomiMiMo/MiMo-V2.5".to_string());
    parse_model_chain(primary, Some(&fallbacks))
}

fn apply_model_chat_settings(body: &mut serde_json::Value, model: &str) {
    if model.starts_with("Qwen/Qwen3.") {
        body["top_p"] = serde_json::json!(0.8);
        body["repetition_penalty"] = serde_json::json!(1.0);
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }
    if model == "deepseek-ai/DeepSeek-V4-Flash" {
        body["top_p"] = serde_json::json!(0.8);
        body["repetition_penalty"] = serde_json::json!(1.0);
        body["reasoning"] = serde_json::json!({ "enabled": false });
    }
    if model == "XiaomiMiMo/MiMo-V2.5" {
        body["reasoning"] = serde_json::json!({ "enabled": false });
    }
}

fn get_agent_config() -> Result<(String, String), String> {
    let base_url =
        std::env::var("AGENT_BASE_URL").map_err(|_| "AGENT_BASE_URL not configured".to_string())?;
    let api_key =
        std::env::var("AGENT_API_KEY").map_err(|_| "AGENT_API_KEY not configured".to_string())?;

    if base_url.is_empty() || api_key.is_empty() {
        return Err("Agent API not configured".to_string());
    }

    Ok((base_url, api_key))
}

fn build_provider_client(request_timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15).min(request_timeout))
        .timeout(request_timeout)
        .build()
        .map_err(|error| format!("Build provider HTTP client: {error}"))
}

// ==================== DeepInfra Chat ====================

#[derive(serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug)]
struct ParsedChatCompletion {
    request_id: String,
    content: String,
    finish_reason: String,
    model: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    estimated_cost: f64,
}

impl ParsedChatCompletion {
    fn is_truncated(&self) -> bool {
        self.finish_reason == "length"
    }
}

#[derive(Debug, serde::Serialize)]
pub struct ChatCompletionResult {
    pub request_id: String,
    pub content: String,
    pub finish_reason: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub estimated_cost: f64,
    pub continuation_count: u32,
    pub is_truncated: bool,
}

const PROVIDER_MAX_OUTPUT_TOKENS: u64 = 16_384;
const FALLBACK_CONTEXT_TOKENS: u64 = 32_768;
const FALLBACK_OUTPUT_TOKENS: u64 = 8_192;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ModelLimits {
    pub model: String,
    pub context_tokens: u64,
    pub max_output_tokens: u64,
    pub source: String,
}

fn parse_model_limits(data: &serde_json::Value, model: &str) -> Result<ModelLimits, String> {
    let entry = data["data"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["id"].as_str() == Some(model))
        })
        .ok_or_else(|| {
            format!(
                "Configured model '{}' is absent from provider metadata",
                model
            )
        })?;
    let context_tokens = entry["metadata"]["context_length"]
        .as_u64()
        .ok_or_else(|| format!("Provider metadata has no context length for '{}'", model))?;
    let advertised_output = entry["metadata"]["max_tokens"]
        .as_u64()
        .unwrap_or(PROVIDER_MAX_OUTPUT_TOKENS);

    Ok(ModelLimits {
        model: model.to_string(),
        context_tokens,
        max_output_tokens: advertised_output.min(PROVIDER_MAX_OUTPUT_TOKENS),
        source: "provider".to_string(),
    })
}

fn fallback_model_limits(model: String) -> ModelLimits {
    let context_tokens = std::env::var("DEEPINFRA_CONTEXT_LIMIT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(FALLBACK_CONTEXT_TOKENS);
    let max_output_tokens = std::env::var("DEEPINFRA_MAX_OUTPUT_TOKENS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(FALLBACK_OUTPUT_TOKENS)
        .min(PROVIDER_MAX_OUTPUT_TOKENS);
    ModelLimits {
        model,
        context_tokens,
        max_output_tokens,
        source: "conservative-fallback".to_string(),
    }
}

#[tauri::command]
pub async fn get_ai_model_limits() -> Result<ModelLimits, String> {
    let (base_url, api_key, model) = get_deepinfra_config()?;
    let models_url = std::env::var("DEEPINFRA_MODELS_URL").unwrap_or_else(|_| {
        base_url
            .trim_end_matches('/')
            .strip_suffix("/v1/openai")
            .map(|root| format!("{}/v1/models", root))
            .unwrap_or_else(|| "https://api.deepinfra.com/v1/models".to_string())
    });

    let fetched = build_provider_client(Duration::from_secs(15))?
        .get(models_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await;
    let limits = match fetched {
        Ok(response) if response.status().is_success() => match response.json().await {
            Ok(data) => parse_model_limits(&data, &model).unwrap_or_else(|error| {
                eprintln!("[model-limits] {}. Using conservative fallback.", error);
                fallback_model_limits(model.clone())
            }),
            Err(error) => {
                eprintln!("[model-limits] Invalid metadata response: {}", error);
                fallback_model_limits(model.clone())
            }
        },
        Ok(response) => {
            eprintln!(
                "[model-limits] Metadata request returned {}",
                response.status()
            );
            fallback_model_limits(model.clone())
        }
        Err(error) => {
            eprintln!("[model-limits] Metadata request failed: {}", error);
            fallback_model_limits(model.clone())
        }
    };
    Ok(limits)
}

fn parse_chat_completion(data: &serde_json::Value) -> Result<ParsedChatCompletion, String> {
    let choice = data["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .ok_or_else(|| "Chat response contains no choices".to_string())?;
    let content = choice["message"]["content"]
        .as_str()
        .ok_or_else(|| "Chat response choice contains no text content".to_string())?;

    Ok(ParsedChatCompletion {
        request_id: data["id"].as_str().unwrap_or("unknown").to_string(),
        content: content.to_string(),
        finish_reason: choice["finish_reason"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        model: data["model"].as_str().unwrap_or("unknown").to_string(),
        prompt_tokens: data["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        completion_tokens: data["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        estimated_cost: data["usage"]["estimated_cost"].as_f64().unwrap_or(0.0),
    })
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

async fn post_chat_with_retry(
    client: &Client,
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    const MAX_ATTEMPTS: u32 = 4;
    let mut delay_secs = 1u64;
    let mut last_error = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        match client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(body)
            .send()
            .await
        {
            Ok(response) if !is_retryable_status(response.status()) => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok());
                last_error = format!("HTTP {}", status);
                if attempt == MAX_ATTEMPTS {
                    return Ok(response);
                }
                let wait = retry_after.unwrap_or(delay_secs).min(30);
                eprintln!(
                    "[ai_chat] Retryable {} (attempt {}/{}), retrying in {}s",
                    status, attempt, MAX_ATTEMPTS, wait
                );
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            }
            Err(error) => {
                last_error = error.to_string();
                if attempt == MAX_ATTEMPTS {
                    break;
                }
                eprintln!(
                    "[ai_chat] Transport failure (attempt {}/{}), retrying in {}s",
                    attempt, MAX_ATTEMPTS, delay_secs
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
        delay_secs = (delay_secs * 2).min(30);
    }
    Err(format!("Chat request failed after retries: {}", last_error))
}

// A long note can hit max_tokens mid-sentence and would previously be saved
// truncated with no detection. When finish_reason == "length", feed the partial
// back as an assistant turn and ask the model to continue, up to this many times.
const CHAT_MAX_CONTINUATIONS: u32 = 2;
const DEFAULT_CHAT_DEADLINE_SECS: u64 = 120;

fn chat_request_deadline() -> Duration {
    let seconds = std::env::var("DEEPINFRA_CHAT_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CHAT_DEADLINE_SECS)
        .clamp(10, 900);
    Duration::from_secs(seconds)
}

async fn with_chat_deadline<F, T>(future: F, deadline: Duration) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(deadline, future)
        .await
        .map_err(|_| format!("Chat request timed out after {}ms", deadline.as_millis()))?
}

#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    Ok(ai_chat_detailed(messages, temperature, max_tokens)
        .await?
        .content)
}

#[tauri::command]
pub async fn ai_chat_detailed(
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<ChatCompletionResult, String> {
    let (base_url, api_key, primary_model) = get_deepinfra_config()?;
    let deadline = chat_request_deadline();
    let client = build_provider_client(deadline)?;
    let url = format!("{}/chat/completions", base_url);

    let mut failures = Vec::new();
    for model in configured_chat_models(&primary_model) {
        match ai_chat_detailed_for_model(
            &client,
            &url,
            &api_key,
            &model,
            &messages,
            temperature,
            max_tokens,
            deadline,
        )
        .await
        {
            Ok(result) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "event": "ai_chat_completed",
                        "model": result.model,
                        "promptTokens": result.prompt_tokens,
                        "completionTokens": result.completion_tokens,
                        "estimatedCostUsd": result.estimated_cost,
                        "continuations": result.continuation_count,
                    })
                );
                return Ok(result);
            }
            Err(error) => {
                eprintln!(
                    "{{\"event\":\"ai_model_failed\",\"model\":{:?},\"reason\":{:?}}}",
                    model, error
                );
                failures.push(format!("{}: {}", model, error));
            }
        }
    }
    Err(format!(
        "All configured chat models failed: {}",
        failures.join(" | ")
    ))
}

#[allow(clippy::too_many_arguments)]
async fn ai_chat_detailed_for_model(
    client: &Client,
    url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    deadline: Duration,
) -> Result<ChatCompletionResult, String> {
    let mut messages_json: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    let mut combined = String::new();
    let mut total_prompt_tokens = 0u64;
    let mut total_completion_tokens = 0u64;
    let mut total_estimated_cost = 0.0f64;
    let mut final_finish_reason = "unknown".to_string();
    let mut response_model = model.to_string();
    let mut request_ids = Vec::new();
    let mut continuation_count = 0u32;
    for round in 0..=CHAT_MAX_CONTINUATIONS {
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages_json,
            "temperature": temperature.unwrap_or(0.7),
            "max_tokens": max_tokens.unwrap_or(4096),
            "top_p": 0.9,
            // Anti-repetition: stops long completions from looping the same line near max_tokens.
            "frequency_penalty": 0.4,
            "presence_penalty": 0.2,
            "repetition_penalty": 1.15,
            "stream": false,
        });
        apply_model_chat_settings(&mut body, model);

        let response = with_chat_deadline(
            post_chat_with_retry(client, url, api_key, &body),
            deadline,
        )
        .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Chat error ({}): {}",
                status,
                error_text.chars().take(500).collect::<String>()
            ));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse chat response: {}", e))?;

        let parsed = parse_chat_completion(&data)?;
        request_ids.push(parsed.request_id.clone());
        combined.push_str(&parsed.content);
        total_prompt_tokens = total_prompt_tokens.saturating_add(parsed.prompt_tokens);
        total_completion_tokens = total_completion_tokens.saturating_add(parsed.completion_tokens);
        total_estimated_cost += parsed.estimated_cost;
        final_finish_reason = parsed.finish_reason.clone();
        response_model = parsed.model.clone();

        if !parsed.is_truncated() || round == CHAT_MAX_CONTINUATIONS {
            if parsed.is_truncated() {
                eprintln!(
                    "[ai_chat] Output still truncated after {} continuations",
                    CHAT_MAX_CONTINUATIONS
                );
            }
            break;
        }

        eprintln!(
            "[ai_chat] Output hit max_tokens; requesting continuation {}",
            round + 1
        );
        continuation_count += 1;
        // Push only this round's chunk — earlier chunks are already in the
        // history as previous assistant turns.
        messages_json.push(serde_json::json!({
            "role": "assistant",
            "content": parsed.content,
        }));
        messages_json.push(serde_json::json!({
            "role": "user",
            "content": "Your previous message was cut off mid-output. Continue EXACTLY where you left off — do not repeat anything already written, do not add any preamble.",
        }));
    }

    Ok(ChatCompletionResult {
        request_id: request_ids.join(","),
        content: combined,
        is_truncated: final_finish_reason == "length",
        finish_reason: final_finish_reason,
        model: response_model,
        prompt_tokens: total_prompt_tokens,
        completion_tokens: total_completion_tokens,
        estimated_cost: total_estimated_cost,
        continuation_count,
    })
}

/// Describe a screenshot with a vision model so the note-enhancement prompt can
/// reference what was on screen. Non-fatal by contract: callers treat an Err as
/// "no description" and continue.
#[tauri::command]
pub async fn describe_image(image_path: String, language: String) -> Result<String, String> {
    use base64::Engine;

    let (base_url, api_key, _) = get_deepinfra_config()?;
    let model =
        std::env::var("VISION_MODEL").unwrap_or_else(|_| "google/gemma-4-26B-A4B-it".to_string());

    let bytes = std::fs::read(&image_path).map_err(|e| format!("Read image: {}", e))?;
    let mime = match Path::new(&image_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    let data_uri = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": format!(
                    "This is a screen capture taken during a meeting. Describe it concisely in {}: visible titles, bullet/slide text, tables, diagrams, and any key numbers. Plain text only, max 120 words.",
                    language
                ) },
                { "type": "image_url", "image_url": { "url": data_uri } }
            ]
        }],
        "temperature": 0.2,
        "max_tokens": 512,
        "stream": false,
    });

    let response = Client::new()
        .post(format!("{}/chat/completions", base_url))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Vision request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Vision error ({}): {}", status, error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse vision response: {}", e))?;

    Ok(data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string())
}

#[tauri::command]
pub async fn ai_chat_stream(
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let (base_url, api_key, model) = get_deepinfra_config()?;
    let client = Client::new();
    let url = format!("{}/chat/completions", base_url);

    let messages_json: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    let body = serde_json::json!({
        "model": model,
        "messages": messages_json,
        "temperature": temperature.unwrap_or(0.7),
        "max_tokens": max_tokens.unwrap_or(4096),
        "top_p": 0.9,
        "frequency_penalty": 0.4,
        "presence_penalty": 0.2,
        "repetition_penalty": 1.15,
        "stream": true,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Chat stream request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Chat stream error ({}): {}", status, error_text));
    }

    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read stream: {}", e))?;

    let mut result = String::new();
    for line in body_text.lines() {
        if let Some(data_str) = line.strip_prefix("data: ") {
            let data_str = data_str.trim();
            if data_str == "[DONE]" || data_str.is_empty() {
                continue;
            }
            if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data_str) {
                if let Some(content) = chunk["choices"][0]["delta"]["content"].as_str() {
                    result.push_str(content);
                }
            }
        }
    }

    if result.is_empty() {
        return Err("Stream returned no content".to_string());
    }

    Ok(result)
}

// ==================== Transcription (DeepInfra Whisper) ====================

// DeepInfra Whisper accepts ~25MB per file. Stay well under that and split only
// at real MP3 frame boundaries so every uploaded part is a valid, decodable MP3.
const WHISPER_MAX_BYTES: usize = 20 * 1024 * 1024;
// Max concurrent Whisper requests — DeepInfra rate-limits under load; 2 keeps
// throughput high without triggering 429 floods when splitting large files.
const WHISPER_MAX_CONCURRENT: usize = 2;
// Retry up to this many times on 429 / "Model busy" with exponential backoff.
const WHISPER_MAX_RETRIES: u32 = 5;
// Language pinned when the caller doesn't pass one. Without a language the API
// auto-detects per request, and since we upload many chunks separately, quiet
// chunks get misdetected (en/es/fi) → polyglot garbage. A fixed language stops that.
const WHISPER_DEFAULT_LANGUAGE: &str = "id";

// In-flight live-transcription jobs keyed by the final MP3 path. The chunked
// recorder registers its background task here so `transcribe_audio` can AWAIT the
// real live result instead of racing it. Without this the command fires before
// the sidecar is written, falls through, and redundantly re-splits the whole MP3
// — doubling Whisper calls (and 429 risk), which defeats the live pipeline.
lazy_static::lazy_static! {
    static ref LIVE_TRANSCRIBE_JOBS: std::sync::Mutex<
        std::collections::HashMap<String, tokio::task::JoinHandle<()>>,
    > = std::sync::Mutex::new(std::collections::HashMap::new());
    static ref TRANSCRIBE_LOCKS: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>,
    > = std::sync::Mutex::new(std::collections::HashMap::new());
}

/// Canonical `.mp3` form of a recording path so the recorder and `transcribe_audio`
/// agree on the registry key (the frontend passes the same string to both).
fn mp3_key(path: &str) -> String {
    let p = std::path::PathBuf::from(path);
    if p.extension().map(|e| e == "mp3").unwrap_or(false) {
        p.to_string_lossy().to_string()
    } else {
        p.with_extension("mp3").to_string_lossy().to_string()
    }
}

fn transcript_sidecar_path(audio_path: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(audio_path);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    path.parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!("{}.transcript.txt", stem))
}

fn read_transcript_sidecar(audio_path: &str) -> Result<Option<String>, String> {
    let path = transcript_sidecar_path(audio_path);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Read transcript sidecar: {}", error))?;
    Ok((!text.trim().is_empty()).then_some(text))
}

fn persist_transcript_sidecar(audio_path: &str, transcript: &str) -> Result<(), String> {
    let path = transcript_sidecar_path(audio_path);
    persist_transcript_file(&path, transcript)
}

fn persist_transcript_file(path: &std::path::Path, transcript: &str) -> Result<(), String> {
    let temp = path.with_extension(format!("txt.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)
            .map_err(|error| format!("Create transcript sidecar temp file: {}", error))?;
        file.write_all(transcript.as_bytes())
            .map_err(|error| format!("Write transcript sidecar temp file: {}", error))?;
        file.sync_all()
            .map_err(|error| format!("Sync transcript sidecar temp file: {}", error))?;
        drop(file);
        #[cfg(windows)]
        {
            let backup = path.with_extension("txt.backup");
            if backup.exists() {
                std::fs::remove_file(&backup)
                    .map_err(|error| format!("Remove stale transcript backup: {}", error))?;
            }
            let had_previous = path.exists();
            if had_previous {
                std::fs::rename(path, &backup)
                    .map_err(|error| format!("Back up transcript sidecar: {}", error))?;
            }
            if let Err(error) = std::fs::rename(&temp, path) {
                if had_previous {
                    let _ = std::fs::rename(&backup, path);
                }
                return Err(format!("Commit transcript sidecar: {}", error));
            }
            if had_previous {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            std::fs::rename(&temp, path)
                .map_err(|error| format!("Commit transcript sidecar: {}", error))
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Register a live-transcription task for `mp3_path`. Called by the recorder
/// pipeline right after it spawns `transcribe_chunks_live`.
pub fn register_live_job(mp3_path: &std::path::Path, handle: tokio::task::JoinHandle<()>) {
    if let Ok(mut map) = LIVE_TRANSCRIBE_JOBS.lock() {
        map.insert(mp3_key(&mp3_path.to_string_lossy()), handle);
    }
}

fn take_live_job(audio_path: &str) -> Option<tokio::task::JoinHandle<()>> {
    LIVE_TRANSCRIBE_JOBS
        .lock()
        .ok()?
        .remove(&mp3_key(audio_path))
}

/// A short, language-appropriate prompt that anchors Whisper to real speech and
/// suppresses the subtitle/outro boilerplate it hallucinates on silence. Empty
/// for languages we have no seed for (we still rely on the pinned `language`).
fn whisper_initial_prompt(language: &str) -> &'static str {
    match language {
        "id" => "Rekaman rapat dalam Bahasa Indonesia.",
        "en" => "A meeting recording.",
        _ => "",
    }
}

/// Strip Whisper's non-speech hallucinations. On silence/low-energy audio Whisper
/// invents subtitle/outro boilerplate from its training data — "Terima kasih",
/// "Thank you", "like and subscribe", foreign thank-yous ("Kiitos", "Gracias") —
/// none of which is in the audio. We split into segments (Whisper joins them with
/// two spaces; newlines are treated as boundaries too), drop segments that are
/// exactly a known short phrase or start with a known outro, and collapse runs of
/// an identical repeated segment. Real speech embeds the short phrases inside a
/// larger sentence, so this two-tier match keeps false positives negligible.
fn clean_transcript(raw: &str) -> String {
    // Short phrases people genuinely say in meetings — dropped only when a
    // segment is EXACTLY this phrase (embedded uses stay).
    const EXACT: &[&str] = &[
        "terima kasih",
        "terima kasih banyak",
        "like dan subscribe",
        "thank you",
        "kiitos",
        "gracias",
        "subscribe",
        "please subscribe",
        "...",
    ];
    // Video-outro boilerplate that never occurs in real meeting speech — dropped
    // whenever a segment STARTS with it, so long variants ("... video ini sampai
    // habis") are caught too.
    const OUTRO_PREFIXES: &[&str] = &[
        "terima kasih telah menonton",
        "terima kasih sudah menonton",
        "terima kasih telah menyaksikan",
        "thank you for watching",
        "thanks for watching",
        "jangan lupa like",
        "jangan lupa subscribe",
        "sampai jumpa di video",
        "kiitos kun katsoit",
        "gracias por ver",
    ];

    fn norm(s: &str) -> String {
        s.trim()
            .trim_matches(|c: char| {
                c == '.' || c == '!' || c == '?' || c == ',' || c == '-' || c.is_whitespace()
            })
            .to_lowercase()
    }

    let mut kept: Vec<&str> = Vec::new();
    let mut prev_norm = String::new();
    for seg in raw.split("  ").flat_map(|s| s.split('\n')) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        let n = norm(seg);
        if n.is_empty()
            || EXACT.contains(&n.as_str())
            || OUTRO_PREFIXES.iter().any(|p| n.starts_with(p))
        {
            continue;
        }
        if n == prev_norm {
            continue; // collapse consecutive duplicate segments
        }
        prev_norm = n;
        kept.push(seg);
    }
    kept.join("  ")
}

/// Merge two consecutive live-chunk transcripts that share an overlapping audio
/// preamble. We prepend a few seconds of the previous chunk's audio to each live
/// chunk so a word straddling the hard 3-min cut is never lost — which makes
/// `next` begin by repeating the tail of `prev`. Find the largest word-overlap
/// (suffix of `prev` == prefix of `next`, normalized) and drop that duplicated
/// prefix from `next`. If no confident overlap is found we keep both: a little
/// duplication is harmless (the note step collapses it), losing words is not.
fn stitch_two(prev: &str, next: &str) -> String {
    let pw: Vec<&str> = prev.split_whitespace().collect();
    let nw: Vec<&str> = next.split_whitespace().collect();
    if pw.is_empty() {
        return next.trim().to_string();
    }
    if nw.is_empty() {
        return prev.trim().to_string();
    }

    let norm = |w: &str| -> String {
        w.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    };
    let pn: Vec<String> = pw.iter().map(|w| norm(w)).collect();
    let nn: Vec<String> = nw.iter().map(|w| norm(w)).collect();

    // Largest overlap first, capped to ~40 words (≈ the prepended preamble). Require
    // ≥4 aligned words and ≥80% match so a coincidental short run can't false-trigger.
    let max_k = pn.len().min(nn.len()).min(40);
    let mut overlap = 0usize;
    for k in (4..=max_k).rev() {
        let a = &pn[pn.len() - k..];
        let b = &nn[..k];
        let matches = a
            .iter()
            .zip(b.iter())
            .filter(|(x, y)| !x.is_empty() && x == y)
            .count();
        if matches * 5 >= k * 4 {
            overlap = k;
            break;
        }
    }

    let tail = nw[overlap..].join(" ");
    if tail.is_empty() {
        return prev.trim().to_string();
    }
    format!("{} {}", prev.trim_end(), tail).trim().to_string()
}

/// Fold `stitch_two` across all live-chunk parts, dropping the duplicated overlap
/// at each seam. Empty parts (silence chunks the filter emptied) are skipped.
fn stitch_overlapping(parts: &[String]) -> String {
    let mut iter = parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty());
    let mut acc = match iter.next() {
        Some(first) => first.to_string(),
        None => return String::new(),
    };
    for part in iter {
        acc = stitch_two(&acc, part);
    }
    acc
}

/// Skip an ID3v2 tag (syncsafe size) if present; returns the offset of audio.
fn skip_id3(data: &[u8]) -> usize {
    if data.len() >= 10 && &data[0..3] == b"ID3" {
        let size = ((data[6] as usize & 0x7F) << 21)
            | ((data[7] as usize & 0x7F) << 14)
            | ((data[8] as usize & 0x7F) << 7)
            | (data[9] as usize & 0x7F);
        (10 + size).min(data.len())
    } else {
        0
    }
}

/// Length in bytes of the MPEG audio frame starting at `h`, or None if `h` is
/// not a valid Layer III frame header.
fn mp3_frame_len(h: &[u8]) -> Option<usize> {
    if h.len() < 4 || h[0] != 0xFF || (h[1] & 0xE0) != 0xE0 {
        return None;
    }
    let version = (h[1] >> 3) & 0x03; // 0b11=MPEG1, 0b10=MPEG2, 0b00=MPEG2.5
    let layer = (h[1] >> 1) & 0x03; // 0b01=Layer III
    if layer != 0b01 {
        return None;
    }
    let br_index = (h[2] >> 4) & 0x0F;
    let sr_index = (h[2] >> 2) & 0x03;
    let padding = ((h[2] >> 1) & 0x01) as u32;
    if br_index == 0 || br_index == 0x0F || sr_index == 0x03 {
        return None;
    }
    const BR_MPEG1: [u32; 16] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    const BR_MPEG2: [u32; 16] = [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ];
    let mpeg1 = version == 0b11;
    let bitrate = 1000
        * if mpeg1 {
            BR_MPEG1[br_index as usize]
        } else {
            BR_MPEG2[br_index as usize]
        };
    let srate = match (version, sr_index) {
        (0b11, 0) => 44100,
        (0b11, 1) => 48000,
        (0b11, 2) => 32000,
        (0b10, 0) => 22050,
        (0b10, 1) => 24000,
        (0b10, 2) => 16000,
        (0b00, 0) => 11025,
        (0b00, 1) => 12000,
        (0b00, 2) => 8000,
        _ => return None,
    };
    if bitrate == 0 {
        return None;
    }
    // Layer III: 1152 samples/frame (MPEG1) or 576 (MPEG2/2.5).
    let len = if mpeg1 {
        144 * bitrate / srate + padding
    } else {
        72 * bitrate / srate + padding
    };
    Some(len as usize)
}

/// Split an MP3 into byte ranges `[start, end)` that each stay under `max_bytes`,
/// cutting only at MPEG frame boundaries (never mid-frame). Returns a single
/// full-length range if the file fits. Any region that can't be frame-parsed
/// (unrecognized header) is raw-split as a last resort so no returned range ever
/// exceeds `max_bytes` — a valid sub-limit upload beats rejecting the whole file.
fn split_mp3_frames(data: &[u8], max_bytes: usize) -> Vec<(usize, usize)> {
    if data.len() <= max_bytes {
        return vec![(0, data.len())];
    }
    let mut parts: Vec<(usize, usize)> = Vec::new();
    let mut part_start = 0usize;
    let mut pos = skip_id3(data);
    while pos + 4 <= data.len() {
        let Some(frame) = mp3_frame_len(&data[pos..]) else {
            break; // unrecognized header → stop scanning, bound the remainder below
        };
        if frame < 4 || pos + frame > data.len() {
            break;
        }
        if pos > part_start && (pos - part_start) + frame > max_bytes {
            parts.push((part_start, pos));
            part_start = pos;
        }
        pos += frame;
    }
    parts.push((part_start, data.len()));

    // Bound every part: raw-split any region that still exceeds max_bytes (the scan
    // bailed early on an unparseable header), so each upload stays under the limit.
    let mut bounded: Vec<(usize, usize)> = Vec::with_capacity(parts.len());
    for (start, end) in parts {
        if end - start <= max_bytes {
            bounded.push((start, end));
        } else {
            let mut off = start;
            while off < end {
                let cut = (off + max_bytes).min(end);
                bounded.push((off, cut));
                off = cut;
            }
        }
    }
    bounded
}

#[tauri::command]
pub async fn ensure_recordings_dir(path: String) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create recordings directory '{}': {}", path, e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn transcribe_audio(
    audio_path: String,
    language: Option<String>,
) -> Result<String, String> {
    let api_key = std::env::var("DEEPINFRA_API_KEY")
        .map_err(|_| "DEEPINFRA_API_KEY not configured in .env".to_string())?;
    let lang = language.unwrap_or_else(|| WHISPER_DEFAULT_LANGUAGE.to_string());
    let audio_key = mp3_key(&audio_path);
    let transcribe_lock = {
        let mut locks = TRANSCRIBE_LOCKS
            .lock()
            .map_err(|error| format!("Lock transcription registry: {}", error))?;
        locks
            .entry(audio_key)
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _transcribe_guard = transcribe_lock.lock().await;

    // If the chunked recorder is still transcribing this take live, await it so we
    // return its result instead of racing it into a redundant second full re-split.
    if let Some(job) = take_live_job(&audio_path) {
        let _ = job.await;
    }

    // Fast path: the chunked Linux pipeline pre-transcribes during recording and
    // writes a sidecar file. Return it instantly without re-reading the MP3.
    if let Some(text) = read_transcript_sidecar(&audio_path)? {
        eprintln!(
            "[transcribe] Returning persisted transcript ({} chars)",
            text.len()
        );
        return Ok(text);
    }

    let audio_bytes = std::fs::read(&audio_path)
        .map_err(|e| format!("Failed to read audio file '{}': {}", audio_path, e))?;

    if audio_bytes.is_empty() {
        return Err("Audio file is empty".to_string());
    }

    // Split at MP3 frame boundaries so each part is a valid, decodable MP3 under
    // the API's per-file limit. A file that already fits is sent as one request.
    let ranges = split_mp3_frames(&audio_bytes, WHISPER_MAX_BYTES);
    if ranges.len() == 1 {
        let text = transcribe_chunk(&api_key, &audio_bytes, "recording.mp3", &lang).await?;
        let result = clean_transcript(&text);
        persist_transcript_sidecar(&audio_path, &result)?;
        return Ok(result);
    }
    let num_chunks = ranges.len();

    eprintln!(
        "[transcribe] Splitting {}MB file into {} chunks for parallel upload",
        audio_bytes.len() / (1024 * 1024),
        num_chunks
    );

    // Rate-limited parallel upload: semaphore caps concurrent Whisper requests so
    // we don't flood DeepInfra and trigger 429 when splitting large files.
    // Each task also retries on 429 / "Model busy" with exponential backoff.
    let client = std::sync::Arc::new(Client::new());
    let shared = std::sync::Arc::new(audio_bytes);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(WHISPER_MAX_CONCURRENT));
    let mut handles = Vec::with_capacity(num_chunks);

    for (i, (start, end)) in ranges.into_iter().enumerate() {
        let key = api_key.clone();
        let name = format!("recording_part{}.mp3", i + 1);
        let c = client.clone();
        let buf = shared.clone();
        let sem = sem.clone();
        let lang = lang.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            transcribe_with_retry(&c, &key, &buf[start..end], &name, &lang).await
        }));
    }

    // Collect results in order
    let mut all_transcripts: Vec<String> = Vec::with_capacity(num_chunks);
    let mut failures = Vec::new();
    for (i, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(text)) => all_transcripts.push(text),
            Ok(Err(e)) => {
                eprintln!("[transcribe] Chunk {} failed: {}", i, e);
                failures.push(format!("part {}: {}", i + 1, e));
            }
            Err(e) => {
                eprintln!("[transcribe] Chunk {} task panicked: {}", i, e);
                failures.push(format!("part {}: task join error", i + 1));
            }
        }
    }

    if !failures.is_empty() {
        return Err(format!(
            "Transcription incomplete; {} of {} chunks failed ({})",
            failures.len(),
            num_chunks,
            failures.join("; ")
        ));
    }

    let result = all_transcripts
        .iter()
        .map(|t| clean_transcript(t))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    eprintln!("[transcribe] All {} chunks completed", num_chunks);
    persist_transcript_sidecar(&audio_path, &result)?;
    Ok(result)
}

/// Live transcription pipeline for the chunked recorder.
///
/// Receives per-chunk MP3 paths from `chunk_worker` as they are encoded (one
/// path per 3-minute chunk). Transcribes them concurrently under a semaphore
/// so the final transcript is ready by the time recording stops. Writes the
/// ordered result to `transcript_path`; `transcribe_audio` detects this file
/// and returns it instantly without re-reading the main MP3.
///
/// If `api_key` is empty, drains and discards the channel so the sender side
/// can close cleanly (no blocking).
pub async fn transcribe_chunks_live(
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<std::path::PathBuf>,
    api_key: String,
    transcript_path: std::path::PathBuf,
    language: String,
) {
    if api_key.is_empty() {
        while let Some(path) = receiver.recv().await {
            let _ = tokio::fs::remove_file(&path).await;
        }
        return;
    }

    let client = std::sync::Arc::new(Client::new());
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(WHISPER_MAX_CONCURRENT));
    let mut handles: Vec<tokio::task::JoinHandle<Result<String, String>>> = Vec::new();
    let mut chunk_count = 0usize;

    while let Some(path) = receiver.recv().await {
        let key = api_key.clone();
        let c = client.clone();
        let s = sem.clone();
        let lang = language.clone();
        let idx = chunk_count;
        let name = format!("chunk_{:04}.mp3", idx);
        handles.push(tokio::spawn(async move {
            let _permit = s.acquire().await.unwrap();
            eprintln!("[transcribe-live] Chunk {:04} uploading...", idx);
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| format!("Read chunk {}: {}", idx, e))?;
            let result = transcribe_with_retry(&c, &key, &bytes, &name, &lang).await;
            let _ = tokio::fs::remove_file(&path).await;
            result
        }));
        chunk_count += 1;
    }

    if handles.is_empty() {
        return;
    }

    eprintln!(
        "[transcribe-live] Collecting {} chunk results",
        handles.len()
    );
    let mut transcripts: Vec<String> = Vec::with_capacity(handles.len());
    let mut had_failure = false;
    for (i, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(text)) => transcripts.push(text),
            Ok(Err(e)) => {
                eprintln!("[transcribe-live] Chunk {} failed: {}", i, e);
                had_failure = true;
            }
            Err(e) => {
                eprintln!("[transcribe-live] Chunk {} panicked: {}", i, e);
                had_failure = true;
            }
        }
    }

    if had_failure {
        eprintln!("[transcribe-live] Incomplete result; canonical transcript was not committed");
        return;
    }

    // Clean each chunk, then stitch consecutive chunks at their overlapping seam
    // (the recorder prepends a few seconds of the previous chunk's audio so no word
    // is lost at the hard cut; stitch_overlapping removes the resulting duplicate).
    let cleaned: Vec<String> = transcripts.iter().map(|t| clean_transcript(t)).collect();
    let combined = stitch_overlapping(&cleaned);
    if combined.is_empty() {
        return;
    }

    match persist_transcript_file(&transcript_path, &combined) {
        Ok(()) => eprintln!(
            "[transcribe-live] Saved transcript: {} chars, {} parts → {}",
            combined.len(),
            transcripts.len(),
            transcript_path.display()
        ),
        Err(e) => eprintln!("[transcribe-live] Failed to save transcript: {}", e),
    }
}

/// Retry wrapper for a single chunk upload. Retries only on 429 / "Model busy"
/// with exponential backoff; other errors (auth, quota, network) fail fast.
async fn transcribe_with_retry(
    client: &Client,
    api_key: &str,
    audio_bytes: &[u8],
    file_name: &str,
    language: &str,
) -> Result<String, String> {
    let mut delay_secs = 2u64;
    for attempt in 0..=WHISPER_MAX_RETRIES {
        match transcribe_chunk_with_client(client, api_key, audio_bytes, file_name, language).await
        {
            Ok(text) => return Ok(text),
            Err(e)
                if attempt < WHISPER_MAX_RETRIES
                    && (e.contains("429") || e.contains("Model busy")) =>
            {
                eprintln!(
                    "[transcribe] {} rate-limited (attempt {}/{}), retrying in {}s",
                    file_name,
                    attempt + 1,
                    WHISPER_MAX_RETRIES,
                    delay_secs
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
                delay_secs = (delay_secs * 2).min(60);
            }
            Err(e) => return Err(e),
        }
    }
    Err(format!(
        "Transcription failed after {} retries for {}",
        WHISPER_MAX_RETRIES, file_name
    ))
}

/// Whisper model endpoint. Default is the full (non-turbo) large-v3 for best
/// accuracy: the live pipeline has minutes of slack between chunks, so the few
/// extra seconds per chunk are invisible. Override with WHISPER_MODEL (e.g.
/// "openai/whisper-large-v3-turbo") to trade accuracy for speed.
fn whisper_model_url() -> String {
    let model =
        std::env::var("WHISPER_MODEL").unwrap_or_else(|_| "openai/whisper-large-v3".to_string());
    format!("https://api.deepinfra.com/v1/inference/{}", model)
}

async fn transcribe_chunk(
    api_key: &str,
    audio_bytes: &[u8],
    file_name: &str,
    language: &str,
) -> Result<String, String> {
    let client = Client::new();
    transcribe_chunk_with_client(&client, api_key, audio_bytes, file_name, language).await
}

async fn transcribe_chunk_with_client(
    client: &Client,
    api_key: &str,
    audio_bytes: &[u8],
    file_name: &str,
    language: &str,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(audio_bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str("audio/mpeg")
        .map_err(|e| format!("Failed to create multipart: {}", e))?;

    // Pin the language (kills per-chunk auto-detect drifting to en/es/fi on quiet
    // chunks), force greedy decoding (temperature 0, fewer hallucinations), and
    // seed an initial prompt that anchors Whisper to speech instead of silence.
    let mut form = reqwest::multipart::Form::new()
        .part("audio", part)
        .text("temperature", "0");
    if !language.is_empty() {
        form = form.text("language", language.to_string());
    }
    let prompt = whisper_initial_prompt(language);
    if !prompt.is_empty() {
        form = form.text("initial_prompt", prompt);
    }

    let url = whisper_model_url();

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Transcription request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Transcription failed ({}): {}", status, error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse transcription response: {}", e))?;

    let transcript = data["text"].as_str().unwrap_or("");

    if transcript.is_empty() {
        return Err(format!(
            "Transcription returned empty. Response: {:?}",
            data
        ));
    }

    Ok(transcript.to_string())
}

#[tauri::command]
pub async fn agent_insert_document(
    user_id: String,
    text: String,
    metadata: Option<serde_json::Value>,
) -> Result<bool, String> {
    let (base_url, api_key) = get_agent_config()?;

    let client = Client::new();
    let url = format!("{}/opensearch/document/insert", base_url);

    let body = serde_json::json!({
        "user_id": user_id,
        "text": text,
        "metadata": metadata.unwrap_or_default(),
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-API-Key", &api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("RAG insert request failed: {}", e))?;

    if response.status().is_success() {
        Ok(true)
    } else {
        let error_text = response.text().await.unwrap_or_default();
        eprintln!("RAG document insert failed: {}", error_text);
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_check_collection(user_id: String) -> Result<bool, String> {
    let (base_url, api_key) = get_agent_config()?;

    let client = Client::new();
    let url = format!("{}/opensearch/collection/check/{}", base_url, user_id);

    let response = client
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| format!("Collection check failed: {}", e))?;

    if response.status().is_success() {
        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        Ok(data["exists"].as_bool().unwrap_or(false))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_create_collection(user_id: String) -> Result<bool, String> {
    let (base_url, api_key) = get_agent_config()?;

    let client = Client::new();
    let url = format!("{}/opensearch/collection/create", base_url);

    let body = serde_json::json!({ "user_id": user_id });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-API-Key", &api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Collection create failed: {}", e))?;

    if response.status().is_success() {
        Ok(true)
    } else {
        let error_text = response.text().await.unwrap_or_default();
        eprintln!("RAG collection creation failed: {}", error_text);
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_ensure_collection(user_id: String) -> Result<bool, String> {
    let exists = agent_check_collection(user_id.clone()).await?;
    if !exists {
        return agent_create_collection(user_id).await;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chat_completion_metadata() {
        let response = serde_json::json!({
            "id": "request-123",
            "model": "XiaomiMiMo/MiMo-V2.5",
            "choices": [{
                "message": { "content": "Detailed notes" },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 40,
                "estimated_cost": 0.00015219
            }
        });

        let parsed = parse_chat_completion(&response).unwrap();
        assert_eq!(parsed.request_id, "request-123");
        assert_eq!(parsed.content, "Detailed notes");
        assert_eq!(parsed.finish_reason, "stop");
        assert_eq!(parsed.model, "XiaomiMiMo/MiMo-V2.5");
        assert_eq!(parsed.prompt_tokens, 120);
        assert_eq!(parsed.completion_tokens, 40);
        assert!((parsed.estimated_cost - 0.00015219).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_length_finish_as_truncated() {
        let response = serde_json::json!({
            "model": "model",
            "choices": [{
                "message": { "content": "partial" },
                "finish_reason": "length"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 20 }
        });

        let parsed = parse_chat_completion(&response).unwrap();
        assert!(parsed.is_truncated());
    }

    #[test]
    fn rejects_chat_response_without_a_choice() {
        let response = serde_json::json!({ "model": "model", "choices": [] });
        assert!(parse_chat_completion(&response).is_err());
    }

    #[test]
    fn resolves_limits_for_the_configured_model() {
        let response = serde_json::json!({
            "data": [
                {
                    "id": "another/model",
                    "metadata": { "context_length": 8192, "max_tokens": 2048 }
                },
                {
                    "id": "XiaomiMiMo/MiMo-V2.5",
                    "metadata": { "context_length": 262144, "max_tokens": 16384 }
                }
            ]
        });

        let limits = parse_model_limits(&response, "XiaomiMiMo/MiMo-V2.5").unwrap();
        assert_eq!(limits.context_tokens, 262_144);
        assert_eq!(limits.max_output_tokens, 16_384);
    }

    #[test]
    fn model_output_limit_is_capped_to_provider_hard_limit() {
        let response = serde_json::json!({
            "data": [{
                "id": "model",
                "metadata": { "context_length": 1000000, "max_tokens": 1000000 }
            }]
        });

        let limits = parse_model_limits(&response, "model").unwrap();
        assert_eq!(limits.max_output_tokens, 16_384);
    }

    #[test]
    fn classifies_transient_chat_statuses_for_retry() {
        assert!(is_retryable_status(reqwest::StatusCode::REQUEST_TIMEOUT));
        assert!(is_retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!is_retryable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(reqwest::StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn model_chain_keeps_primary_first_and_deduplicates_fallbacks() {
        let models = parse_model_chain(
            "Qwen/Qwen3.6-35B-A3B",
            Some(" Qwen/Qwen3.5-397B-A17B, Qwen/Qwen3.6-35B-A3B ,, backup/model "),
        );

        assert_eq!(
            models,
            vec![
                "Qwen/Qwen3.6-35B-A3B",
                "Qwen/Qwen3.5-397B-A17B",
                "backup/model",
            ]
        );
    }

    #[test]
    fn economical_models_disable_billable_reasoning() {
        let mut body = serde_json::json!({
            "model": "deepseek-ai/DeepSeek-V4-Flash",
            "messages": [],
            "repetition_penalty": 1.15
        });

        apply_model_chat_settings(&mut body, "deepseek-ai/DeepSeek-V4-Flash");

        assert_eq!(body["reasoning"]["enabled"], false);
        assert_eq!(body["repetition_penalty"], 1.0);

        let mut fallback_body = serde_json::json!({ "model": "XiaomiMiMo/MiMo-V2.5" });
        apply_model_chat_settings(&mut fallback_body, "XiaomiMiMo/MiMo-V2.5");
        assert_eq!(fallback_body["reasoning"]["enabled"], false);
    }

    #[tokio::test]
    async fn chat_deadline_stops_a_stalled_provider_request() {
        let stalled = async {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            Ok::<_, String>("late response")
        };

        let started = std::time::Instant::now();
        let result = with_chat_deadline(stalled, std::time::Duration::from_millis(20)).await;

        assert_eq!(result.unwrap_err(), "Chat request timed out after 20ms");
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[tokio::test]
    async fn provider_client_times_out_while_waiting_for_response_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });
        let client = build_provider_client(std::time::Duration::from_millis(20)).unwrap();

        let started = std::time::Instant::now();
        let error = client
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();

        assert!(error.is_timeout());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        server.abort();
    }

    // 576-byte MPEG1 Layer III frame @ 192kbps/48kHz, no padding (FF FB B4 00).
    fn mp3_frame() -> Vec<u8> {
        let mut f = vec![0xFF, 0xFB, 0xB4, 0x00];
        f.resize(576, 0);
        f
    }

    #[test]
    fn parses_mpeg1_l3_192k_48k_frame_len() {
        assert_eq!(mp3_frame_len(&mp3_frame()), Some(576));
    }

    #[test]
    fn rejects_non_frame_header() {
        assert_eq!(mp3_frame_len(&[0x00, 0x00, 0x00, 0x00]), None);
        assert_eq!(mp3_frame_len(&[0xFF]), None);
    }

    #[test]
    fn small_file_stays_one_part() {
        let data = vec![0u8; 100];
        let parts = split_mp3_frames(&data, 1000);
        assert_eq!(parts, vec![(0, 100)]);
    }

    #[test]
    fn splits_only_on_frame_boundaries() {
        let frame = mp3_frame();
        let data: Vec<u8> = (0..10).flat_map(|_| frame.clone()).collect();
        assert_eq!(data.len(), 5760);

        let parts = split_mp3_frames(&data, 2000);
        let total: usize = parts.iter().map(|(s, e)| e - s).sum();
        assert_eq!(total, data.len(), "no bytes lost");
        assert!(parts.len() >= 3, "should split into multiple parts");
        // Contiguous, frame-aligned, and each within the limit.
        let mut expected_start = 0usize;
        for (s, e) in &parts {
            assert_eq!(*s, expected_start, "parts must be contiguous");
            let len = e - s;
            assert!(len <= 2000, "part exceeds max: {}", len);
            assert_eq!(len % 576, 0, "part not frame-aligned: {}", len);
            expected_start = *e;
        }
    }

    #[test]
    fn clean_drops_repeated_thankyou_hallucination() {
        let raw = "Oke mulai rapat.  Terima kasih.  Terima kasih.  Terima kasih.  Lanjut ya.";
        let cleaned = clean_transcript(raw);
        assert!(!cleaned.to_lowercase().contains("terima kasih"));
        assert!(cleaned.contains("Oke mulai rapat."));
        assert!(cleaned.contains("Lanjut ya."));
    }

    #[test]
    fn clean_drops_subscribe_and_foreign_outros() {
        // Pure hallucination chunk (silence) collapses to nothing.
        let raw = "Jangan lupa like, share dan subscribe ya.  Kiitos.  Gracias.  Thank you.";
        assert_eq!(clean_transcript(raw), "");
    }

    #[test]
    fn clean_keeps_real_speech_and_collapses_dupes() {
        let raw = "Targetnya 1000 meter.  Targetnya 1000 meter.  Oke setuju.";
        assert_eq!(clean_transcript(raw), "Targetnya 1000 meter.  Oke setuju.");
    }

    #[test]
    fn clean_drops_long_outro_variants() {
        let raw = "Poin pertama sudah final.  Terima kasih telah menonton video ini sampai habis.  Sampai jumpa di video berikutnya!";
        assert_eq!(clean_transcript(raw), "Poin pertama sudah final.");
    }

    #[test]
    fn clean_keeps_real_thanks_inside_sentences() {
        let raw = "Terima kasih atas presentasinya, lanjut ke agenda kedua.";
        assert_eq!(clean_transcript(raw), raw);
    }

    #[test]
    fn clean_handles_newline_separated_segments() {
        let raw = "Rapat dimulai.\nTerima kasih telah menonton.\nAgenda pertama anggaran.";
        let cleaned = clean_transcript(raw);
        assert!(!cleaned.to_lowercase().contains("menonton"));
        assert!(cleaned.contains("Rapat dimulai."));
        assert!(cleaned.contains("Agenda pertama anggaran."));
    }

    #[test]
    fn stitch_removes_overlapping_seam() {
        let prev = "kita mulai dari target pekerjaan satu juta meter kabel";
        let next = "satu juta meter kabel lalu lanjut ke instalasi berikutnya";
        assert_eq!(
            stitch_two(prev, next),
            "kita mulai dari target pekerjaan satu juta meter kabel lalu lanjut ke instalasi berikutnya"
        );
    }

    #[test]
    fn stitch_keeps_both_when_no_overlap() {
        let prev = "bagian pertama selesai";
        let next = "topik yang benar benar berbeda di sini";
        assert_eq!(
            stitch_two(prev, next),
            "bagian pertama selesai topik yang benar benar berbeda di sini"
        );
    }

    #[test]
    fn stitch_overlapping_folds_all_parts() {
        let parts = vec![
            "a b c satu dua tiga empat".to_string(),
            "satu dua tiga empat lima enam tujuh".to_string(),
            String::new(),
            "empat lima enam tujuh delapan sembilan".to_string(),
        ];
        assert_eq!(
            stitch_overlapping(&parts),
            "a b c satu dua tiga empat lima enam tujuh delapan sembilan"
        );
    }

    #[test]
    fn transcript_sidecar_can_be_read_repeatedly_without_being_consumed() {
        let dir = std::env::temp_dir().join(format!("atok-sidecar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("meeting.mp3");
        let audio_path = audio.to_string_lossy().to_string();
        persist_transcript_sidecar(&audio_path, "transkrip penting").unwrap();

        assert_eq!(
            read_transcript_sidecar(&audio_path).unwrap().as_deref(),
            Some("transkrip penting")
        );
        assert_eq!(
            read_transcript_sidecar(&audio_path).unwrap().as_deref(),
            Some("transkrip penting")
        );
        assert!(transcript_sidecar_path(&audio_path).is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn oversized_unparseable_region_is_raw_split() {
        // Bytes that never parse as MP3 frames and exceed max must come back as
        // bounded parts (raw fallback), never one oversized blob that the API rejects.
        let data = vec![0u8; 5000];
        let parts = split_mp3_frames(&data, 2000);
        assert!(parts.len() >= 3, "expected raw split, got {:?}", parts);
        let total: usize = parts.iter().map(|(s, e)| e - s).sum();
        assert_eq!(total, data.len(), "no bytes lost");
        for (s, e) in &parts {
            assert!(e - s <= 2000, "part exceeds max: {}", e - s);
        }
    }
}
