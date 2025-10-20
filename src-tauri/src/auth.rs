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
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email = $1 OR username = $2"
    )
    .bind(&request.email)
    .bind(&request.username)
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
    let user_id = format!("user_{}", Uuid::new_v4().to_string().replace("-", "")[..6].to_string());
    
    sqlx::query(
        "INSERT INTO users (id, email, username, password, full_name, is_verified, is_active) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)"
    )
    .bind(&user_id)
    .bind(&request.email)
    .bind(&request.username)
    .bind(&hashed_password)
    .bind(&request.full_name)
    .bind(false)
    .bind(true)
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
            username: request.username,
            full_name: request.full_name,
            avatar_url: None,
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
    // Find user by email or username
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE email = $1 OR username = $1"
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
    
    // Update last login
    let _ = sqlx::query("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1")
        .bind(&user.id)
        .execute(db.0.as_ref())
        .await;
    
    // Generate JWT
    let token = generate_jwt(&user.id, &user.email)
        .map_err(|e| e.to_string())?;
    
    Ok(AuthResponse {
        token,
        user: UserResponse {
            id: user.id,
            email: user.email,
            username: user.username,
            full_name: user.full_name,
            avatar_url: user.avatar_url,
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
    // Note: reset_token columns don't exist in current schema
    // This is a placeholder for future implementation
    Ok(MessageResponse {
        message: "Password reset feature coming soon".to_string(),
    })
}

#[tauri::command]
pub async fn reset_password(
    db: State<'_, Database>,
    request: ResetPasswordRequest,
) -> Result<MessageResponse, String> {
    // Note: reset_token columns don't exist in current schema
    // This is a placeholder for future implementation
    Ok(MessageResponse {
        message: "Password reset feature coming soon".to_string(),
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
        "SELECT * FROM users WHERE id = $1"
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
    
    println!("User found: {} ({})", user.username, user.email);
    
    Ok(UserResponse {
        id: user.id,
        email: user.email,
        username: user.username,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        is_verified: user.is_verified,
        is_active: user.is_active,
    })
}
