fn main() {
    // Compile Swift code for macOS ScreenCaptureKit audio capture
    #[cfg(target_os = "macos")]
    {
        swift_rs::build::SwiftLinker::new("atok_audio")
            .with_swift("swift/")
            .link();
    }

    tauri_build::build()
}
