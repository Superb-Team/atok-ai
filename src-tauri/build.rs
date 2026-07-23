fn main() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("13.0")
            .with_package("AtokAudio", "swift")
            .link();
        // Swift concurrency is linked through @rpath. Point at macOS' bundled
        // runtime so development/test binaries do not load a second toolchain
        // copy alongside the system Swift libraries.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
