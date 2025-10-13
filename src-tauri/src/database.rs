use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;

// Database connection pool wrapper
pub struct Database(pub Arc<PgPool>);

// Initialize database connection pool
pub async fn init_database() -> Result<Database, String> {
    // Get database URL from environment variable
    // For AWS RDS PostgreSQL connection
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| {
            // Default AWS RDS connection (update database name if needed)
            "postgresql://postgres:%21Sup3rbT34m%3B@superbdb-1.c70cq4wkquyv.ap-southeast-1.rds.amazonaws.com:5432/postgres".to_string()
        });
    
    println!("Connecting to database...");
    
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;
    
    println!("Database connected successfully!");
    
    // Run migrations - create users table and indexes
    println!("Running database migrations...");
    
    // Create users table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            is_verified BOOLEAN NOT NULL DEFAULT FALSE,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reset_token TEXT UNIQUE,
            reset_token_expiry TIMESTAMPTZ
        )
        "#,
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create users table: {}", e))?;
    
    // Create email index
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create email index: {}", e))?;
    
    // Create reset_token index
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create reset_token index: {}", e))?;
    
    println!("Database migrations completed successfully!");
    
    Ok(Database(Arc::new(pool)))
}
