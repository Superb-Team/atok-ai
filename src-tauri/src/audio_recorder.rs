// Cross-platform audio recorder
//
// Captures both microphone AND system audio (desktop/device) like Google Meet/Zoom/Discord
//
// Windows: WASAPI loopback + mic (windows_audio.rs)
// Linux:   PulseAudio monitor source + mic via parec
// macOS:   ffmpeg avfoundation (system audio + mic)

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct DesktopAudioRecorder {
    is_recording: Arc<Mutex<bool>>,
    recording_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl DesktopAudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(Mutex::new(false)),
            recording_thread: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start_recording(&self, output_path: PathBuf) -> Result<(), String> {
        let mut recording = self.is_recording.lock().map_err(|e| e.to_string())?;
        if *recording {
            return Err("Already recording".to_string());
        }
        *recording = true;
        drop(recording);

        let is_recording = Arc::clone(&self.is_recording);
        let thread_handle = std::thread::spawn(move || {
            if let Err(e) = Self::record(output_path, is_recording) {
                eprintln!("Recording error: {}", e);
            }
        });

        *self.recording_thread.lock().map_err(|e| e.to_string())? = Some(thread_handle);
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        println!("Stopping recording...");
        {
            let mut recording = self.is_recording.lock().map_err(|e| e.to_string())?;
            if !*recording {
                println!("Recording already stopped");
                return Ok(());
            }
            *recording = false;
        }

        std::thread::sleep(std::time::Duration::from_millis(500));

        let mut thread_lock = self.recording_thread.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = thread_lock.take() {
            let join_handle = std::thread::spawn(move || handle.join());
            for _ in 0..30 {
                if join_handle.is_finished() {
                    let _ = join_handle.join();
                    println!("Recording stopped gracefully");
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            println!("Recording thread timed out");
        }
        println!("Recording stopped");
        Ok(())
    }

    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }

    fn record(output_path: PathBuf, is_recording: Arc<Mutex<bool>>) -> Result<(), String> {
        let mp3_path = match output_path.extension().and_then(|s| s.to_str()) {
            Some("mp3") => output_path,
            _ => output_path.with_extension("mp3"),
        };

        if let Some(parent) = mp3_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
        }

        // Try platform-specific recording first
        let platform_result = {
            #[cfg(target_os = "linux")]
            { Self::record_linux(&mp3_path, &is_recording) }

            #[cfg(target_os = "macos")]
            { Self::record_macos(&mp3_path, &is_recording) }
        };

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            match platform_result {
                Ok(()) => return Ok(()),
                Err(e) => println!("Platform recording failed: {}, falling back to cpal", e),
            }
        }

        // Fallback: cpal (mic only)
        Self::record_with_cpal(&mp3_path, &is_recording)
    }

    // ==================== Linux: PulseAudio ====================

    #[cfg(target_os = "linux")]
    fn record_linux(mp3_path: &Path, is_recording: &Arc<Mutex<bool>>) -> Result<(), String> {
        use std::process::{Command, Stdio};

        if !Self::cmd_exists("pactl") || !Self::cmd_exists("parec") {
            return Err("pactl/parec not available".to_string());
        }

        println!("PulseAudio recording starting...");

        let monitor = Self::find_monitor_source()?;
        let mic = Self::find_default_source()?;
        let sample_rate = Self::get_source_sample_rate(&monitor);
        let channels = 2u32;
        println!("Monitor: {}, Mic: {}, Rate: {}Hz", monitor, mic, sample_rate);

        let desktop_wav = "/tmp/atok_desktop.wav";
        let mic_wav = "/tmp/atok_mic.wav";
        let _ = std::fs::remove_file(desktop_wav);
        let _ = std::fs::remove_file(mic_wav);

        let mut desktop_proc = Command::new("parec")
            .args(["--device", &monitor, "--format=s16le",
                &format!("--rate={}", sample_rate), &format!("--channels={}", channels),
                "--file-format=wav", desktop_wav])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("Failed to start desktop: {}", e))?;

        let mut mic_proc = Command::new("parec")
            .args(["--device", &mic, "--format=s16le",
                &format!("--rate={}", sample_rate), &format!("--channels={}", channels),
                "--file-format=wav", mic_wav])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("Failed to start mic: {}", e))?;

        println!("Recording system audio + microphone...");

        while *is_recording.lock().unwrap() {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let _ = mic_proc.kill();
        let _ = desktop_proc.kill();
        let _ = mic_proc.wait();
        let _ = desktop_proc.wait();
        std::thread::sleep(std::time::Duration::from_millis(300));

        let has_desktop = Self::file_ok(desktop_wav);
        let has_mic = Self::file_ok(mic_wav);

        if has_desktop && has_mic {
            Self::ffmpeg_mix(desktop_wav, mic_wav, mp3_path)?;
        } else if has_mic {
            Self::ffmpeg_convert(mic_wav, mp3_path)?;
        } else if has_desktop {
            Self::ffmpeg_convert(desktop_wav, mp3_path)?;
        } else {
            return Err("No audio captured".to_string());
        }

        let _ = std::fs::remove_file(desktop_wav);
        let _ = std::fs::remove_file(mic_wav);
        Self::verify_output(mp3_path)
    }

    // ==================== macOS: ffmpeg avfoundation ====================

    #[cfg(target_os = "macos")]
    fn record_macos(mp3_path: &Path, is_recording: &Arc<Mutex<bool>>) -> Result<(), String> {
        use std::process::{Command, Stdio};

        if !Self::cmd_exists("ffmpeg") {
            return Err("ffmpeg not available".to_string());
        }

        println!("macOS avfoundation recording starting...");

        // List available devices
        let devices_output = Command::new("ffmpeg")
            .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
            .unwrap_or_default();
        println!("Available devices:\n{}", devices_output);

        // Find screen capture device index (for system audio)
        // On macOS, system audio is captured via screen recording
        // Device ":0" = screen 0 (captures system audio when Screen Recording permission granted)
        // Device "0" = mic input 0

        let raw_wav = "/tmp/atok_macos_recording.wav";

        // Record screen (system audio) + mic simultaneously
        // -f avfoundation -i "0:0" captures mic (audio device 0) + screen (video device 0 with audio)
        // We use -i ":0" for screen audio and separate mic
        let mut proc = Command::new("ffmpeg")
            .args([
                "-y",
                "-f", "avfoundation",
                "-i", ":0",  // Screen capture with system audio
                "-vn",        // No video
                "-ac", "2",
                "-ar", "48000",
                "-f", "wav",
                raw_wav,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start macOS recording: {}", e))?;

        println!("Recording system audio via avfoundation...");

        while *is_recording.lock().unwrap() {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let _ = proc.kill();
        let _ = proc.wait();
        std::thread::sleep(std::time::Duration::from_millis(300));

        if Self::file_ok(raw_wav) {
            Self::ffmpeg_convert(raw_wav, mp3_path)?;
            let _ = std::fs::remove_file(raw_wav);
            Self::verify_output(mp3_path)
        } else {
            // Fallback: try mic only
            println!("System audio failed, trying mic only...");
            let mic_wav = "/tmp/atok_macos_mic.wav";
            let mut mic_proc = Command::new("ffmpeg")
                .args(["-y", "-f", "avfoundation", "-i", "0",
                    "-vn", "-ac", "2", "-ar", "48000", "-f", "wav", mic_wav])
                .stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|e| format!("Failed to start mic: {}", e))?;

            while *is_recording.lock().unwrap() {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = mic_proc.kill();
            let _ = mic_proc.wait();

            if Self::file_ok(mic_wav) {
                Self::ffmpeg_convert(mic_wav, mp3_path)?;
                let _ = std::fs::remove_file(mic_wav);
                Self::verify_output(mp3_path)
            } else {
                Err("No audio captured on macOS".to_string())
            }
        }
    }

    // ==================== Shared Helpers ====================

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn cmd_exists(cmd: &str) -> bool {
        std::process::Command::new("which").arg(cmd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
    }

    fn file_ok(path: &str) -> bool {
        std::fs::metadata(path).map(|m| m.len() > 4096).unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    fn find_monitor_source() -> Result<String, String> {
        use std::process::Command;
        let output = Command::new("pactl")
            .args(["list", "short", "sources"])
            .output().map_err(|e| format!("pactl failed: {}", e))?;
        let sources = String::from_utf8_lossy(&output.stdout);
        for line in sources.lines() {
            if line.contains(".monitor") {
                if let Some(name) = line.split_whitespace().nth(1) {
                    return Ok(name.to_string());
                }
            }
        }
        let output = Command::new("pactl")
            .args(["get-default-sink"])
            .output().map_err(|e| format!("pactl failed: {}", e))?;
        let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !sink.is_empty() { return Ok(format!("{}.monitor", sink)); }
        Err("No monitor source found".to_string())
    }

    #[cfg(target_os = "linux")]
    fn find_default_source() -> Result<String, String> {
        use std::process::Command;
        let output = Command::new("pactl")
            .args(["get-default-source"])
            .output().map_err(|e| format!("pactl failed: {}", e))?;
        let source = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if source.is_empty() { return Err("No mic source found".to_string()); }
        Ok(source)
    }

    #[cfg(target_os = "linux")]
    fn get_source_sample_rate(source: &str) -> u32 {
        use std::process::Command;
        if let Ok(output) = Command::new("pactl").args(["list", "short", "sources"]).output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if line.contains(source) {
                    for part in line.split_whitespace() {
                        if part.ends_with("Hz") {
                            if let Ok(rate) = part.trim_end_matches("Hz").parse::<u32>() {
                                return rate;
                            }
                        }
                    }
                }
            }
        }
        48000
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn ffmpeg_mix(input1: &str, input2: &str, output: &Path) -> Result<(), String> {
        use std::process::{Command, Stdio};
        let status = Command::new("ffmpeg")
            .args(["-y", "-i", input1, "-i", input2,
                "-filter_complex",
                "[0:a]volume=0.7[a0];[1:a]volume=1.3[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=2",
                "-ar", "48000", "-ac", "2", "-b:a", "192k",
                output.to_str().unwrap_or("output.mp3")])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map_err(|e| format!("ffmpeg not found: {}", e))?;
        if !status.success() { return Err("ffmpeg mix failed".to_string()); }
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn ffmpeg_convert(input: &str, output: &Path) -> Result<(), String> {
        use std::process::{Command, Stdio};
        let status = Command::new("ffmpeg")
            .args(["-y", "-i", input, "-ar", "48000", "-ac", "2", "-b:a", "192k",
                output.to_str().unwrap_or("output.mp3")])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map_err(|e| format!("ffmpeg not found: {}", e))?;
        if !status.success() { return Err("ffmpeg convert failed".to_string()); }
        Ok(())
    }

    // ==================== cpal Fallback (mic only) ====================

    fn record_with_cpal(mp3_path: &Path, is_recording: &Arc<Mutex<bool>>) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let mic = host.default_input_device()
            .ok_or_else(|| "No input device".to_string())?;

        let config = mic.default_input_config()
            .map_err(|e| format!("Config failed: {}", e))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as u32;
        println!("cpal: {}Hz, {}ch", sample_rate, channels);

        let mp3_file = Arc::new(Mutex::new(
            std::fs::File::create(mp3_path)
                .map_err(|e| format!("Create file failed: {}", e))?,
        ));

        let encoder = Self::build_encoder(sample_rate, channels)?;
        let encoder = Arc::new(Mutex::new(encoder));
        let buffer: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));

        let stream = {
            let buffer = Arc::clone(&buffer);
            let encoder = Arc::clone(&encoder);
            let mp3_file = Arc::clone(&mp3_file);

            mic.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    Self::encode_audio(data, &buffer, &encoder, &mp3_file, channels);
                },
                move |err| eprintln!("Stream error: {}", err),
                None,
            ).map_err(|e| format!("Stream failed: {}", e))?
        };

        stream.play().map_err(|e| format!("Play failed: {}", e))?;
        println!("Recording (mic only via cpal)...");

        while *is_recording.lock().unwrap() {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        drop(stream);
        Self::flush_encoder(&buffer, &encoder, &mp3_file)?;
        Self::finalize_encoder(&encoder, &mp3_file)?;
        Self::verify_output(mp3_path)
    }

    fn build_encoder(sample_rate: u32, channels: u32) -> Result<mp3lame_encoder::Encoder, String> {
        let mut b = mp3lame_encoder::Builder::new().ok_or("Encoder init failed")?;
        b.set_sample_rate(sample_rate).map_err(|e| format!("{:?}", e))?;
        b.set_num_channels(channels as u8).map_err(|e| format!("{:?}", e))?;
        b.set_quality(mp3lame_encoder::Quality::Best).map_err(|e| format!("{:?}", e))?;
        b.set_brate(mp3lame_encoder::Bitrate::Kbps192).map_err(|e| format!("{:?}", e))?;
        b.build().map_err(|e| format!("{:?}", e))
    }

    fn encode_audio(
        data: &[f32],
        buffer: &Arc<Mutex<Vec<i16>>>,
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
        channels: u32,
    ) {
        let mut buf = buffer.lock().unwrap();
        for &s in data {
            buf.push((s * 32767.0).clamp(-32768.0, 32767.0) as i16);
        }
        let chunk_size = 1152 * channels as usize;
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        while buf.len() >= chunk_size {
            let chunk: Vec<i16> = buf.drain(..chunk_size).collect();
            let input = mp3lame_encoder::InterleavedPcm(&chunk);
            if let Ok(mut enc) = encoder.lock() {
                if let Ok(w) = enc.encode(input, &mut mp3_buf) {
                    if w > 0 {
                        let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                        if let Ok(mut f) = mp3_file.lock() {
                            let _ = f.write_all(data);
                        }
                    }
                }
            }
        }
    }

    fn flush_encoder(
        buffer: &Arc<Mutex<Vec<i16>>>,
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
    ) -> Result<(), String> {
        let mut buf = buffer.lock().map_err(|e| e.to_string())?;
        if buf.is_empty() { return Ok(()); }
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        let input = mp3lame_encoder::InterleavedPcm(&buf);
        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
        if let Ok(w) = enc.encode(input, &mut mp3_buf) {
            if w > 0 {
                let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                f.write_all(data).map_err(|e| e.to_string())?;
            }
        }
        buf.clear();
        Ok(())
    }

    fn finalize_encoder(
        encoder: &Arc<Mutex<mp3lame_encoder::Encoder>>,
        mp3_file: &Arc<Mutex<std::fs::File>>,
    ) -> Result<(), String> {
        let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); 8192];
        let mut enc = encoder.lock().map_err(|e| e.to_string())?;
        if let Ok(w) = enc.flush::<mp3lame_encoder::FlushNoGap>(&mut mp3_buf) {
            if w > 0 {
                let data = unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, w) };
                let mut f = mp3_file.lock().map_err(|e| e.to_string())?;
                f.write_all(data).map_err(|e| e.to_string())?;
            }
        }
        let f = mp3_file.lock().map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| format!("Sync failed: {}", e))?;
        Ok(())
    }

    fn verify_output(path: &Path) -> Result<(), String> {
        if path.exists() {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            println!("Saved: {} ({} bytes)", path.display(), size);
            Ok(())
        } else {
            Err("Output file missing".into())
        }
    }
}
