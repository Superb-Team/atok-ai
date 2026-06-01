// MCP Authentication Management
use crate::database::Database;
use crate::models::{CreateMcpAuthRequest, McpAuthConnection, UpdateMcpAuthRequest};
use serde_json::json;
use sqlx::Row;
use tauri::State;

#[tauri::command]
pub async fn get_mcp_connections(
    db: State<'_, Database>,
    user_id: String,
) -> Result<Vec<McpAuthConnection>, String> {
    let pool = db.get_pool()?;
    let query = "
        SELECT id, user_id, provider, provider_user_id, provider_username, 
               access_token, refresh_token, token_expires_at, provider_data,
               created_at, updated_at
        FROM mcp_auth
        WHERE user_id = $1
        ORDER BY created_at DESC
    ";

    let rows = sqlx::query(query)
        .bind(&user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch MCP connections: {}", e))?;

    let connections = rows
        .iter()
        .map(|row| McpAuthConnection {
            id: row.get("id"),
            user_id: row.get("user_id"),
            provider: row.get("provider"),
            provider_user_id: row.get("provider_user_id"),
            provider_username: row.get("provider_username"),
            access_token: row.get("access_token"),
            refresh_token: row.get("refresh_token"),
            token_expires_at: row.get("token_expires_at"),
            provider_data: row.get("provider_data"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect();

    Ok(connections)
}

#[tauri::command]
pub async fn get_mcp_connection(
    db: State<'_, Database>,
    user_id: String,
    provider: String,
) -> Result<Option<McpAuthConnection>, String> {
    let pool = db.get_pool()?;
    let query = "
        SELECT id, user_id, provider, provider_user_id, provider_username, 
               access_token, refresh_token, token_expires_at, provider_data,
               created_at, updated_at
        FROM mcp_auth
        WHERE user_id = $1 AND provider = $2
    ";

    let row = sqlx::query(query)
        .bind(&user_id)
        .bind(&provider)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to fetch MCP connection: {}", e))?;

    Ok(row.map(|r| McpAuthConnection {
        id: r.get("id"),
        user_id: r.get("user_id"),
        provider: r.get("provider"),
        provider_user_id: r.get("provider_user_id"),
        provider_username: r.get("provider_username"),
        access_token: r.get("access_token"),
        refresh_token: r.get("refresh_token"),
        token_expires_at: r.get("token_expires_at"),
        provider_data: r.get("provider_data"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

#[tauri::command]
pub async fn create_mcp_connection(
    db: State<'_, Database>,
    user_id: String,
    request: CreateMcpAuthRequest,
) -> Result<McpAuthConnection, String> {
    let pool = db.get_pool()?;
    // Check if connection already exists
    let existing =
        get_mcp_connection(db.clone(), user_id.clone(), request.provider.clone()).await?;

    if existing.is_some() {
        return Err(format!(
            "Connection for {} already exists",
            request.provider
        ));
    }

    let query = "
        INSERT INTO mcp_auth (
            user_id, provider, provider_user_id, provider_username,
            access_token, refresh_token, token_expires_at, provider_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, user_id, provider, provider_user_id, provider_username,
                  access_token, refresh_token, token_expires_at, provider_data,
                  created_at, updated_at
    ";

    let provider_data = json!({
        "login": request.provider_username,
        "email": request.provider_data.get("email"),
        "name": request.provider_data.get("name"),
    });

    let row = sqlx::query(query)
        .bind(&user_id)
        .bind(&request.provider)
        .bind(&request.provider_user_id)
        .bind(&request.provider_username)
        .bind(&request.access_token)
        .bind(&request.refresh_token)
        .bind(request.token_expires_at)
        .bind(&provider_data)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to create MCP connection: {}", e))?;

    Ok(McpAuthConnection {
        id: row.get("id"),
        user_id: row.get("user_id"),
        provider: row.get("provider"),
        provider_user_id: row.get("provider_user_id"),
        provider_username: row.get("provider_username"),
        access_token: row.get("access_token"),
        refresh_token: row.get("refresh_token"),
        token_expires_at: row.get("token_expires_at"),
        provider_data: row.get("provider_data"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

#[tauri::command]
pub async fn update_mcp_connection(
    db: State<'_, Database>,
    user_id: String,
    provider: String,
    request: UpdateMcpAuthRequest,
) -> Result<McpAuthConnection, String> {
    let pool = db.get_pool()?;
    let query = "
        UPDATE mcp_auth
        SET access_token = COALESCE($1, access_token),
            refresh_token = COALESCE($2, refresh_token),
            token_expires_at = COALESCE($3, token_expires_at),
            provider_data = COALESCE($4, provider_data)
        WHERE user_id = $5 AND provider = $6
        RETURNING id, user_id, provider, provider_user_id, provider_username,
                  access_token, refresh_token, token_expires_at, provider_data,
                  created_at, updated_at
    ";

    let row = sqlx::query(query)
        .bind(&request.access_token)
        .bind(&request.refresh_token)
        .bind(request.token_expires_at)
        .bind(&request.provider_data)
        .bind(&user_id)
        .bind(&provider)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to update MCP connection: {}", e))?;

    row.map(|r| McpAuthConnection {
        id: r.get("id"),
        user_id: r.get("user_id"),
        provider: r.get("provider"),
        provider_user_id: r.get("provider_user_id"),
        provider_username: r.get("provider_username"),
        access_token: r.get("access_token"),
        refresh_token: r.get("refresh_token"),
        token_expires_at: r.get("token_expires_at"),
        provider_data: r.get("provider_data"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    })
    .ok_or_else(|| format!("MCP connection not found for provider: {}", provider))
}

#[tauri::command]
pub async fn delete_mcp_connection(
    db: State<'_, Database>,
    user_id: String,
    provider: String,
) -> Result<String, String> {
    let pool = db.get_pool()?;
    let query = "
        DELETE FROM mcp_auth
        WHERE user_id = $1 AND provider = $2
        RETURNING id
    ";

    let row = sqlx::query(query)
        .bind(&user_id)
        .bind(&provider)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to delete MCP connection: {}", e))?;

    if row.is_some() {
        Ok(format!(
            "MCP connection for {} deleted successfully",
            provider
        ))
    } else {
        Err(format!(
            "MCP connection not found for provider: {}",
            provider
        ))
    }
}

#[tauri::command]
pub async fn test_mcp_connection(
    _db: State<'_, Database>,
    provider: String,
    access_token: String,
) -> Result<bool, String> {
    match provider.as_str() {
        "github" => {
            let client = reqwest::Client::new();
            let response = client
                .get("https://api.github.com/user")
                .header("Authorization", format!("Bearer {}", access_token))
                .header("User-Agent", "atok-ai")
                .send()
                .await
                .map_err(|e| format!("Failed to test GitHub connection: {}", e))?;

            Ok(response.status().is_success())
        }
        _ => Err(format!("Unsupported provider: {}", provider)),
    }
}
