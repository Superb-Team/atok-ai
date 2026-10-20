//! Structured logging. Every event (Rust code, dependencies using the `log`
//! crate, and the webview via tauri-plugin-log) goes through `tracing` and is
//! written as JSON lines to a daily file in the app log directory.
//!
//! Filter with `RUST_LOG`, e.g. `RUST_LOG=debug` or `RUST_LOG=info,ipc=debug`.

use std::path::Path;

use tauri::ipc::Invoke;
use tauri::Runtime;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{fmt, EnvFilter, Registry};

/// Header set by the frontend IPC wrapper so one user action can be traced
/// across webview and backend log lines.
pub const REQUEST_ID_HEADER: &str = "x-request-id";

const DEFAULT_FILTER: &str =
    "info,sqlx=warn,hyper=warn,hyper_util=warn,reqwest=warn,tao=warn,wry=warn";
const KEPT_LOG_FILES: usize = 14;

pub fn init(log_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(log_dir)?;
    // Blocking writer on purpose: a non-blocking one drops the last lines when
    // the process exits, which are exactly the lines needed after a crash.
    let file_writer = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("atok")
        .filename_suffix("log")
        .max_log_files(KEPT_LOG_FILES)
        .build(log_dir)?;

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let subscriber = Registry::default()
        .with(filter)
        .with(
            fmt::layer()
                .json()
                .with_current_span(false)
                .with_writer(file_writer),
        )
        .with(fmt::layer().compact().with_writer(std::io::stderr));
    tracing::subscriber::set_global_default(subscriber)?;

    // tauri-plugin-log's `tracing` feature already emits webview logs as
    // tracing events; skip its `log` copy so each line is recorded once.
    tracing_log::LogTracer::builder()
        .ignore_crate(tauri_plugin_log::WEBVIEW_TARGET)
        .init()?;

    tracing::info!(log_dir = %log_dir.display(), "logging.initialized");
    Ok(())
}

pub fn log_command_received<R: Runtime>(invoke: &Invoke<R>) {
    let request_id = invoke
        .message
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");
    tracing::info!(
        target: "ipc",
        command = invoke.message.command(),
        request_id,
        window = invoke.message.webview().label(),
        "ipc.command.received"
    );
}

#[cfg(test)]
mod tests {
    use tracing_log::log;

    #[test]
    fn writes_json_lines_and_skips_the_webview_log_copy() {
        let dir = std::env::temp_dir().join(format!("atok-log-test-{}", uuid::Uuid::new_v4()));
        super::init(&dir).unwrap();

        tracing::info!(target: "ipc", command = "get_notes", request_id = "req-1", "ipc.command.received");
        log::warn!(target: "sqlx::pool", "pool slow");
        // tauri-plugin-log emits this copy after its own tracing event.
        log::info!(target: tauri_plugin_log::WEBVIEW_TARGET, "webview duplicate");

        let mut lines = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            lines.extend(
                text.lines()
                    .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()),
            );
        }
        std::fs::remove_dir_all(&dir).ok();

        let command = lines
            .iter()
            .find(|line| line["fields"]["message"] == "ipc.command.received")
            .expect("command line written");
        assert_eq!(command["fields"]["command"], "get_notes");
        assert_eq!(command["fields"]["request_id"], "req-1");
        assert_eq!(command["level"], "INFO");
        assert!(lines
            .iter()
            .any(|line| line["fields"]["message"] == "pool slow"));
        assert!(!lines
            .iter()
            .any(|line| line["fields"]["message"] == "webview duplicate"));
    }
}
