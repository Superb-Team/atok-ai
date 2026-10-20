use std::{env, ffi::OsStr, path::Path};

pub struct GraphicsStartup {
    pub nvidia_driver_loaded: bool,
    pub explicit_sync_workaround: bool,
    pub explicit_sync_override: bool,
}

pub fn configure() -> GraphicsStartup {
    let nvidia_driver_loaded = Path::new("/sys/module/nvidia").is_dir()
        || Path::new("/proc/driver/nvidia/version").is_file();
    let explicit_sync_override = env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_some();
    let explicit_sync_workaround = should_disable_explicit_sync(
        env::var_os("WAYLAND_DISPLAY").as_deref(),
        env::var_os("GDK_BACKEND").as_deref(),
        nvidia_driver_loaded,
        explicit_sync_override,
    );

    if explicit_sync_workaround {
        // Set before Tauri/GTK starts threads or creates a display. Keep GPU rendering.
        // https://v2.tauri.app/develop/debug/linux-graphics/#workarounds
        env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

    GraphicsStartup {
        nvidia_driver_loaded,
        explicit_sync_workaround,
        explicit_sync_override,
    }
}

fn should_disable_explicit_sync(
    wayland_display: Option<&OsStr>,
    gdk_backend: Option<&OsStr>,
    nvidia_driver_loaded: bool,
    explicit_sync_override: bool,
) -> bool {
    if !nvidia_driver_loaded || explicit_sync_override {
        return false;
    }
    if !wayland_display.is_some_and(|display| !display.is_empty()) {
        return false;
    }
    // Respect the first backend preference, including XWayland on a Wayland desktop.
    match gdk_backend.and_then(OsStr::to_str) {
        None | Some("") => true,
        Some(backends) => matches!(backends.split(',').next(), Some("wayland" | "*")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_nvidia_wayland_without_an_override() {
        let cases = [
            (Some("wayland-1"), None, true, false, true),
            (Some("wayland-1"), Some("wayland"), true, false, true),
            (Some("wayland-1"), Some("wayland,x11"), true, false, true),
            (Some("wayland-1"), Some("*"), true, false, true),
            (Some("wayland-1"), Some(""), true, false, true),
            (Some("wayland-1"), None, false, false, false),
            (None, None, true, false, false),
            (Some(""), None, true, false, false),
            (Some("wayland-1"), Some("x11"), true, false, false),
            (Some("wayland-1"), Some("x11,wayland"), true, false, false),
            (Some("wayland-1"), Some("broadway"), true, false, false),
            (Some("wayland-1"), None, true, true, false),
        ];
        for (display, backend, nvidia, overridden, expected) in cases {
            assert_eq!(
                should_disable_explicit_sync(
                    display.map(OsStr::new),
                    backend.map(OsStr::new),
                    nvidia,
                    overridden,
                ),
                expected,
                "display={display:?}, backend={backend:?}, nvidia={nvidia}, override={overridden}"
            );
        }
    }
}
