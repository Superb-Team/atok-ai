use crate::database::Database;
use crate::models::*;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    email: String,
    exp: usize,
}

fn get_jwt_secret() -> String {
    std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        eprintln!("WARNING: JWT_SECRET not set in .env! Using fallback dev key. THIS IS INSECURE.");
        "atok-ai-super-secret-jwt-key-development-2025".to_string()
    })
}

fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();

    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| AuthError::HashError(e.to_string()))
}

fn verify_password(password: &str, hash: &str) -> Result<bool, AuthError> {
    let parsed_hash = PasswordHash::new(hash).map_err(|e| AuthError::HashError(e.to_string()))?;

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

    let secret = get_jwt_secret();
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )
    .map_err(|e| AuthError::JwtError(e.to_string()))
}

fn verify_jwt(token: &str) -> Result<Claims, AuthError> {
    let secret = get_jwt_secret();
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| AuthError::JwtError(e.to_string()))
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Password Hashing ─────────────────────────────────

    #[test]
    fn test_hash_password_produces_valid_hash() {
        let hash = hash_password("my-secret-password").expect("hashing should succeed");
        assert!(
            hash.starts_with("$argon2"),
            "hash should be argon2 format, got: {}",
            hash
        );
        assert!(hash.len() > 50, "hash should be sufficiently long");
    }

    #[test]
    fn test_hash_password_same_input_produces_different_hashes() {
        let hash1 = hash_password("password123").unwrap();
        let hash2 = hash_password("password123").unwrap();
        // Salts are random, so hashes differ despite same password
        assert_ne!(
            hash1, hash2,
            "same password should produce different hashes due to random salt"
        );
    }

    #[test]
    fn test_hash_password_empty_string() {
        let hash = hash_password("").expect("hashing empty string should succeed");
        assert!(hash.starts_with("$argon2"));
    }

    #[test]
    fn test_hash_password_long_input() {
        let long = "a".repeat(1000);
        let hash = hash_password(&long).expect("hashing long input should succeed");
        assert!(hash.starts_with("$argon2"));
    }

    // ─── Password Verification ────────────────────────────

    #[test]
    fn test_verify_correct_password() {
        let hash = hash_password("correct-horse-battery-staple").unwrap();
        let result = verify_password("correct-horse-battery-staple", &hash).unwrap();
        assert!(result, "correct password should verify successfully");
    }

    #[test]
    fn test_verify_incorrect_password() {
        let hash = hash_password("correct-password").unwrap();
        let result = verify_password("wrong-password", &hash).unwrap();
        assert!(!result, "wrong password should not verify");
    }

    #[test]
    fn test_verify_case_sensitive() {
        let hash = hash_password("Password123").unwrap();
        let result = verify_password("password123", &hash).unwrap();
        assert!(!result, "passwords should be case-sensitive");
    }

    #[test]
    fn test_verify_empty_password() {
        let hash = hash_password("").unwrap();
        let result = verify_password("", &hash).unwrap();
        assert!(result);
        let result2 = verify_password("x", &hash).unwrap();
        assert!(!result2);
    }

    #[test]
    fn test_verify_invalid_hash_format() {
        let result = verify_password("anything", "not-a-valid-hash");
        assert!(result.is_err(), "invalid hash format should return error");
    }

    // ─── JWT Generation & Verification ────────────────────

    #[test]
    fn test_generate_and_verify_jwt_roundtrip() {
        let token = generate_jwt("user_abc123", "test@example.com").unwrap();
        let claims = verify_jwt(&token).unwrap();

        assert_eq!(claims.sub, "user_abc123");
        assert_eq!(claims.email, "test@example.com");
    }

    #[test]
    fn test_generate_jwt_different_users_have_different_tokens() {
        let token1 = generate_jwt("user_aaa", "a@example.com").unwrap();
        let token2 = generate_jwt("user_bbb", "b@example.com").unwrap();
        assert_ne!(token1, token2);
    }

    #[test]
    fn test_jwt_contains_three_parts() {
        let token = generate_jwt("user_test", "test@example.com").unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT should have 3 parts separated by dots");
    }

    #[test]
    fn test_verify_expired_jwt() {
        // Create a token that expires immediately
        let claims = Claims {
            sub: "user_test".to_string(),
            email: "test@example.com".to_string(),
            exp: 0, // Unix epoch — already expired
        };
        let secret = get_jwt_secret();
        let expired_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_ref()),
        )
        .unwrap();

        let result = verify_jwt(&expired_token);
        assert!(result.is_err(), "expired token should fail verification");
    }

    #[test]
    fn test_verify_tampered_jwt() {
        let token = generate_jwt("user_test", "test@example.com").unwrap();
        // Tamper with the payload by appending garbage
        let tampered = format!("{}x", token);
        let result = verify_jwt(&tampered);
        assert!(result.is_err(), "tampered token should fail verification");
    }

    #[test]
    fn test_verify_empty_token() {
        let result = verify_jwt("");
        assert!(result.is_err(), "empty token should fail");
    }

    #[test]
    fn test_verify_garbage_token() {
        let result = verify_jwt("not.a.jwt.token");
        assert!(result.is_err(), "garbage token should fail");
    }

    #[test]
    fn test_generate_jwt_has_future_expiration() {
        let token = generate_jwt("user_test", "test@example.com").unwrap();
        let claims = verify_jwt(&token).unwrap();
        let now = chrono::Utc::now().timestamp() as usize;
        assert!(claims.exp > now, "expiration should be in the future");
        // Should expire in roughly 7 days (604800 seconds)
        let seven_days = now + 604800;
        assert!(
            claims.exp <= seven_days + 10,
            "expiration should be ~7 days from now"
        );
    }

    // ─── Error Messages ───────────────────────────────────

    #[test]
    fn test_auth_error_display() {
        assert_eq!(AuthError::UserNotFound.to_string(), "User not found");
        assert_eq!(
            AuthError::InvalidCredentials.to_string(),
            "Invalid credentials"
        );
        assert_eq!(
            AuthError::UserAlreadyExists.to_string(),
            "User already exists"
        );
        assert_eq!(AuthError::InvalidToken.to_string(), "Invalid token");
        assert_eq!(AuthError::TokenExpired.to_string(), "Token expired");
    }

    #[test]
    fn test_auth_error_with_wrapped_message() {
        let err = AuthError::Database("connection refused".to_string());
        assert_eq!(err.to_string(), "Database error: connection refused");
    }

    #[test]
    fn test_auth_error_into_string() {
        let s: String = AuthError::InvalidCredentials.into();
        assert_eq!(s, "Invalid credentials");
    }

    // ─── Claims Serialization ─────────────────────────────

    #[test]
    fn test_claims_serialization_roundtrip() {
        let claims = Claims {
            sub: "user_abc".to_string(),
            email: "abc@test.com".to_string(),
            exp: 9999999999,
        };
        let json = serde_json::to_string(&claims).unwrap();
        let deserialized: Claims = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.sub, "user_abc");
        assert_eq!(deserialized.email, "abc@test.com");
        assert_eq!(deserialized.exp, 9999999999);
    }
}

#[tauri::command]
pub async fn register(
    db: State<'_, Database>,
    request: RegisterRequest,
) -> Result<AuthResponse, String> {
    let pool = db.get_pool()?;
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email = $1 OR username = $2",
    )
    .bind(&request.email)
    .bind(&request.username)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Database query failed: {}", e))?;

    if existing > 0 {
        return Err(AuthError::UserAlreadyExists.to_string());
    }

    let hashed_password = hash_password(&request.password).map_err(|e| e.to_string())?;

    // Create user — use 12 hex chars from UUID (16^12 = ~281 trillion possibilities)
    let user_id = format!(
        "user_{}",
        &Uuid::new_v4().to_string().replace("-", "")[..12]
    );

    sqlx::query(
        "INSERT INTO users (id, email, username, password, full_name, is_verified, is_active) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&user_id)
    .bind(&request.email)
    .bind(&request.username)
    .bind(&hashed_password)
    .bind(&request.full_name)
    .bind(false)
    .bind(true)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create user: {}", e))?;

    let token = generate_jwt(&user_id, &request.email).map_err(|e| e.to_string())?;

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
pub async fn login(db: State<'_, Database>, request: LoginRequest) -> Result<AuthResponse, String> {
    let pool = db.get_pool()?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1 OR username = $1")
        .bind(&request.email)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database query failed: {}", e))?
        .ok_or_else(|| AuthError::InvalidCredentials.to_string())?;

    if !verify_password(&request.password, &user.password).map_err(|e| e.to_string())? {
        return Err(AuthError::InvalidCredentials.to_string());
    }

    let _ = sqlx::query("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1")
        .bind(&user.id)
        .execute(pool)
        .await;

    let token = generate_jwt(&user.id, &user.email).map_err(|e| e.to_string())?;

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
    _db: State<'_, Database>,
    _request: ForgotPasswordRequest,
) -> Result<MessageResponse, String> {
    // Note: reset_token columns don't exist in current schema
    // This is a placeholder for future implementation
    Ok(MessageResponse {
        message: "Password reset feature coming soon".to_string(),
    })
}

#[tauri::command]
pub async fn reset_password(
    _db: State<'_, Database>,
    _request: ResetPasswordRequest,
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
    let claims = verify_jwt(&token).map_err(|e| e.to_string())?;

    let pool = db.get_pool()?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(&claims.sub)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database query failed: {}", e))?
        .ok_or_else(|| AuthError::UserNotFound.to_string())?;

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
