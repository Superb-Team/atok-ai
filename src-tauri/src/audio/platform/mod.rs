//! Native capture orchestration, separated by operating system.

#[cfg(target_os = "macos")]
pub mod macos;
