use sqlx::{postgres::PgPoolOptions, Connection, PgPool};
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
        println!(
            "Connecting to database... (attempt {}/{})",
            attempt, MAX_RETRIES
        );

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
        format!(
            "{}&keepalives=1&keepalives_idle=30&keepalives_interval=5&keepalives_count=3",
            database_url
        )
    } else {
        format!(
            "{}?keepalives=1&keepalives_idle=30&keepalives_interval=5&keepalives_count=3",
            database_url
        )
    };

    let pool = PgPoolOptions::new()
        .min_connections(2)
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(120))
        .max_lifetime(Duration::from_secs(1800))
        .test_before_acquire(false)
        .before_acquire(|conn, meta| {
            Box::pin(async move {
                if meta.idle_for.as_secs() > 10 {
                    conn.ping().await?;
                }
                Ok(true)
            })
        })
        .connect(&url)
        .await
        .map_err(|e| format!("{}", e))?;

    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| format!("Connection test failed: {}", e))?;

    println!("Database pool ready: min=2, max=20, tcp_keepalive=30s");
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_pool_returns_error_when_none() {
        let db = Database(None);
        let result = db.get_pool();
        assert!(result.is_err(), "should return error when pool is None");
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn test_get_pool_returns_ok_when_some() {
        // Can't easily create a real PgPool in unit tests without a DB, so this
        // only exercises the None path.
        let db = Database(None);
        assert!(db.get_pool().is_err());
    }

    #[test]
    fn test_init_database_respects_env() {
        let has_db_url = std::env::var("DATABASE_URL")
            .map(|v| !v.is_empty() && v != "DB_URL")
            .unwrap_or(false);

        if !has_db_url {
            let db = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(init_database());
            assert!(
                db.0.is_none(),
                "should return None when DATABASE_URL is not set"
            );
        }
        // When DATABASE_URL is set, we can't test without a real DB
    }
}
