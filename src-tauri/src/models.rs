use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;

// ==================== User Models ====================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub full_name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_verified: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_login_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub username: String,
    pub full_name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_verified: bool,
    pub is_active: bool,
}

impl From<User> for UserResponse {
    fn from(user: User) -> Self {
        UserResponse {
            id: user.id,
            email: user.email,
            username: user.username,
            full_name: user.full_name,
            avatar_url: user.avatar_url,
            is_verified: user.is_verified,
            is_active: user.is_active,
        }
    }
}

// ==================== Auth Request Models ====================

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    pub full_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub new_password: String,
}

// ==================== Auth Response Models ====================

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserResponse,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: String,
}

// ==================== Error Types ====================

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Database error: {0}")]
    Database(String),
    
    #[error("User not found")]
    UserNotFound,
    
    #[error("Invalid credentials")]
    InvalidCredentials,
    
    #[error("User already exists")]
    UserAlreadyExists,
    
    #[error("Invalid token")]
    InvalidToken,
    
    #[error("Token expired")]
    TokenExpired,
    
    #[error("Invalid reset token")]
    InvalidResetToken,
    
    #[error("Reset token expired")]
    ResetTokenExpired,
    
    #[error("Hashing error: {0}")]
    HashError(String),
    
    #[error("JWT error: {0}")]
    JwtError(String),
}

impl From<AuthError> for String {
    fn from(error: AuthError) -> Self {
        error.to_string()
    }
}

// ==================== Note Models ====================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Note {
    pub id: i32,
    pub user_id: String,
    pub title: String,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_favorite: bool,
    pub is_archived: bool,
    pub is_deleted: bool,
    pub color: Option<String>,
    pub reminder_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NoteResponse {
    pub id: i32,
    pub title: String,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_favorite: bool,
    pub is_archived: bool,
    pub color: Option<String>,
    pub reminder_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateNoteRequest {
    pub title: String,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateNoteRequest {
    pub id: i32,
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_favorite: Option<bool>,
    pub is_archived: Option<bool>,
    pub color: Option<String>,
}

// ==================== Task Models ====================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Task {
    pub id: i32,
    pub user_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: Option<String>,
    pub duration_minutes: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub due_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub is_deleted: bool,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskResponse {
    pub id: i32,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: Option<String>,
    pub duration_minutes: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub due_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: Option<String>,
    pub duration_minutes: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub due_date: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub id: i32,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub duration_minutes: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub due_date: Option<DateTime<Utc>>,
    pub position: Option<i32>,
}

// ==================== Task Position Update ====================

#[derive(Debug, Deserialize)]
pub struct TaskPositionUpdate {
    pub id: i32,
    pub position: i32,
    pub status: String,
}

// ==================== MCP Auth Models ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAuthConnection {
    pub id: i32,
    pub user_id: String,
    pub provider: String,
    pub provider_user_id: String,
    pub provider_username: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub provider_data: Option<JsonValue>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMcpAuthRequest {
    pub provider: String,
    pub provider_user_id: String,
    pub provider_username: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub provider_data: JsonValue,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMcpAuthRequest {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub provider_data: Option<JsonValue>,
}
