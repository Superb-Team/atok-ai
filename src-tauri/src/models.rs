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
#[allow(dead_code)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
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

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // ─── UserResponse from User ───────────────────────────

    #[test]
    fn test_user_to_user_response_excludes_password() {
        let user = User {
            id: "user_abc123".to_string(),
            email: "test@example.com".to_string(),
            username: "testuser".to_string(),
            password: "super-secret-hash".to_string(),
            full_name: Some("Test User".to_string()),
            avatar_url: None,
            is_verified: false,
            is_active: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            last_login_at: None,
        };
        let response: UserResponse = user.into();
        assert_eq!(response.id, "user_abc123");
        assert_eq!(response.email, "test@example.com");
        assert_eq!(response.username, "testuser");
        assert_eq!(response.full_name, Some("Test User".to_string()));
        assert_eq!(response.avatar_url, None);
        assert!(!response.is_verified);
        assert!(response.is_active);
    }

    #[test]
    fn test_user_response_serialization_excludes_password() {
        let response = UserResponse {
            id: "user_xyz".to_string(),
            email: "xyz@test.com".to_string(),
            username: "xyz".to_string(),
            full_name: None,
            avatar_url: None,
            is_verified: true,
            is_active: true,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(!json.contains("password"), "serialized UserResponse should not contain password");
        assert!(json.contains("user_xyz"));
        assert!(json.contains("xyz@test.com"));
    }

    // ─── AuthError derive ─────────────────────────────────

    #[test]
    fn test_auth_error_implements_debug() {
        let err = AuthError::UserNotFound;
        let debug_str = format!("{:?}", err);
        assert!(debug_str.contains("UserNotFound"));
    }

    #[test]
    fn test_auth_error_implements_thiserror() {
        let err = AuthError::InvalidCredentials;
        assert_eq!(err.to_string(), "Invalid credentials");

        let hash_err = AuthError::HashError("bad input".into());
        assert_eq!(hash_err.to_string(), "Hashing error: bad input");

        let jwt_err = AuthError::JwtError("expired".into());
        assert_eq!(jwt_err.to_string(), "JWT error: expired");
    }

    #[test]
    fn test_auth_error_into_string_via_from() {
        let s: String = AuthError::TokenExpired.into();
        assert_eq!(s, "Token expired");

        let err = AuthError::InvalidToken;
        let _s: String = err.into();
    }

    // ─── Request/Response Deserialization ─────────────────

    #[test]
    fn test_register_request_deserialization() {
        let json = r#"{
            "username": "newuser",
            "email": "new@example.com",
            "password": "secret123"
        }"#;
        let req: RegisterRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.username, "newuser");
        assert_eq!(req.email, "new@example.com");
        assert_eq!(req.password, "secret123");
        assert!(req.full_name.is_none());
    }

    #[test]
    fn test_register_request_with_full_name() {
        let json = r#"{
            "username": "jane",
            "email": "jane@example.com",
            "password": "pass",
            "full_name": "Jane Doe"
        }"#;
        let req: RegisterRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.full_name, Some("Jane Doe".to_string()));
    }

    #[test]
    fn test_login_request_deserialization() {
        let json = r#"{"email": "user@test.com", "password": "mypass"}"#;
        let req: LoginRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.email, "user@test.com");
        assert_eq!(req.password, "mypass");
    }

    #[test]
    fn test_auth_response_serialization() {
        let response = AuthResponse {
            token: "eyJhbGci...".to_string(),
            user: UserResponse {
                id: "user_1".to_string(),
                email: "u@t.com".to_string(),
                username: "u".to_string(),
                full_name: None,
                avatar_url: None,
                is_verified: false,
                is_active: true,
            },
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("eyJhbGci..."));
        assert!(json.contains("user_1"));
    }

    #[test]
    fn test_message_response_serialization() {
        let msg = MessageResponse {
            message: "operation successful".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"message":"operation successful"}"#);
    }

    // ─── CreateNoteRequest ────────────────────────────────

    #[test]
    fn test_create_note_request_minimal() {
        let json = r#"{"title": "My Note"}"#;
        let req: CreateNoteRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "My Note");
        assert!(req.content.is_none());
        assert!(req.tags.is_none());
        assert!(req.color.is_none());
    }

    #[test]
    fn test_create_note_request_full() {
        let json = r##"{
            "title": "Full Note",
            "content": "Some content",
            "tags": ["tag1", "tag2"],
            "color": "#FF5733"
        }"##;
        let req: CreateNoteRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "Full Note");
        assert_eq!(req.content, Some("Some content".to_string()));
        assert_eq!(req.tags, Some(vec!["tag1".to_string(), "tag2".to_string()]));
        assert_eq!(req.color, Some("#FF5733".to_string()));
    }

    #[test]
    fn test_update_note_request_partial_fields() {
        let json = r#"{"id": 42, "title": "Updated Title"}"#;
        let req: UpdateNoteRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, 42);
        assert_eq!(req.title, Some("Updated Title".to_string()));
        assert!(req.content.is_none());
        assert!(req.tags.is_none());
        assert!(req.is_favorite.is_none());
    }

    #[test]
    fn test_create_task_request() {
        let json = r#"{
            "title": "New Task",
            "status": "today",
            "duration_minutes": 30,
            "tags": ["urgent"]
        }"#;
        let req: CreateTaskRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "New Task");
        assert_eq!(req.status, "today");
        assert_eq!(req.duration_minutes, Some(30));
    }

    #[test]
    fn test_task_position_update_deserialization() {
        let json = r#"{"id": 5, "position": 2, "status": "this_week"}"#;
        let update: TaskPositionUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(update.id, 5);
        assert_eq!(update.position, 2);
        assert_eq!(update.status, "this_week");
    }

    #[test]
    fn test_create_mcp_auth_request() {
        let json = r#"{
            "provider": "github",
            "provider_user_id": "12345",
            "access_token": "gho_xxx",
            "provider_data": {"login": "testuser"}
        }"#;
        let req: CreateMcpAuthRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.provider, "github");
        assert_eq!(req.provider_user_id, "12345");
        assert_eq!(req.access_token, "gho_xxx");
    }

    #[test]
    fn test_note_response_serialization() {
        let now = Utc.with_ymd_and_hms(2025, 1, 15, 10, 30, 0).unwrap();
        let response = NoteResponse {
            id: 1,
            title: "Test Note".to_string(),
            content: Some("# Heading".to_string()),
            tags: Some(vec!["test".to_string()]),
            is_favorite: true,
            is_archived: false,
            color: Some("#FFFFFF".to_string()),
            reminder_at: None,
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("Test Note"));
        assert!(json.contains("is_favorite"));
    }
}
