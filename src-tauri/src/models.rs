use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

// ==================== User Models ====================

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub name: String,
    pub is_verified: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub reset_token: Option<String>,
    pub reset_token_expiry: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_verified: bool,
    pub is_active: bool,
}

impl From<User> for UserResponse {
    fn from(user: User) -> Self {
        UserResponse {
            id: user.id,
            email: user.email,
            name: user.name,
            is_verified: user.is_verified,
            is_active: user.is_active,
        }
    }
}

// ==================== Auth Request Models ====================

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub name: String,
    pub email: String,
    pub password: String,
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
