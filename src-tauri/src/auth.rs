use crate::database::Database;
use crate::models::*;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

// JWT Claims structure
#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,  // user id
    email: String,
    exp: usize,   // expiration time
}

const JWT_SECRET: &str = "atok-ai-super-secret-jwt-key-development-2025";

// ==================== Helper Functions ====================

fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| AuthError::HashError(e.to_string()))
}

fn verify_password(password: &str, hash: &str) -> Result<bool, AuthError> {
    let parsed_hash = PasswordHash::new(hash)
        .map_err(|e| AuthError::HashError(e.to_string()))?;
    
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

fn generate_jwt(user_id: &str, email: &str) -> Result<String, AuthError> {
    let expiration = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(7))
        .expect("valid timestamp")
        .timestamp() as usize;
    
    let claims = Claims {
        sub: user_id.to_string(),
        email: email.to_string(),
        exp: expiration,
    };
    
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(JWT_SECRET.as_ref()),
    )
    .map_err(|e| AuthError::JwtError(e.to_string()))
}

fn verify_jwt(token: &str) -> Result<Claims, AuthError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(JWT_SECRET.as_ref()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| AuthError::JwtError(e.to_string()))
}

fn generate_reset_token() -> String {
    let mut rng = rand::thread_rng();
    let token: String = (0..32)
        .map(|_| rng.sample(rand::distributions::Alphanumeric) as char)
        .collect();
    token
}

// ==================== Tauri Commands ====================

#[tauri::command]
pub async fn register(
    db: State<'_, Database>,
    request: RegisterRequest,
) -> Result<AuthResponse, String> {
    // Check if user exists
    let existing = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE email = $1")
        .bind(&request.email)
        .fetch_one(db.0.as_ref())
        .await
        .map_err(|e| format!("Database query failed: {}", e))?;
    
    if existing > 0 {
        return Err(AuthError::UserAlreadyExists.to_string());
    }
    
    // Hash password
    let hashed_password = hash_password(&request.password)
        .map_err(|e| e.to_string())?;
    
    // Create user
    let user_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    
    sqlx::query(
        "INSERT INTO users (id, email, password, name, is_verified, is_active, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
    )
    .bind(&user_id)
    .bind(&request.email)
    .bind(&hashed_password)
    .bind(&request.name)
    .bind(false)
    .bind(true)
    .bind(now)
    .bind(now)
    .execute(db.0.as_ref())
    .await
    .map_err(|e| format!("Failed to create user: {}", e))?;
    
    // Generate JWT
    let token = generate_jwt(&user_id, &request.email)
        .map_err(|e| e.to_string())?;
    
    Ok(AuthResponse {
        token,
        user: UserResponse {
            id: user_id,
            email: request.email,
            name: request.name,
            is_verified: false,
            is_active: true,
        },
    })
}

#[tauri::command]
pub async fn login(
    db: State<'_, Database>,
    request: LoginRequest,
) -> Result<AuthResponse, String> {
    // Find user
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, password, name, is_verified, is_active, created_at, updated_at, reset_token, reset_token_expiry 
         FROM users WHERE email = $1"
    )
    .bind(&request.email)
    .fetch_optional(db.0.as_ref())
    .await
    .map_err(|e| format!("Database query failed: {}", e))?
    .ok_or_else(|| AuthError::InvalidCredentials.to_string())?;
    
    // Verify password
    if !verify_password(&request.password, &user.password)
        .map_err(|e| e.to_string())? {
        return Err(AuthError::InvalidCredentials.to_string());
    }
    
    // Generate JWT
    let token = generate_jwt(&user.id, &user.email)
        .map_err(|e| e.to_string())?;
    
    Ok(AuthResponse {
        token,
        user: UserResponse {
            id: user.id,
            email: user.email,
            name: user.name,
            is_verified: user.is_verified,
            is_active: user.is_active,
        },
    })
}

#[tauri::command]
pub async fn forgot_password(
    db: State<'_, Database>,
    request: ForgotPasswordRequest,
) -> Result<MessageResponse, String> {
    // Find user
    let user_id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM users WHERE email = $1"
    )
    .bind(&request.email)
    .fetch_optional(db.0.as_ref())
    .await
    .map_err(|e| format!("Database query failed: {}", e))?
    .ok_or_else(|| AuthError::UserNotFound.to_string())?;
    
    // Generate reset token
    let reset_token = generate_reset_token();
    let expiry = Utc::now() + chrono::Duration::hours(1);
    
    // Save reset token
    sqlx::query(
        "UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3"
    )
    .bind(&reset_token)
    .bind(expiry)
    .bind(&user_id)
    .execute(db.0.as_ref())
    .await
    .map_err(|e| format!("Failed to save reset token: {}", e))?;
    
    // TODO: Send email with reset token
    // For now, just return the token (in production, send via email)
    
    Ok(MessageResponse {
        message: format!("Password reset token generated: {}", reset_token),
    })
}

#[tauri::command]
pub async fn reset_password(
    db: State<'_, Database>,
    request: ResetPasswordRequest,
) -> Result<MessageResponse, String> {
    // Find user by reset token
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, password, name, is_verified, is_active, created_at, updated_at, reset_token, reset_token_expiry 
         FROM users WHERE reset_token = $1"
    )
    .bind(&request.token)
    .fetch_optional(db.0.as_ref())
    .await
    .map_err(|e| format!("Database query failed: {}", e))?
    .ok_or_else(|| AuthError::InvalidResetToken.to_string())?;
    
    // Check if token is expired
    if let Some(expiry) = user.reset_token_expiry {
        if Utc::now() > expiry {
            return Err(AuthError::ResetTokenExpired.to_string());
        }
    } else {
        return Err(AuthError::InvalidResetToken.to_string());
    }
    
    // Hash new password
    let new_password_hash = hash_password(&request.new_password)
        .map_err(|e| e.to_string())?;
    
    // Update password and clear reset token
    sqlx::query(
        "UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL, updated_at = $2 WHERE id = $3"
    )
    .bind(&new_password_hash)
    .bind(Utc::now())
    .bind(&user.id)
    .execute(db.0.as_ref())
    .await
    .map_err(|e| format!("Failed to update password: {}", e))?;
    
    Ok(MessageResponse {
        message: "Password successfully reset".to_string(),
    })
}

#[tauri::command]
pub async fn get_current_user(
    db: State<'_, Database>,
    token: String,
) -> Result<UserResponse, String> {
    println!("get_current_user called with token: {}...", &token[..20.min(token.len())]);
    
    // Verify JWT
    let claims = verify_jwt(&token)
        .map_err(|e| {
            println!("JWT verification failed: {}", e);
            e.to_string()
        })?;
    
    println!("JWT verified, user_id from claims.sub: {}", claims.sub);
    
    // Fetch user
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, password, name, is_verified, is_active, created_at, updated_at, reset_token, reset_token_expiry 
         FROM users WHERE id = $1"
    )
    .bind(&claims.sub)
    .fetch_optional(db.0.as_ref())
    .await
    .map_err(|e| {
        println!("Database query failed: {}", e);
        format!("Database query failed: {}", e)
    })?
    .ok_or_else(|| {
        println!("User not found for id: {}", claims.sub);
        AuthError::UserNotFound.to_string()
    })?;
    
    println!("User found: {} ({})", user.name, user.email);
    
    Ok(UserResponse {
        id: user.id,
        email: user.email,
        name: user.name,
        is_verified: user.is_verified,
        is_active: user.is_active,
    })
}
