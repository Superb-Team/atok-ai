// Windows WASAPI Mixed Audio Recording (Mic + Desktop) with MP3 Output
use std::sync::{Arc, Mutex};
use std::path::PathBuf;

#[cfg(windows)]
use windows::{
    core::*,
    Win32::Media::Audio::*,
    Win32::System::Com::*,
};

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

    #[cfg(windows)]
    pub fn start_recording(&self, output_path: PathBuf) -> Result<()> {
        let mut recording = self.is_recording.lock().unwrap();
        if *recording {
            return Err(Error::from_hresult(HRESULT(0x80070057_u32 as i32)));
        }
        *recording = true;
        drop(recording);

        let is_recording = Arc::clone(&self.is_recording);
        let thread_handle = std::thread::spawn(move || {
            if let Err(e) = Self::recording_thread_fn(output_path, is_recording) {
                eprintln!("❌ Recording error: {}", e);
            }
        });

        *self.recording_thread.lock().unwrap() = Some(thread_handle);
        Ok(())
    }

    #[cfg(windows)]
    fn recording_thread_fn(output_path: PathBuf, is_recording: Arc<Mutex<bool>>) -> Result<()> {
        use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm};
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

            let enumerator: IMMDeviceEnumerator = CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            )?;

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

            println!("🔊 Desktop: {}Hz, {} ch, {} bits", sample_rate, channels, desktop_bits);
            println!("🎤 Mic: {}Hz, {} ch, {} bits", mic_sample_rate, mic_channels, mic_bits);

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
            mic_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                0,
                10000000,
                0,
                mic_format,
                None,
            )?;

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
            
            mp3_encoder.set_sample_rate(sample_rate)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder.set_num_channels(channels as u8)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder.set_quality(mp3lame_encoder::Quality::Best)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            mp3_encoder.set_brate(mp3lame_encoder::Bitrate::Kbps192)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            let mut mp3_encoder = mp3_encoder.build()
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            // Ensure parent directory exists
            if let Some(parent) = mp3_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| {
                            eprintln!("❌ Failed to create directory: {}", e);
                            Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                        })?;
                    println!("✅ Created directory: {:?}", parent);
                }
            }

            let mut mp3_file = File::create(&mp3_path)
                .map_err(|e| {
                    eprintln!("❌ Failed to create MP3 file: {}", e);
                    eprintln!("❌ Path: {}", mp3_path.display());
                    Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                })?;

            println!("✅ MP3 file created successfully at: {}", mp3_path.display());

            let mut mp3_buffer = vec![MaybeUninit::uninit(); 8192];
            let chunk_size = 1152 * channels as usize;
            let mut sample_buffer: Vec<i16> = Vec::with_capacity(chunk_size);
            
            // Separate buffers for desktop and mic to handle async capture
            let mut desktop_buffer: Vec<i16> = Vec::new();
            let mut mic_buffer: Vec<i16> = Vec::new();
            
            let mut mic_sample_count = 0u64;
            let mut desktop_sample_count = 0u64;

            println!("🎬 Starting capture loop...");

            // Recording loop - encode to MP3 in real-time
            while *is_recording.lock().unwrap() {
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
                            if desktop_bits == 32 {
                                for chunk in audio_data.chunks_exact(4) {
                                    let float_val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                                    let int_val = (float_val * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                    desktop_buffer.push(int_val);
                                }
                            } else if desktop_bits == 16 {
                                for chunk in audio_data.chunks_exact(2) {
                                    let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                                    desktop_buffer.push(sample);
                                }
                            }
                        } else {
                            // Add silence
                            let sample_count = (frames as usize) * (channels as usize);
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
                            if mic_bits == 32 {
                                for chunk in audio_data.chunks_exact(4) {
                                    let float_val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                                    // Boost mic volume by 1.5x
                                    let mic_sample = (float_val * 32767.0 * 1.5).clamp(-32768.0, 32767.0) as i16;
                                    mic_buffer.push(mic_sample);
                                }
                            } else if mic_bits == 16 {
                                for chunk in audio_data.chunks_exact(2) {
                                    let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                                    // Boost mic volume by 1.5x
                                    let mic_sample = ((sample as i32 * 3) / 2).clamp(-32768, 32767) as i16;
                                    mic_buffer.push(mic_sample);
                                }
                            }
                        } else {
                            // Add silence
                            let sample_count = (frames as usize) * (mic_channels as usize);
                            mic_buffer.extend(std::iter::repeat(0i16).take(sample_count));
                        }
                        
                        mic_sample_count += frames as u64;
                    }

                    mic_capture.ReleaseBuffer(frames)?;
                }

                // Mix desktop and mic buffers
                let min_len = desktop_buffer.len().min(mic_buffer.len());
                if min_len > 0 {
                    for i in 0..min_len {
                        let desktop_sample = desktop_buffer[i] as i32;
                        let mic_sample = mic_buffer[i] as i32;
                        // Mix with proper gain: 70% desktop + 80% mic (allows mic to be more prominent)
                        let mixed = ((desktop_sample * 7 / 10) + (mic_sample * 8 / 10)).clamp(-32768, 32767) as i16;
                        sample_buffer.push(mixed);
                    }
                    
                    // Remove processed samples
                    desktop_buffer.drain(..min_len);
                    mic_buffer.drain(..min_len);
                }

                // Encode when we have enough samples
                while sample_buffer.len() >= chunk_size {
                    let chunk: Vec<i16> = sample_buffer.drain(..chunk_size).collect();
                    let input = InterleavedPcm(&chunk);
                    
                    let bytes_written = mp3_encoder.encode(input, &mut mp3_buffer)
                        .map_err(|e| {
                            eprintln!("❌ MP3 encode error: {:?}", e);
                            Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                        })?;
                    
                    if bytes_written > 0 {
                        let mp3_data = std::slice::from_raw_parts(
                            mp3_buffer.as_ptr() as *const u8,
                            bytes_written
                        );
                        mp3_file.write_all(mp3_data)
                            .map_err(|e| {
                                eprintln!("❌ MP3 write error: {}", e);
                                Error::from_hresult(HRESULT(0x80070002_u32 as i32))
                            })?;
                    }
                }
            }
            
            println!("📊 Captured - Desktop: {} samples, Mic: {} samples", desktop_sample_count, mic_sample_count);

            // Stop audio capture
            desktop_client.Stop()?;
            mic_client.Stop()?;

            println!("🎵 Finalizing MP3...");
            
            // Mix any remaining buffered samples
            let min_len = desktop_buffer.len().min(mic_buffer.len());
            if min_len > 0 {
                for i in 0..min_len {
                    let desktop_sample = desktop_buffer[i] as i32;
                    let mic_sample = mic_buffer[i] as i32;
                    let mixed = ((desktop_sample * 7 / 10) + (mic_sample * 8 / 10)).clamp(-32768, 32767) as i16;
                    sample_buffer.push(mixed);
                }
            }

            // Encode remaining samples
            if !sample_buffer.is_empty() {
                let input = InterleavedPcm(&sample_buffer);
                let bytes_written = mp3_encoder.encode(input, &mut mp3_buffer)
                    .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
                
                if bytes_written > 0 {
                    let mp3_data = std::slice::from_raw_parts(
                        mp3_buffer.as_ptr() as *const u8,
                        bytes_written
                    );
                    mp3_file.write_all(mp3_data)
                        .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
                }
            }

            // Flush MP3 encoder
            let bytes_written = mp3_encoder.flush::<FlushNoGap>(&mut mp3_buffer)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            
            if bytes_written > 0 {
                let mp3_data = std::slice::from_raw_parts(
                    mp3_buffer.as_ptr() as *const u8,
                    bytes_written
                );
                mp3_file.write_all(mp3_data)
                    .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;
            }

            // Ensure all data is written to disk
            mp3_file.sync_all()
                .map_err(|e| {
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

    #[cfg(not(windows))]
    pub fn start_recording(&self, _output_path: PathBuf) -> Result<()> {
        Err(Error::from_hresult(HRESULT(0x80004001)))
    }

    pub fn stop_recording(&self) -> Result<()> {
        println!("🛑 Stopping recording...");
        
        let mut recording = self.is_recording.lock().unwrap();
        *recording = false;
        drop(recording);

        let mut thread_lock = self.recording_thread.lock().unwrap();
        if let Some(handle) = thread_lock.take() {
            let _ = handle.join();
        }

        println!("✅ Recording stopped");
        Ok(())
    }

    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }
}
