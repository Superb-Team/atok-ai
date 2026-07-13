use std::io::Write;
use std::path::{Path, PathBuf};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const SUPPORTED_EXTENSIONS: [&str; 5] = ["mp3", "wav", "m4a", "flac", "aac"];

/// Transcodes a picked audio file to MP3 (mp3 sources are just copied) so it can flow through the existing `transcribe_audio` pipeline unchanged.
#[tauri::command]
pub async fn import_audio_file(source_path: String, output_path: String) -> Result<(), String> {
    let source = PathBuf::from(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "File has no extension".to_string())?;

    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported audio format '.{}'. Supported: {}",
            ext,
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }

    if ext == "mp3" {
        std::fs::copy(&source, &output_path).map_err(|e| format!("Failed to copy MP3: {}", e))?;
        return Ok(());
    }

    let output = PathBuf::from(output_path);
    tokio::task::spawn_blocking(move || {
        let (samples, sample_rate, channels) = decode_to_pcm(&source)?;
        encode_pcm_to_mp3(&samples, sample_rate, channels, &output)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))?
}

fn decode_to_pcm(path: &Path) -> Result<(Vec<i16>, u32, u16), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open '{}': {}", path.display(), e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Unrecognized audio format: {}", e))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found in file")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {}", e))?;

    let mut samples: Vec<i16> = Vec::new();
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut sample_buf: Option<SampleBuffer<i16>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break,
            Err(e) => return Err(format!("Demux error: {}", e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Decode error: {}", e)),
        };
        if sample_buf.is_none() {
            let spec = *decoded.spec();
            sample_rate = spec.rate;
            channels = spec.channels.count() as u16;
            sample_buf = Some(SampleBuffer::<i16>::new(decoded.capacity() as u64, spec));
        }
        if let Some(buf) = sample_buf.as_mut() {
            buf.copy_interleaved_ref(decoded);
            samples.extend_from_slice(buf.samples());
        }
    }

    if samples.is_empty() {
        return Err("No audio samples decoded from file".to_string());
    }

    Ok(downmix_to_stereo_max(samples, sample_rate, channels))
}

/// LAME only encodes mono/stereo; anything wider collapses to a mono average duplicated across both channels.
fn downmix_to_stereo_max(
    samples: Vec<i16>,
    sample_rate: u32,
    channels: u16,
) -> (Vec<i16>, u32, u16) {
    if channels <= 2 {
        return (samples, sample_rate, channels);
    }
    let ch = channels as usize;
    let mut mixed = Vec::with_capacity(samples.len() / ch * 2);
    for frame in samples.chunks_exact(ch) {
        let avg = (frame.iter().map(|&s| s as i32).sum::<i32>() / ch as i32) as i16;
        mixed.push(avg);
        mixed.push(avg);
    }
    (mixed, sample_rate, 2)
}

/// Standalone LAME CBR-192kbps encode, mirroring `DesktopAudioRecorder::encode_i16_to_mp3`'s settings.
fn encode_pcm_to_mp3(
    samples: &[i16],
    sample_rate: u32,
    channels: u16,
    output: &Path,
) -> Result<(), String> {
    use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm, MonoPcm};

    let channel_count = channels as usize;
    let aligned_len = samples.len() - (samples.len() % channel_count);
    if aligned_len == 0 {
        return Err("No aligned PCM samples to encode".into());
    }
    let samples = &samples[..aligned_len];

    let mut builder = Builder::new().ok_or("MP3 encoder init failed")?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|e| format!("{:?}", e))?;
    builder
        .set_num_channels(channels as u8)
        .map_err(|e| format!("{:?}", e))?;
    builder
        .set_brate(mp3lame_encoder::Bitrate::Kbps192)
        .map_err(|e| format!("{:?}", e))?;

    let mut encoder = builder.build().map_err(|e| format!("{:?}", e))?;
    let mp3_file =
        std::fs::File::create(output).map_err(|e| format!("Failed to create MP3 file: {}", e))?;
    let mut mp3_file = std::io::BufWriter::new(mp3_file);

    let chunk_size = 1152 * channel_count;
    let mut mp3_buf = vec![std::mem::MaybeUninit::uninit(); chunk_size * 5 / 4 + 7200];

    for chunk in samples.chunks(chunk_size) {
        let encoded = if channels == 1 {
            encoder.encode(MonoPcm(chunk), &mut mp3_buf)
        } else {
            encoder.encode(InterleavedPcm(chunk), &mut mp3_buf)
        };

        match encoded {
            Ok(written) if written > 0 => {
                let data =
                    unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, written) };
                mp3_file
                    .write_all(data)
                    .map_err(|e| format!("MP3 write error: {}", e))?;
            }
            Err(e) => return Err(format!("MP3 encode error: {:?}", e)),
            _ => {}
        }
    }

    match encoder.flush::<FlushNoGap>(&mut mp3_buf) {
        Ok(written) if written > 0 => {
            let data =
                unsafe { std::slice::from_raw_parts(mp3_buf.as_ptr() as *const u8, written) };
            mp3_file
                .write_all(data)
                .map_err(|e| format!("MP3 flush error: {}", e))?;
        }
        Err(e) => return Err(format!("MP3 flush error: {:?}", e)),
        _ => {}
    }

    mp3_file
        .flush()
        .map_err(|e| format!("Flush failed: {}", e))?;
    mp3_file
        .get_ref()
        .sync_all()
        .map_err(|e| format!("Sync failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str, ext: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("atok-ai-import-{}-{}.{}", name, nanos, ext))
    }

    fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, num_frames: usize) {
        let samples: Vec<i16> = (0..num_frames * channels as usize)
            .map(|i| ((i as f32 * 0.05).sin() * 10_000.0) as i16)
            .collect();
        let data_len = (samples.len() * 2) as u32;
        let byte_rate = sample_rate * channels as u32 * 2;
        let block_align = channels * 2;

        let mut buf = Vec::with_capacity(44 + data_len as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_len).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for s in &samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn decodes_mono_wav_to_pcm() {
        let path = temp_path("mono", "wav");
        write_test_wav(&path, 16_000, 1, 8_000);

        let (samples, rate, channels) = decode_to_pcm(&path).unwrap();

        assert_eq!(rate, 16_000);
        assert_eq!(channels, 1);
        assert_eq!(samples.len(), 8_000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn decodes_stereo_wav_to_pcm() {
        let path = temp_path("stereo", "wav");
        write_test_wav(&path, 44_100, 2, 4_000);

        let (samples, rate, channels) = decode_to_pcm(&path).unwrap();

        assert_eq!(rate, 44_100);
        assert_eq!(channels, 2);
        assert_eq!(samples.len(), 8_000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn downmixes_multichannel_to_stereo() {
        let samples = vec![100i16, 200, 300, 400, 500, 600]; // 1 frame, 6 channels
        let (mixed, rate, channels) = downmix_to_stereo_max(samples, 48_000, 6);

        assert_eq!(rate, 48_000);
        assert_eq!(channels, 2);
        assert_eq!(mixed, vec![350, 350]);
    }

    #[test]
    fn wav_import_roundtrips_to_valid_mp3() {
        let wav_path = temp_path("roundtrip", "wav");
        let mp3_path = temp_path("roundtrip", "mp3");
        write_test_wav(&wav_path, 44_100, 1, 44_100);

        let (samples, rate, channels) = decode_to_pcm(&wav_path).unwrap();
        let result = encode_pcm_to_mp3(&samples, rate, channels, &mp3_path);

        assert!(result.is_ok(), "{result:?}");
        let data = std::fs::read(&mp3_path).unwrap();
        assert!(data.len() > 100);
        let sync = data
            .windows(2)
            .any(|w| w[0] == 0xFF && (w[1] & 0xE0) == 0xE0);
        assert!(sync, "no valid MPEG frame sync found in output");

        let _ = std::fs::remove_file(wav_path);
        let _ = std::fs::remove_file(mp3_path);
    }

    #[tokio::test]
    async fn rejects_unsupported_extension_before_touching_io() {
        // No file at this path ever needs to exist — the extension check must short-circuit.
        let result = import_audio_file(
            "/nonexistent/voice-note.3gp".to_string(),
            "/nonexistent/out.mp3".to_string(),
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported audio format"));
    }

    #[tokio::test]
    async fn mp3_source_is_copied_without_reencoding() {
        let src = temp_path("copy-src", "mp3");
        let dst = temp_path("copy-dst", "mp3");
        std::fs::write(&src, b"fake mp3 bytes").unwrap();

        let result = import_audio_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
        )
        .await;

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(std::fs::read(&dst).unwrap(), b"fake mp3 bytes");
        let _ = std::fs::remove_file(src);
        let _ = std::fs::remove_file(dst);
    }
}
