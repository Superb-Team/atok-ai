// AI Backend — all API calls go through here (keys never exposed to frontend)
//
// Supported providers:
//   - DeepInfra (OpenAI-compatible): chat completions, streaming, Whisper transcription
//   - Agent API: custom transcription, RAG

use reqwest::Client;
use std::path::Path;

// ==================== Config ====================

fn get_deepinfra_config() -> Result<(String, String, String), String> {
    let api_key = std::env::var("DEEPINFRA_API_KEY")
        .map_err(|_| "DEEPINFRA_API_KEY not configured in .env".to_string())?;
    let model = std::env::var("DEEPINFRA_MODEL")
        .unwrap_or_else(|_| "XiaomiMiMo/MiMo-V2.5".to_string());
    let base_url = std::env::var("DEEPINFRA_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepinfra.com/v1/openai".to_string());

    if api_key.is_empty() {
        return Err("DEEPINFRA_API_KEY is empty".to_string());
    }

    Ok((base_url, api_key, model))
}

fn get_agent_config() -> Result<(String, String), String> {
    let base_url = std::env::var("AGENT_BASE_URL")
        .map_err(|_| "AGENT_BASE_URL not configured".to_string())?;
    let api_key = std::env::var("AGENT_API_KEY")
        .map_err(|_| "AGENT_API_KEY not configured".to_string())?;

    if base_url.is_empty() || api_key.is_empty() {
        return Err("Agent API not configured".to_string());
    }

    Ok((base_url, api_key))
}

// ==================== DeepInfra Chat ====================

#[derive(serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn ai_chat(
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
        "stream": false,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Chat request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Chat error ({}): {}", status, error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse chat response: {}", e))?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("No response");

    Ok(content.to_string())
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

    // Parse SSE chunks
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

// ==================== Transcription (Groq Whisper) ====================

const GROQ_MAX_FILE_SIZE: usize = 24 * 1024 * 1024; // 24MB (safe margin under 25MB limit)

fn get_groq_api_key() -> Result<String, String> {
    std::env::var("GROQ_API_KEY")
        .map_err(|_| "GROQ_API_KEY not configured in .env".to_string())
}

#[tauri::command]
pub async fn ensure_recordings_dir(path: String) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create recordings directory: {}", e))?;
        println!("Created recordings directory: {}", path);
    }
    Ok(())
}

#[tauri::command]
pub async fn transcribe_audio(audio_path: String) -> Result<String, String> {
    let api_key = get_groq_api_key()?;

    println!("Transcribing audio via Groq Whisper: {}", audio_path);

    let audio_bytes = std::fs::read(&audio_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    let total_size = audio_bytes.len();
    println!("Audio file size: {} bytes ({:.1} MB)", total_size, total_size as f64 / 1024.0 / 1024.0);

    if audio_bytes.is_empty() {
        return Err("Audio file is empty".to_string());
    }

    // If file is small enough, transcribe directly
    if total_size <= GROQ_MAX_FILE_SIZE {
        println!("File fits in single request, transcribing...");
        return transcribe_chunk(&api_key, &audio_bytes, "recording.mp3").await;
    }

    // File is too large — split into chunks
    let num_chunks = total_size.div_ceil(GROQ_MAX_FILE_SIZE);
    println!("File too large, splitting into {} chunks...", num_chunks);

    let mut all_transcripts: Vec<String> = Vec::new();

    for (i, chunk) in audio_bytes.chunks(GROQ_MAX_FILE_SIZE).enumerate() {
        println!("Transcribing chunk {}/{} ({} bytes)...", i + 1, num_chunks, chunk.len());

        let chunk_name = format!("recording_part{}.mp3", i + 1);
        match transcribe_chunk(&api_key, chunk, &chunk_name).await {
            Ok(text) => {
                println!("Chunk {}/{} completed: {} chars", i + 1, num_chunks, text.len());
                all_transcripts.push(text);
            }
            Err(e) => {
                println!("Chunk {}/{} failed: {}", i + 1, num_chunks, e);
                all_transcripts.push(format!("[Transcription failed for part {}: {}]", i + 1, e));
            }
        }
    }

    let combined = all_transcripts.join("\n\n");
    println!("All chunks completed, total: {} chars", combined.len());
    Ok(combined)
}

async fn transcribe_chunk(api_key: &str, audio_bytes: &[u8], file_name: &str) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(audio_bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str("audio/mpeg")
        .map_err(|e| format!("Failed to create multipart: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-large-v3");

    let client = Client::new();
    let url = "https://api.groq.com/openai/v1/audio/transcriptions";

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

    let transcript = data["text"]
        .as_str()
        .unwrap_or("");

    if transcript.is_empty() {
        return Err(format!("Transcription returned empty. Response: {:?}", data));
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
        println!("Document inserted to RAG for user: {}", user_id);
        Ok(true)
    } else {
        let error_text = response.text().await.unwrap_or_default();
        println!("RAG insert failed: {}", error_text);
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
        println!("Collection created for user: {}", user_id);
        Ok(true)
    } else {
        let error_text = response.text().await.unwrap_or_default();
        println!("Collection create failed: {}", error_text);
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_ensure_collection(user_id: String) -> Result<bool, String> {
    let exists = agent_check_collection(user_id.clone()).await?;
    if !exists {
        println!("Collection not found for user {}, creating...", user_id);
        return agent_create_collection(user_id).await;
    }
    Ok(true)
}
