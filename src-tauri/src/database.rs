use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;

// Database connection pool wrapper
pub struct Database(pub Arc<PgPool>);

// Initialize database connection pool
pub async fn init_database() -> Result<Database, String> {
    // Get database URL from environment variable
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| {
            "postgresql://postgres:%21Sup3rbT34m%3B@superbdb-1.c70cq4wkquyv.ap-southeast-1.rds.amazonaws.com:5432/postgres".to_string()
        });
    
    println!("Connecting to database...");
    
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;
    
    println!("Database connected successfully!");
    println!("Database schema already exists. Skipping migrations.");
    
    Ok(Database(Arc::new(pool)))
}
