// Windows WASAPI Loopback Audio Recording
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use hound::{WavWriter, WavSpec};

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
        unsafe {
            // Initialize COM for this thread
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            // S_OK = 0, S_FALSE = 1 (already initialized) - both are OK
            if hr.0 < 0 {
                return Err(Error::from_hresult(hr));
            }

            // Create device enumerator
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            )?;

            // Get default audio endpoint (speakers/headphones)
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;

            // Activate audio client
            let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

            // Get mix format
            let mix_format = audio_client.GetMixFormat()?;
            let format = &*mix_format;

            // Copy values to avoid packed struct alignment issues
            let sample_rate = format.nSamplesPerSec;
            let channels = format.nChannels;
            let bits_per_sample = format.wBitsPerSample;
            let block_align = format.nBlockAlign;

            println!("🔊 Audio Format: {}Hz, {} channels, {} bits", sample_rate, channels, bits_per_sample);

            // Initialize audio client in LOOPBACK mode
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                10000000, // 1 second buffer
                0,
                mix_format,
                None,
            )?;

            // Get capture client
            let capture_client: IAudioCaptureClient = audio_client.GetService()?;

            // Create WAV writer
            let spec = WavSpec {
                channels: channels,
                sample_rate: sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };

            let mut writer = WavWriter::create(&output_path, spec)
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            // Start audio client
            audio_client.Start()?;

            println!("✅ WASAPI Loopback recording started!");

            // Recording loop
            while *is_recording.lock().unwrap() {
                std::thread::sleep(std::time::Duration::from_millis(10));

                let packet_size = capture_client.GetNextPacketSize()?;

                if packet_size == 0 {
                    continue;
                }

                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames_available = 0u32;
                let mut flags = 0u32;

                capture_client.GetBuffer(
                    &mut data,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                )?;

                let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;

                if !is_silent && frames_available > 0 {
                    let bytes_per_frame = block_align as usize;
                    let data_len = (frames_available as usize) * bytes_per_frame;
                    let audio_data = std::slice::from_raw_parts(data, data_len);

                    // Convert and write samples
                    if bits_per_sample == 32 {
                        // Float32 to Int16 conversion
                        for chunk in audio_data.chunks_exact(4) {
                            let float_val = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let int_val = (float_val * 32767.0).clamp(-32768.0, 32767.0) as i16;
                            let _ = writer.write_sample(int_val);
                        }
                    } else if bits_per_sample == 16 {
                        // Direct Int16 write
                        for chunk in audio_data.chunks_exact(2) {
                            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                            let _ = writer.write_sample(sample);
                        }
                    }
                }

                capture_client.ReleaseBuffer(frames_available)?;
            }

            // Cleanup
            audio_client.Stop()?;
            writer.finalize()
                .map_err(|_| Error::from_hresult(HRESULT(0x80070002_u32 as i32)))?;

            println!("✅ Recording saved: {}", output_path.display());
            Ok(())
        }
    }

    #[cfg(not(windows))]
    pub fn start_recording(&self, _output_path: PathBuf) -> Result<()> {
        Err(Error::from_hresult(HRESULT(0x80004001))) // E_NOTIMPL
    }

    pub fn stop_recording(&self) -> Result<()> {
        println!("🛑 Stopping recording...");
        
        let mut recording = self.is_recording.lock().unwrap();
        *recording = false;
        drop(recording);

        // Wait for thread to finish
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
