use std::path::Path;

swift_rs::swift!(fn sc_start_system_audio(path: *const u8, path_len: u32) -> bool);
swift_rs::swift!(fn sc_stop_system_audio() -> bool);

pub struct MacSystemCapture {
    active: bool,
}

impl MacSystemCapture {
    pub fn start(session_dir: &Path) -> Result<Self, String> {
        let path = session_dir
            .to_str()
            .ok_or_else(|| "macOS capture session path is not valid UTF-8".to_string())?;
        let bytes = path.as_bytes();
        let path_len = u32::try_from(bytes.len())
            .map_err(|_| "macOS capture session path is too long".to_string())?;

        let started = unsafe { sc_start_system_audio(bytes.as_ptr(), path_len) };
        if !started {
            return Err(
                "ScreenCaptureKit failed to start. Check Screen Recording permission.".to_string(),
            );
        }

        Ok(Self { active: true })
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.stop_checked()
    }

    fn stop_checked(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        self.active = false;
        if unsafe { sc_stop_system_audio() } {
            Ok(())
        } else {
            Err("ScreenCaptureKit stopped after a capture or file-write error".to_string())
        }
    }
}

impl Drop for MacSystemCapture {
    fn drop(&mut self) {
        if self.active {
            let _ = self.stop_checked();
        }
    }
}
