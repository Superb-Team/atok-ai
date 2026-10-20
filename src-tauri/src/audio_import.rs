use std::fs::{File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use mp3lame_encoder::{Builder, Encoder, FlushNoGap, InterleavedPcm, MonoPcm};
use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_MP3, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const SUPPORTED_EXTENSIONS: [&str; 5] = ["mp3", "wav", "m4a", "flac", "aac"];

#[tauri::command]
pub async fn import_audio_file(source_path: String, output_path: String) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let ext = supported_extension(&source)?;
    let output = PathBuf::from(output_path);
    tokio::task::spawn_blocking(move || import_audio(&source, &output, ext == "mp3"))
        .await
        .map_err(|e| format!("Import task failed: {}", e))?
}

fn supported_extension(source: &Path) -> Result<String, String> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("File has no extension")?;
    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported audio format '.{}'. Supported: {}",
            ext,
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }
    Ok(ext)
}

#[tauri::command]
pub async fn resume_audio_import(source_path: String, output_path: String) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let output = PathBuf::from(output_path);
    tokio::task::spawn_blocking(move || resume_import(&source, &output))
        .await
        .map_err(|e| format!("Import resume task failed: {}", e))?
}

fn resume_import(source: &Path, output: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(output) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let extension = supported_extension(source)?;
            import_audio(source, output, extension == "mp3")
        }
        Err(e) => Err(format!("Cannot inspect imported output: {}", e)),
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err("Imported output must be a regular file, not a symlink".into());
            }
            let output_canonical = std::fs::canonicalize(output).map_err(|e| e.to_string())?;
            if std::fs::canonicalize(source).is_ok_and(|path| path == output_canonical) {
                return Err("Imported output must not be the source file".into());
            }
            #[cfg(unix)]
            if let Ok(source_metadata) = std::fs::metadata(source) {
                use std::os::unix::fs::MetadataExt;
                if source_metadata.dev() == metadata.dev()
                    && source_metadata.ino() == metadata.ino()
                {
                    return Err("Imported output must not alias the source file".into());
                }
            }
            decode_audio(
                File::open(output).map_err(|e| format!("Cannot open imported output: {}", e))?,
                output,
                true,
                |_, _| Ok(()),
            )
        }
    }
}

struct TemporaryOutput(PathBuf);

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn import_audio(source: &Path, output: &Path, copy_mp3: bool) -> Result<(), String> {
    let source_file = File::open(source).map_err(|e| format!("Failed to open audio: {}", e))?;
    if !source_file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Audio source must be a regular file".into());
    }
    match std::fs::symlink_metadata(output) {
        Ok(_) => return Err("Output already exists; refusing to overwrite it".into()),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot inspect output: {}", e)),
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let staging_path = parent.join(format!(".atok-import-{}.tmp", uuid::Uuid::new_v4()));
    let staging_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging_path)
        .map_err(|e| format!("Failed to create temporary audio: {}", e))?;
    let staging = TemporaryOutput(staging_path);
    if copy_mp3 {
        let mut source_file = source_file;
        let mut staging_file = staging_file;
        std::io::copy(&mut source_file, &mut staging_file)
            .map_err(|e| format!("MP3 copy failed: {}", e))?;
        staging_file
            .sync_all()
            .map_err(|e| format!("Audio sync failed: {}", e))?;
        drop(staging_file);
        decode_audio(
            File::open(&staging.0).map_err(|e| e.to_string())?,
            source,
            true,
            |_, _| Ok(()),
        )?;
    } else {
        let mut writer = BufWriter::new(staging_file);
        let mut encoder: Option<Encoder> = None;
        let mut mp3 = Vec::with_capacity(1152 * 2 * 5 / 4 + 7200);
        decode_audio(source_file, source, false, |samples, spec| {
            let channels = spec.channels.count().min(2);
            if encoder.is_none() {
                let mut builder = Builder::new().ok_or("MP3 encoder init failed")?;
                builder
                    .set_sample_rate(spec.rate)
                    .map_err(|e| format!("MP3 sample rate: {:?}", e))?;
                builder
                    .set_num_channels(channels as u8)
                    .map_err(|e| format!("MP3 channels: {:?}", e))?;
                builder
                    .set_brate(mp3lame_encoder::Bitrate::Kbps192)
                    .map_err(|e| format!("MP3 bitrate: {:?}", e))?;
                encoder = Some(
                    builder
                        .build()
                        .map_err(|e| format!("MP3 encoder: {:?}", e))?,
                );
            }
            let mixed;
            let samples = if spec.channels.count() > 2 {
                mixed = downmix(samples, spec.channels.count());
                mixed.as_slice()
            } else {
                samples
            };
            for chunk in samples.chunks(1152 * channels) {
                mp3.clear();
                let encoder = encoder.as_mut().ok_or("MP3 encoder missing")?;
                let result = if channels == 1 {
                    encoder.encode_to_vec(MonoPcm(chunk), &mut mp3)
                } else {
                    encoder.encode_to_vec(InterleavedPcm(chunk), &mut mp3)
                };
                result.map_err(|e| format!("MP3 encode error: {:?}", e))?;
                writer
                    .write_all(&mp3)
                    .map_err(|e| format!("MP3 write error: {}", e))?;
            }
            Ok(())
        })?;
        mp3.clear();
        encoder
            .as_mut()
            .ok_or("No audio to encode")?
            .flush_to_vec::<FlushNoGap>(&mut mp3)
            .map_err(|e| format!("MP3 flush error: {:?}", e))?;
        writer.write_all(&mp3).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        writer.get_ref().sync_all().map_err(|e| e.to_string())?;
        drop(writer);
    }
    // Creating the final name is atomic and cannot replace an existing file, even during concurrent imports.
    std::fs::hard_link(&staging.0, output)
        .map_err(|e| format!("Failed to publish imported audio: {}", e))?;
    Ok(())
}

// Disable bitrate-based duration estimates during MP3 validation: VBR estimates
// can exceed the real duration. Xing/VBRI declared durations remain available.
struct Mp3ValidationSource(File);

impl Read for Mp3ValidationSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Seek for Mp3ValidationSource {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(position)
    }
}

impl MediaSource for Mp3ValidationSource {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        self.0.metadata().ok().map(|metadata| metadata.len())
    }
}

fn decode_audio(
    file: File,
    path: &Path,
    require_mp3: bool,
    mut consume: impl FnMut(&[i16], SignalSpec) -> Result<(), String>,
) -> Result<(), String> {
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let source: Box<dyn MediaSource> = if require_mp3 {
        Box::new(Mp3ValidationSource(file))
    } else {
        Box::new(file)
    };
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            MediaSourceStream::new(source, Default::default()),
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
    if require_mp3 && track.codec_params.codec != CODEC_TYPE_MP3 {
        return Err("File is not MP3 audio despite its extension".into());
    }
    if track
        .codec_params
        .sample_rate
        .is_some_and(|rate| rate == 0 || rate > 384_000)
        || track
            .codec_params
            .channels
            .is_some_and(|channels| channels.count() == 0 || channels.count() > 32)
        || track
            .codec_params
            .max_frames_per_packet
            .is_some_and(|frames| frames > 1_048_576)
        || track
            .codec_params
            .frames_per_block
            .is_some_and(|frames| frames > 1_048_576)
    {
        return Err("Audio format exceeds supported decoding limits".into());
    }
    let track_id = track.id;
    let expected_end = track
        .codec_params
        .n_frames
        .map(|n| n.saturating_add(track.codec_params.start_ts));
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions { verify: true })
        .map_err(|e| format!("Unsupported codec: {}", e))?;
    let mut stream_spec = None;
    let mut end = 0;
    let mut sample_count = 0u64;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("Audio demux error: {}", e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        if packet.buf().len() > 16 * 1024 * 1024 {
            return Err("Audio packet exceeds supported decoding limits".into());
        }
        end = packet.ts().saturating_add(packet.dur());
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("Audio decode error: {}", e))?;
        let spec = *decoded.spec();
        if spec.rate == 0
            || spec.rate > 384_000
            || spec.channels.count() == 0
            || spec.channels.count() > 32
            || decoded.capacity() > 1_048_576
        {
            return Err("Invalid audio sample rate or channel count".into());
        }
        if stream_spec.is_some_and(|previous| previous != spec) {
            return Err("Audio format changes within the file are not supported".into());
        }
        stream_spec = Some(spec);
        let mut buffer = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        sample_count += buffer.samples().len() as u64;
        consume(buffer.samples(), spec)?;
    }
    if sample_count == 0 {
        return Err("No audio samples decoded from file".into());
    }
    if expected_end.is_some_and(|expected| end < expected) {
        return Err("Audio file is truncated: ended before its declared duration".into());
    }
    if decoder.finalize().verify_ok == Some(false) {
        return Err("Audio integrity verification failed".into());
    }
    Ok(())
}

fn downmix(samples: &[i16], channels: usize) -> Vec<i16> {
    samples
        .chunks_exact(channels)
        .flat_map(|frame| {
            let average =
                (frame.iter().map(|&s| i64::from(s)).sum::<i64>() / channels as i64) as i16;
            [average, average]
        })
        .collect()
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

    fn decoded_samples(path: &Path) -> (Vec<i16>, u32, usize) {
        let mut samples = Vec::new();
        let mut rate = 0;
        let mut channels = 0;
        decode_audio(File::open(path).unwrap(), path, false, |chunk, spec| {
            samples.extend_from_slice(chunk);
            rate = spec.rate;
            channels = spec.channels.count();
            Ok(())
        })
        .unwrap();
        (samples, rate, channels)
    }

    #[test]
    fn decodes_mono_and_stereo_wav_packet_by_packet() {
        for (rate, channels) in [(16_000, 1), (44_100, 2)] {
            let path = temp_path("pcm", "wav");
            write_test_wav(&path, rate, channels, 8000);
            let (samples, decoded_rate, decoded_channels) = decoded_samples(&path);
            assert_eq!(decoded_rate, rate);
            assert_eq!(decoded_channels, channels as usize);
            assert_eq!(samples.len(), 8000 * channels as usize);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn downmixes_multichannel_to_stereo() {
        assert_eq!(downmix(&[100, 200, 300, 400, 500, 600], 6), [350, 350]);
    }

    #[test]
    fn wav_import_roundtrips_to_decodable_mp3_and_preserves_source() {
        let source = temp_path("roundtrip", "wav");
        let output = temp_path("roundtrip", "mp3");
        write_test_wav(&source, 44100, 1, 44100);
        let original = std::fs::read(&source).unwrap();
        import_audio(&source, &output, false).unwrap();
        let (samples, rate, channels) = decoded_samples(&output);
        assert_eq!((rate, channels), (44100, 1));
        assert!(samples.len() >= 44100);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(output).unwrap();
    }

    #[tokio::test]
    async fn rejects_unsupported_extension_before_touching_io() {
        let result = import_audio_file(
            "/nonexistent/voice-note.3gp".into(),
            "/nonexistent/out.mp3".into(),
        )
        .await;
        assert!(result.unwrap_err().contains("Unsupported audio format"));
    }

    #[test]
    fn validates_mp3_then_copies_without_reencoding() {
        let wav = temp_path("copy", "wav");
        let source = temp_path("copy-source", "mp3");
        let output = temp_path("copy-output", "mp3");
        write_test_wav(&wav, 44100, 2, 44100);
        import_audio(&wav, &source, false).unwrap();
        import_audio(&source, &output, true).unwrap();
        assert_eq!(
            std::fs::read(&source).unwrap(),
            std::fs::read(&output).unwrap()
        );
        for path in [wav, source, output] {
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn invalid_or_mislabeled_mp3_is_rejected_without_output() {
        let source = temp_path("invalid", "mp3");
        let output = temp_path("invalid-output", "mp3");
        std::fs::write(&source, b"fake mp3 bytes").unwrap();
        assert!(import_audio(&source, &output, true).is_err());
        assert!(!output.exists());
        write_test_wav(&source, 44100, 1, 8000);
        assert!(import_audio(&source, &output, true)
            .unwrap_err()
            .contains("not MP3"));
        assert!(!output.exists());
        std::fs::remove_file(source).unwrap();
    }

    #[test]
    fn refuses_overwrite_and_source_as_output() {
        let source = temp_path("overwrite", "wav");
        let output = temp_path("existing", "mp3");
        write_test_wav(&source, 44100, 1, 8000);
        let original = std::fs::read(&source).unwrap();
        std::fs::write(&output, b"keep me").unwrap();
        assert!(import_audio(&source, &output, false).is_err());
        assert!(import_audio(&source, &source, false).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"keep me");
        assert_eq!(std::fs::read(&source).unwrap(), original);
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(output).unwrap();
    }

    #[test]
    fn missing_source_has_no_output() {
        let source = temp_path("missing", "wav");
        let output = temp_path("missing-output", "mp3");
        assert!(import_audio(&source, &output, false).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn truncated_wav_rejects_partial_audio_and_cleans_temporary_file() {
        let directory = temp_path("transaction", "dir");
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("truncated.wav");
        let output = directory.join("output.mp3");
        write_test_wav(&source, 44100, 1, 44100);
        OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(10000)
            .unwrap();
        let result = import_audio(&source, &output, false);
        assert!(result.unwrap_err().contains("truncated"));
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn streams_pcm_in_bounded_packets() {
        let source = temp_path("streaming", "wav");
        write_test_wav(&source, 48000, 2, 48000 * 10);
        let mut total = 0;
        let mut largest = 0;
        decode_audio(
            File::open(&source).unwrap(),
            &source,
            false,
            |samples, _| {
                total += samples.len();
                largest = largest.max(samples.len());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(total, 48000 * 10 * 2);
        assert!(largest <= 8192, "packet buffered {} samples", largest);
        std::fs::remove_file(source).unwrap();
    }

    #[test]
    fn concurrent_imports_cannot_replace_each_other() {
        let source = temp_path("concurrent", "wav");
        let output = temp_path("concurrent-output", "mp3");
        write_test_wav(&source, 44100, 1, 44100);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let source = source.clone();
                let output = output.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    import_audio(&source, &output, false)
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successes, 1);
        decode_audio(File::open(&output).unwrap(), &output, true, |_, _| Ok(())).unwrap();
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(output).unwrap();
    }

    #[test]
    fn rejects_excessive_sample_rate_without_output() {
        let source = temp_path("limits", "wav");
        let output = temp_path("limits-output", "mp3");
        write_test_wav(&source, 500000, 1, 5000);
        assert!(import_audio(&source, &output, false)
            .unwrap_err()
            .contains("limits"));
        assert!(!output.exists());
        std::fs::remove_file(source).unwrap();
    }
    #[test]
    fn resumes_completed_conversion_when_original_source_is_gone() {
        let source = temp_path("resume", "wav");
        let output = temp_path("resume-output", "mp3");
        write_test_wav(&source, 44100, 1, 44100);
        resume_import(&source, &output).unwrap();
        let original_output = std::fs::read(&output).unwrap();
        std::fs::remove_file(source.clone()).unwrap();
        resume_import(&source, &output).unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), original_output);
        std::fs::remove_file(output).unwrap();
    }

    #[test]
    fn resume_rejects_bad_existing_output_without_overwriting() {
        let source = temp_path("resume-bad", "wav");
        let output = temp_path("resume-bad-output", "mp3");
        write_test_wav(&source, 44100, 1, 8000);
        std::fs::write(&output, b"preserve invalid output").unwrap();
        assert!(resume_import(&source, &output).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"preserve invalid output");
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(output).unwrap();
    }

    #[test]
    fn resume_rejects_source_as_output() {
        let source = temp_path("resume-same", "mp3");
        std::fs::write(&source, b"preserve source").unwrap();
        assert!(resume_import(&source, &source)
            .unwrap_err()
            .contains("source file"));
        assert_eq!(std::fs::read(&source).unwrap(), b"preserve source");
        std::fs::remove_file(source).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resume_rejects_symlink_output_and_hardlink_to_source() {
        let source = temp_path("resume-link-source", "mp3");
        let output = temp_path("resume-link-output", "mp3");
        std::fs::write(&source, b"preserve source").unwrap();
        std::os::unix::fs::symlink(&source, &output).unwrap();
        assert!(resume_import(&source, &output)
            .unwrap_err()
            .contains("symlink"));
        std::fs::remove_file(&output).unwrap();
        std::fs::hard_link(&source, &output).unwrap();
        assert!(resume_import(&source, &output)
            .unwrap_err()
            .contains("alias"));
        assert_eq!(std::fs::read(&source).unwrap(), b"preserve source");
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(output).unwrap();
    }
}
