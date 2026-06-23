// Windows WASAPI Mixed Audio Recording (Mic + Desktop) with MP3 Output
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::audio_aec::{AecConfig, AudioAec, AEC_FRAME_SAMPLES, AEC_SAMPLE_RATE};

#[cfg(windows)]
use windows::{core::*, Win32::Media::Audio::*, Win32::System::Com::*};

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

    // Device selection is not yet wired on Windows (WASAPI uses the default
    // capture endpoint); the parameter keeps the API in sync across platforms.
    #[cfg(windows)]
    pub fn start_recording_with_aec(
        &self,
        output_path: PathBuf,
        aec_enabled: bool,
        _mic_device: Option<String>,
    ) -> Result<(), String> {
        let mut recording = self.is_recording.lock().map_err(|e| e.to_string())?;
        if *recording {
            return Err("Already recording".to_string());
        }
        *recording = true;
        drop(recording);

        let is_recording = Arc::clone(&self.is_recording);
        let thread_handle = std::thread::spawn(move || {
            let flag = Arc::clone(&is_recording);
            if let Err(e) = Self::recording_thread_fn(output_path, is_recording, aec_enabled) {
                eprintln!("Recording error: {}", e);
            }
            // Always clear the flag when the capture thread exits so a mid-recording
            // failure can't wedge the recorder in a permanent "recording" state.
            if let Ok(mut rec) = flag.lock() {
                *rec = false;
            }
        });

        *self.recording_thread.lock().map_err(|e| e.to_string())? = Some(thread_handle);
        Ok(())
    }

    #[cfg(windows)]
    fn recording_thread_fn(
        output_path: PathBuf,
        is_recording: Arc<Mutex<bool>>,
        aec_enabled: bool,
    ) -> Result<()> {
        use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm, MonoPcm};
        use std::fs::File;
        use std::io::Write;
        use std::mem::MaybeUninit;

        unsafe {
            println!("🎙️ Starting MIC + DESKTOP recording...");

            // Initialize COM
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if hr.0 < 0 {
                return Err(Error::from_hresult(hr));
            }
            // Balance CoInitializeEx with CoUninitialize on every return path
            // (same RAII guard used by list_input_devices / check_device_status).
            let _com_guard = ComInitGuard { hr };

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

            // Get DESKTOP audio device (loopback)
            let desktop_device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let desktop_client: IAudioClient = desktop_device.Activate(CLSCTX_ALL, None)?;
            let desktop_format = desktop_client.GetMixFormat()?;

            // Get MICROPHONE device
            let mic_device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
            let mic_client: IAudioClient = mic_device.Activate(CLSCTX_ALL, None)?;
            let mic_format = mic_client.GetMixFormat()?;

            let desktop_fmt = &*desktop_format;
            let mic_fmt = &*mic_format;

            let sample_rate = desktop_fmt.nSamplesPerSec;
            let channels = desktop_fmt.nChannels;
            let desktop_bits = desktop_fmt.wBitsPerSample;
            let desktop_align = desktop_fmt.nBlockAlign;
            let mic_bits = mic_fmt.wBitsPerSample;
            let mic_align = mic_fmt.nBlockAlign;
            let mic_sample_rate = mic_fmt.nSamplesPerSec;
            let mic_channels = mic_fmt.nChannels;
            // Route Windows audio through the shared audio_dsp chain for parity with
            // Linux/macOS (HPF + noise gate + leveler + true-peak limiter). That chain
            // requires 48kHz stereo, so force both here. VERIFY-ON-WINDOWS.
            let output_channels = 2usize;
            let capture_channels = Self::normalized_channel_count(mic_channels as usize);
            let processing_sample_rate = AEC_SAMPLE_RATE;

            println!(
                "🔊 Desktop: {}Hz, {} ch, {} bits",
                sample_rate, channels, desktop_bits
            );
            println!(
                "🎤 Mic: {}Hz, {} ch, {} bits",
                mic_sample_rate, mic_channels, mic_bits
            );
            println!(
                "🎚️ Normalized mix: {}Hz, {}ch output, {}ch mic",
                processing_sample_rate, output_channels, capture_channels
            );
            if aec_enabled && sample_rate != AEC_SAMPLE_RATE {
                println!(
                    "🔁 AEC path resampling desktop {}Hz → {}Hz",
                    sample_rate, AEC_SAMPLE_RATE
                );
            }
            if aec_enabled && mic_sample_rate != AEC_SAMPLE_RATE {
                println!(
                    "🔁 AEC path resampling mic {}Hz → {}Hz",
                    mic_sample_rate, AEC_SAMPLE_RATE
                );
            }
            if !aec_enabled && mic_sample_rate != processing_sample_rate {
                println!(
                    "🔁 Mix path resampling mic {}Hz → {}Hz",
                    mic_sample_rate, processing_sample_rate
                );
            }
            // Initialize desktop audio (LOOPBACK)
            desktop_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                10000000,
                0,
                desktop_format,
                None,
            )?;

            // Initialize microphone
            mic_client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10000000, 0, mic_format, None)?;

            let desktop_capture: IAudioCaptureClient = desktop_client.GetService()?;
            let mic_capture: IAudioCaptureClient = mic_client.GetService()?;

            // Start both
            desktop_client.Start()?;
            mic_client.Start()?;

            println!("✅ Recording started!");

            // Setup MP3 encoder - ensure we use the exact path provided
            let mp3_path = if output_path.extension().and_then(|s| s.to_str()) == Some("mp3") {
                output_path.clone()
            } else {
                output_path.with_extension("mp3")
            };

            println!("📁 Output file: {}", mp3_path.display());
            println!("📁 Parent directory: {:?}", mp3_path.parent());

            let mut mp3_encoder = Builder::new()
                .ok_or_else(|| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            mp3_encoder
                .set_sample_rate(processing_sample_rate)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder
                .set_num_channels(output_channels as u8)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder
                .set_quality(mp3lame_encoder::Quality::Best)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder
                .set_brate(mp3lame_encoder::Bitrate::Kbps192)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            let mut mp3_encoder = mp3_encoder
                .build()
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            // Ensure parent directory exists
            if let Some(parent) = mp3_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        eprintln!("❌ Failed to create directory: {}", e);
                        Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                    })?;
                    println!("✅ Created directory: {:?}", parent);
                }
            }

            let mut mp3_file = File::create(&mp3_path).map_err(|e| {
                eprintln!("❌ Failed to create MP3 file: {}", e);
                eprintln!("❌ Path: {}", mp3_path.display());
                Error::from_hresult(HRESULT(0x80070002_u32 as i32))
            })?;

            println!(
                "✅ MP3 file created successfully at: {}",
                mp3_path.display()
            );

            let mut mp3_buffer = vec![MaybeUninit::uninit(); 8192];
            let chunk_size = 1152 * output_channels;
            let mut sample_buffer: Vec<i16> = Vec::with_capacity(chunk_size);

            // Separate buffers for desktop and mic to handle async capture
            let mut desktop_buffer: Vec<i16> = Vec::new();
            let mut mic_buffer: Vec<i16> = Vec::new();

            // AEC: persistent across the entire recording session
            let mut aec = AudioAec::new(AecConfig {
                enabled: aec_enabled,
                capture_channels: capture_channels as i32,
                render_channels: output_channels as i32,
                ..Default::default()
            });

            // Shared DSP chain, state persistent across the whole session.
            let mut dsp = crate::audio_dsp::AudioDsp::new(0.0);

            let mut mic_sample_count = 0u64;
            let mut desktop_sample_count = 0u64;

            println!("🎬 Starting capture loop...");

            // Recording loop - encode to MP3 in real-time
            loop {
                // Check if we should stop
                {
                    let should_stop = !*is_recording.lock().unwrap();
                    if should_stop {
                        println!("🛑 Stop signal received, exiting loop...");
                        break;
                    }
                }

                std::thread::sleep(std::time::Duration::from_millis(5));

                // Capture DESKTOP audio
                let desktop_packet = desktop_capture.GetNextPacketSize()?;
                if desktop_packet > 0 {
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;

                    desktop_capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;

                    if frames > 0 {
                        let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                        let bytes_len = (frames as usize) * (desktop_align as usize);
                        let audio_data = std::slice::from_raw_parts(data, bytes_len);

                        if !is_silent {
                            let decoded = Self::decode_wasapi_packet(audio_data, desktop_bits);
                            Self::append_normalized_channels(
                                &mut desktop_buffer,
                                &decoded,
                                channels as usize,
                                output_channels,
                                1.0,
                            );
                        } else {
                            let sample_count = (frames as usize) * output_channels;
                            desktop_buffer.extend(std::iter::repeat(0i16).take(sample_count));
                        }

                        desktop_sample_count += frames as u64;
                    }

                    desktop_capture.ReleaseBuffer(frames)?;
                }

                // Capture MICROPHONE audio
                let mic_packet = mic_capture.GetNextPacketSize()?;
                if mic_packet > 0 {
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;

                    mic_capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;

                    if frames > 0 {
                        let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                        let bytes_len = (frames as usize) * (mic_align as usize);
                        let audio_data = std::slice::from_raw_parts(data, bytes_len);

                        if !is_silent {
                            let decoded = Self::decode_wasapi_packet(audio_data, mic_bits);
                            Self::append_normalized_channels(
                                &mut mic_buffer,
                                &decoded,
                                mic_channels as usize,
                                capture_channels,
                                1.0,
                            );
                        } else {
                            let sample_count = (frames as usize) * capture_channels;
                            mic_buffer.extend(std::iter::repeat(0i16).take(sample_count));
                        }

                        mic_sample_count += frames as u64;
                    }

                    mic_capture.ReleaseBuffer(frames)?;
                }

                Self::process_windows_buffers(
                    &mut desktop_buffer,
                    &mut mic_buffer,
                    &mut sample_buffer,
                    output_channels,
                    capture_channels,
                    processing_sample_rate,
                    sample_rate,
                    mic_sample_rate,
                    &mut aec,
                    true,
                    &mut dsp,
                );

                // Encode when we have enough samples
                while sample_buffer.len() >= chunk_size {
                    let chunk: Vec<i16> = sample_buffer.drain(..chunk_size).collect();

                    let bytes_written = if output_channels == 1 {
                        mp3_encoder.encode(MonoPcm(&chunk), &mut mp3_buffer)
                    } else {
                        mp3_encoder.encode(InterleavedPcm(&chunk), &mut mp3_buffer)
                    }
                    .map_err(|e| {
                        eprintln!("❌ MP3 encode error: {:?}", e);
                        Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                    })?;

                    if bytes_written > 0 {
                        let mp3_data = std::slice::from_raw_parts(
                            mp3_buffer.as_ptr() as *const u8,
                            bytes_written,
                        );
                        mp3_file.write_all(mp3_data).map_err(|e| {
                            eprintln!("❌ MP3 write error: {}", e);
                            Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                        })?;
                    }
                }
            }

            println!(
                "📊 Captured - Desktop: {} samples, Mic: {} samples",
                desktop_sample_count, mic_sample_count
            );

            // Stop audio capture
            desktop_client.Stop()?;
            mic_client.Stop()?;

            println!("🎵 Finalizing MP3...");

            Self::process_windows_buffers(
                &mut desktop_buffer,
                &mut mic_buffer,
                &mut sample_buffer,
                output_channels,
                capture_channels,
                processing_sample_rate,
                sample_rate,
                mic_sample_rate,
                &mut aec,
                false,
                &mut dsp,
            );

            // Encode remaining samples
            if !sample_buffer.is_empty() {
                let bytes_written = if output_channels == 1 {
                    mp3_encoder.encode(MonoPcm(&sample_buffer), &mut mp3_buffer)
                } else {
                    mp3_encoder.encode(InterleavedPcm(&sample_buffer), &mut mp3_buffer)
                }
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

                if bytes_written > 0 {
                    let mp3_data =
                        std::slice::from_raw_parts(mp3_buffer.as_ptr() as *const u8, bytes_written);
                    mp3_file
                        .write_all(mp3_data)
                        .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
                }
            }

            // Flush MP3 encoder
            let bytes_written = mp3_encoder
                .flush::<FlushNoGap>(&mut mp3_buffer)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            if bytes_written > 0 {
                let mp3_data =
                    std::slice::from_raw_parts(mp3_buffer.as_ptr() as *const u8, bytes_written);
                mp3_file
                    .write_all(mp3_data)
                    .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            }

            // Ensure all data is written to disk
            mp3_file.sync_all().map_err(|e| {
                eprintln!("❌ Failed to sync file: {}", e);
                Error::from_hresult(HRESULT(0x80070002_u32 as i32))
            })?;

            drop(mp3_file);

            println!("✅ Recording saved: {}", mp3_path.display());

            // Verify file exists
            if mp3_path.exists() {
                let metadata = std::fs::metadata(&mp3_path)
                    .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
                println!("✅ File size: {} bytes", metadata.len());
            } else {
                eprintln!("❌ File does not exist after recording!");
            }

            Ok(())
        }
    }

    #[cfg(windows)]
    fn normalized_channel_count(channels: usize) -> usize {
        if channels <= 1 {
            1
        } else {
            2
        }
    }

    #[cfg(windows)]
    fn decode_wasapi_packet(audio_data: &[u8], bits_per_sample: u16) -> Vec<i16> {
        match bits_per_sample {
            32 => audio_data
                .chunks_exact(4)
                .map(|chunk| {
                    let float_val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    (float_val * 32767.0).clamp(-32768.0, 32767.0) as i16
                })
                .collect(),
            16 => audio_data
                .chunks_exact(2)
                .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                .collect(),
            _ => Vec::new(),
        }
    }

    #[cfg(windows)]
    fn append_normalized_channels(
        out: &mut Vec<i16>,
        input: &[i16],
        source_channels: usize,
        target_channels: usize,
        gain: f32,
    ) {
        let source_channels = source_channels.max(1);
        let target_channels = Self::normalized_channel_count(target_channels);

        for frame in input.chunks_exact(source_channels) {
            if target_channels == 1 {
                let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                let avg = sum as f32 / source_channels as f32;
                out.push(Self::scale_i16(avg, gain));
            } else {
                let left = frame[0] as f32;
                let right = if source_channels > 1 {
                    frame[1] as f32
                } else {
                    frame[0] as f32
                };
                out.push(Self::scale_i16(left, gain));
                out.push(Self::scale_i16(right, gain));
            }
        }
    }

    #[cfg(windows)]
    fn scale_i16(sample: f32, gain: f32) -> i16 {
        (sample * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    fn process_windows_buffers(
        desktop_buffer: &mut Vec<i16>,
        mic_buffer: &mut Vec<i16>,
        sample_buffer: &mut Vec<i16>,
        output_channels: usize,
        capture_channels: usize,
        processing_sample_rate: u32,
        desktop_sample_rate: u32,
        mic_sample_rate: u32,
        aec: &mut AudioAec,
        hold_partial_aec_frame: bool,
        dsp: &mut crate::audio_dsp::AudioDsp,
    ) {
        let desktop_native_frames = desktop_buffer.len() / output_channels;
        let mic_native_frames = mic_buffer.len() / capture_channels;
        let desktop_frames_at_processing_rate = Self::resampled_frame_capacity(
            desktop_native_frames,
            desktop_sample_rate,
            processing_sample_rate,
        );
        let mic_frames_at_processing_rate = Self::resampled_frame_capacity(
            mic_native_frames,
            mic_sample_rate,
            processing_sample_rate,
        );
        let mut frames_to_process =
            desktop_frames_at_processing_rate.min(mic_frames_at_processing_rate);

        if hold_partial_aec_frame && aec.is_enabled() {
            frames_to_process = (frames_to_process / AEC_FRAME_SAMPLES) * AEC_FRAME_SAMPLES;
        }

        if frames_to_process == 0 {
            return;
        }

        let desktop_native_frames_to_consume = Self::source_frames_for_output(
            frames_to_process,
            desktop_sample_rate,
            processing_sample_rate,
        );
        let mic_native_frames_to_consume = Self::source_frames_for_output(
            frames_to_process,
            mic_sample_rate,
            processing_sample_rate,
        );
        if desktop_native_frames_to_consume == 0
            || desktop_native_frames_to_consume > desktop_native_frames
            || mic_native_frames_to_consume == 0
            || mic_native_frames_to_consume > mic_native_frames
        {
            return;
        }

        let desktop_native_sample_count = desktop_native_frames_to_consume * output_channels;
        let mic_native_sample_count = mic_native_frames_to_consume * capture_channels;

        let desktop_native_segment = desktop_buffer[..desktop_native_sample_count].to_vec();
        let mic_native_segment = mic_buffer[..mic_native_sample_count].to_vec();
        let desktop_segment = if desktop_sample_rate == processing_sample_rate {
            desktop_native_segment
        } else {
            Self::resample_i16_exact(
                &desktop_native_segment,
                desktop_sample_rate,
                processing_sample_rate,
                output_channels,
                frames_to_process,
            )
        };
        let mut mic_segment = if mic_sample_rate == processing_sample_rate {
            mic_native_segment
        } else {
            Self::resample_i16_exact(
                &mic_native_segment,
                mic_sample_rate,
                processing_sample_rate,
                capture_channels,
                frames_to_process,
            )
        };

        if aec.is_enabled() {
            let sys_bytes = Self::i16_to_le_bytes(&desktop_segment);
            let mic_bytes = Self::i16_to_le_bytes(&mic_segment);
            let cleaned_mic = aec.process_chunk(&sys_bytes, &mic_bytes);
            mic_segment = Self::le_bytes_to_i16(&cleaned_mic);
        }

        // Mic must be stereo for the shared (stereo) DSP chain (output_channels == 2).
        let mic_stereo = if capture_channels == 1 {
            Self::mono_to_stereo_i16(&mic_segment)
        } else {
            mic_segment
        };
        let sys_bytes = Self::i16_to_le_bytes(&desktop_segment);
        let mic_bytes = Self::i16_to_le_bytes(&mic_stereo);
        let mixed = dsp.process(&sys_bytes, &mic_bytes);
        sample_buffer.extend_from_slice(&mixed);

        desktop_buffer.drain(..desktop_native_sample_count);
        mic_buffer.drain(..mic_native_sample_count);
    }

    #[cfg(windows)]
    fn mono_to_stereo_i16(mono: &[i16]) -> Vec<i16> {
        let mut out = Vec::with_capacity(mono.len() * 2);
        for &s in mono {
            out.push(s);
            out.push(s);
        }
        out
    }

    #[cfg(windows)]
    fn resampled_frame_capacity(source_frames: usize, source_rate: u32, output_rate: u32) -> usize {
        if source_rate == output_rate {
            return source_frames;
        }
        ((source_frames as u128 * output_rate as u128) / source_rate as u128) as usize
    }

    #[cfg(windows)]
    fn source_frames_for_output(output_frames: usize, source_rate: u32, output_rate: u32) -> usize {
        if source_rate == output_rate {
            return output_frames;
        }
        ((output_frames as u128 * source_rate as u128 + output_rate as u128 - 1)
            / output_rate as u128) as usize
    }

    #[cfg(windows)]
    fn resample_i16_exact(
        input: &[i16],
        from_sr: u32,
        to_sr: u32,
        channels: usize,
        target_frames: usize,
    ) -> Vec<i16> {
        let channels = channels.max(1);
        let input_frames = input.len() / channels;
        if target_frames == 0 {
            return Vec::new();
        }
        if input_frames == 0 {
            return vec![0; target_frames * channels];
        }
        if from_sr == to_sr {
            let target_samples = target_frames * channels;
            let mut out = input[..input.len().min(target_samples)].to_vec();
            out.resize(target_samples, 0);
            return out;
        }

        let ratio = from_sr as f64 / to_sr as f64;
        let mut out = Vec::with_capacity(target_frames * channels);
        for out_frame in 0..target_frames {
            let pos = out_frame as f64 * ratio;
            let idx = (pos.floor() as usize).min(input_frames - 1);
            let next_idx = (idx + 1).min(input_frames - 1);
            let frac = pos - idx as f64;

            for channel in 0..channels {
                let s0 = input[idx * channels + channel] as f64;
                let s1 = input[next_idx * channels + channel] as f64;
                let sample = s0 + (s1 - s0) * frac;
                out.push(sample.clamp(i16::MIN as f64, i16::MAX as f64) as i16);
            }
        }
        out
    }

    #[cfg(windows)]
    fn i16_to_le_bytes(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[cfg(windows)]
    fn le_bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
            .collect()
    }

    #[cfg(not(windows))]
    pub fn start_recording_with_aec(
        &self,
        _output_path: PathBuf,
        _aec_enabled: bool,
        _mic_device: Option<String>,
    ) -> Result<(), String> {
        Err("Recording only supported on Windows".to_string())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        println!("Stopping recording...");

        // Set flag to stop recording
        {
            let mut recording = self.is_recording.lock().map_err(|e| e.to_string())?;
            if !*recording {
                println!("Recording already stopped");
                return Ok(());
            }
            *recording = false;
        }

        // Give thread time to finish gracefully
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Try to join thread with timeout
        let mut thread_lock = self.recording_thread.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = thread_lock.take() {
            // Spawn a timeout thread to avoid blocking forever
            let join_handle = std::thread::spawn(move || handle.join());

            // Wait max 2 seconds for thread to finish
            for _ in 0..20 {
                if join_handle.is_finished() {
                    let _ = join_handle.join();
                    println!("Recording stopped gracefully");
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            println!("Recording thread took too long, continuing anyway");
        }

        println!("Recording stopped");
        Ok(())
    }

    // ==================== Device enumeration (Windows WASAPI) ====================

    #[cfg(windows)]
    pub fn list_input_devices(&self) -> Result<Vec<crate::AudioDeviceInfo>, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let _com_guard = ComInitGuard { hr };

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("MMDeviceEnumerator create failed: {}", e))?;

            let collection: IMMDeviceCollection = enumerator
                .EnumAudioEndpoints(
                    eCapture,
                    windows::Win32::Media::Audio::DEVICE_STATE_ACTIVE.0 as u32,
                )
                .map_err(|e| format!("EnumAudioEndpoints failed: {}", e))?;

            let count = collection
                .GetCount()
                .map_err(|e| format!("GetCount failed: {}", e))?;

            // Get default device name
            let default_name = {
                match enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
                    Ok(device) => Self::get_device_friendly_name(&device).unwrap_or_default(),
                    Err(_) => String::new(),
                }
            };

            let mut devices: Vec<crate::AudioDeviceInfo> = Vec::with_capacity(count as usize);
            for i in 0..count {
                if let Ok(device) = collection.Item(i) {
                    if let Ok(name) = Self::get_device_friendly_name(&device) {
                        let is_default = name == default_name;
                        devices.push(crate::AudioDeviceInfo {
                            raw_name: name.clone(),
                            display_name: name,
                            device_type: "mic".to_string(),
                            is_default,
                        });
                    }
                }
            }

            devices.sort_by(|a, b| {
                b.is_default
                    .cmp(&a.is_default) // default device first
                    .then_with(|| a.display_name.cmp(&b.display_name))
            });

            Ok(devices)
        }
    }

    #[cfg(windows)]
    fn get_device_friendly_name(device: &IMMDevice) -> Result<String, String> {
        use windows::Win32::Media::Audio::Endpoints::IPropertyStore;
        use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;

        unsafe {
            let store: IPropertyStore = device
                .OpenPropertyStore(STGM_READ)
                .map_err(|e| format!("OpenPropertyStore failed: {}", e))?;

            let pkey = windows::Win32::System::Com::StructuredStorage::PROPVARIANT {
                vt: windows::Win32::System::Com::VARENUM(31), // VT_LPWSTR
                ..std::mem::zeroed()
            };

            // Use PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
            let key = windows::Win32::System::Com::StructuredStorage::PROPERTYKEY {
                fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
                pid: 14,
            };

            let mut variant = store
                .GetValue(&key)
                .map_err(|e| format!("GetValue failed: {}", e))?;

            let name_ptr = PropVariantToStringAlloc(&variant)
                .map_err(|e| format!("PropVariantToStringAlloc failed: {}", e))?;

            // PropVariantToStringAlloc allocates via CoTaskMemAlloc, so it must be
            // released with CoTaskMemFree — NOT SysFreeString (the BSTR allocator),
            // which mismatches the allocator and corrupts the heap. Also clear the
            // PROPVARIANT from GetValue so its contents aren't leaked each call.
            let name = name_ptr.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(
                name_ptr.0 as *const core::ffi::c_void,
            ));
            let _ = windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut variant);
            Ok(name)
        }
    }

    #[cfg(windows)]
    pub fn check_device_status(&self) -> Result<crate::DeviceStatus, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let _com_guard = ComInitGuard { hr };

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("MMDeviceEnumerator create failed: {}", e))?;

            // Mic detection
            let (mic_available, mic_name) =
                match enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
                    Ok(device) => {
                        let name = Self::get_device_friendly_name(&device).ok();
                        (true, name)
                    }
                    Err(_) => (false, None),
                };

            // System audio detection (loopback via eRender)
            let (sys_available, sys_name) =
                match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                    Ok(device) => {
                        let name = Self::get_device_friendly_name(&device).ok();
                        (true, name)
                    }
                    Err(_) => (false, None),
                };

            Ok(crate::DeviceStatus {
                mic_available,
                mic_display_name: mic_name.clone(),
                mic_name,
                system_audio_available: sys_available,
                system_audio_display_name: sys_name.clone(),
                system_audio_name: sys_name,
            })
        }
    }
}

#[cfg(windows)]
struct ComInitGuard {
    hr: windows::core::HRESULT,
}

#[cfg(windows)]
impl Drop for ComInitGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
