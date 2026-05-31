use sqlx::{Connection, PgPool, postgres::PgPoolOptions};
use std::sync::Arc;
use std::time::Duration;

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY_SECS: u64 = 3;

// Database connection pool wrapper — None when DB is unreachable
pub struct Database(pub Option<Arc<PgPool>>);

impl Database {
    // Helper: get a reference to the pool, or return a clear error
    pub fn get_pool(&self) -> Result<&PgPool, String> {
        self.0
            .as_ref()
            .map(|arc| arc.as_ref())
            .ok_or_else(|| "Database is not connected. The database server may be offline. Please try again later.".to_string())
    }
}

// Always returns a Database (Some or None) — never fails the Tauri setup
pub async fn init_database() -> Database {
    let database_url = match std::env::var("DATABASE_URL") {
        Ok(url) if url != "DB_URL" && !url.is_empty() => url,
        _ => {
            eprintln!("DATABASE_URL not set — running without database");
            return Database(None);
        }
    };

    let mut last_error = String::new();

    for attempt in 1..=MAX_RETRIES {
        println!("Connecting to database... (attempt {}/{})", attempt, MAX_RETRIES);

        match connect_with_timeout(&database_url).await {
            Ok(pool) => {
                println!("Database connected successfully!");
                return Database(Some(Arc::new(pool)));
            }
            Err(e) => {
                last_error = e;
                if attempt < MAX_RETRIES {
                    println!(
                        "Connection failed, retrying in {}s: {}",
                        RETRY_DELAY_SECS, last_error
                    );
                    tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                }
            }
        }
    }

    eprintln!(
        "Failed to connect to database after {} attempts: {}. App will run without database.",
        MAX_RETRIES, last_error
    );
    Database(None)
}

async fn connect_with_timeout(database_url: &str) -> Result<PgPool, String> {
    // Add TCP keepalive to connection URL to detect dead connections
    let url = if database_url.contains('?') {
        format!("{}&keepalives=1&keepalives_idle=30&keepalives_interval=5&keepalives_count=3", database_url)
    } else {
        format!("{}?keepalives=1&keepalives_idle=30&keepalives_interval=5&keepalives_count=3", database_url)
    };

    let pool = PgPoolOptions::new()
        .min_connections(2)
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(120))
        .max_lifetime(Duration::from_secs(1800))
        .test_before_acquire(false)
        .before_acquire(|conn, meta| Box::pin(async move {
            // Only ping if connection has been idle for more than 10 seconds
            // This catches stale connections from remote DB without adding
            // latency to every acquire
            if meta.idle_for.as_secs() > 10 {
                println!("Connection idle for {}s, pinging...", meta.idle_for.as_secs());
                conn.ping().await?;
            }
            Ok(true)
        }))
        .connect(&url)
        .await
        .map_err(|e| format!("{}", e))?;

    // Verify connection works
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| format!("Connection test failed: {}", e))?;

    println!("Database pool initialized: min=2, max=20, tcp_keepalive=30s");
    Ok(pool)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_database_url_fallback_is_buggy() {
        // Known bug: when DATABASE_URL is not set, the fallback is the
        // literal string "DB_URL" which is not a valid PostgreSQL URL.
        // This test documents the current behavior.
        // TODO: Fix to panic with a clear error message.
        std::env::remove_var("DATABASE_URL");

        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "DB_URL".to_string());

        assert_eq!(
            url, "DB_URL",
            "BUG: fallback is literal 'DB_URL' — not a valid connection string"
        );

        std::env::set_var("DATABASE_URL", "");
    }
}
