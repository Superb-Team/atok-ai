# Atok.ai Recording Feature - Audio Recording Implementation

## Overview
Fitur recording di Atok.ai saat ini mendukung:
1. **✅ Microphone Recording** - Input audio dari mikrofon (WORKING)
2. **⚠️ Desktop Audio** - Memerlukan Virtual Audio Cable (lihat RECORDING_SOLUTION.md)

## Teknologi yang Digunakan

### Backend (Rust)
- **cpal** - Cross-platform audio library untuk capture audio
- **ringbuf** - Ring buffer untuk buffering audio streams
- **hound** - WAV file writer untuk menyimpan recording
- **WASAPI** - Windows Audio Session API (via cpal)

### Frontend (TypeScript/React)
- **Tauri API** - Untuk memanggil Rust commands
- **Recording Service** - Service layer untuk manage recording state

## Cara Kerja

### 1. Inisialisasi Audio Devices
```rust
let host = cpal::default_host();
let mic_device = host.default_input_device();      // Microphone
let desktop_device = host.default_output_device(); // Desktop audio
```

### 2. Setup Ring Buffers
Ring buffers digunakan untuk buffering audio dari kedua stream:
```rust
let mic_ring = HeapRb::<f32>::new(latency_samples * 8);
let desktop_ring = HeapRb::<f32>::new(latency_samples * 8);
```

### 3. Audio Capture Callbacks
Setiap stream memiliki callback yang dipanggil saat ada audio data baru:
```rust
// Microphone callback
let mic_callback = move |data: &[f32], _| {
    for &sample in data {
        let _ = mic_producer.try_push(sample);
    }
};

// Desktop audio callback (loopback)
let desktop_callback = move |data: &[f32], _| {
    for &sample in data {
        let _ = desktop_producer.try_push(sample);
    }
};
```

### 4. Audio Mixing
Audio dari kedua sumber di-mix dengan rata-rata:
```rust
let mixed_sample = match (mic_sample, desktop_sample) {
    (Some(m), Some(d)) => (m + d) / 2.0,  // Mix both
    (Some(m), None) => m,                  // Only mic
    (None, Some(d)) => d,                  // Only desktop
    (None, None) => break,                 // No samples
};
```

### 5. WAV File Output
Recording disimpan dalam format WAV:
- **Format**: 32-bit Float
- **Sample Rate**: Sesuai device default (biasanya 48000 Hz)
- **Channels**: Sesuai device default (biasanya 2 - stereo)
- **Location**: Downloads folder

## Penggunaan

### Dari Frontend
```typescript
import { recordingService } from '@/services/recording.service';

// Start recording
const outputPath = await recordingService.startRecording();

// Stop recording
const savedPath = await recordingService.stopRecording();

// Check if recording
const isRecording = await recordingService.isRecording();
```

### Dari Tauri Commands
```typescript
import { invoke } from '@tauri-apps/api/core';

// Start recording
await invoke('start_desktop_recording', { 
  outputPath: 'C:\\Users\\...\\Downloads\\recording.wav' 
});

// Stop recording
await invoke('stop_desktop_recording');

// Check status
const recording = await invoke<boolean>('is_recording');
```

## File Output

### Lokasi
Semua recording disimpan di folder **Downloads** dengan format nama:
```
atok-recording-YYYY-MM-DDTHH-MM-SS-mmmZ.wav
```

Contoh:
```
C:\Users\YourName\Downloads\atok-recording-2024-10-19T14-30-45-123Z.wav
```

### Format WAV
- **Bit Depth**: 32-bit Float
- **Sample Rate**: 48000 Hz (default)
- **Channels**: 2 (Stereo)
- **Quality**: Lossless, high quality

## Troubleshooting

### Recording tidak menghasilkan file
1. Pastikan folder Downloads dapat diakses
2. Check console untuk error messages
3. Pastikan microphone dan audio output device terdeteksi

### Audio hanya dari satu sumber
- **Hanya mic**: Desktop audio device mungkin tidak support loopback
- **Hanya desktop**: Microphone mungkin tidak terdeteksi atau muted

### Audio quality buruk
- Check sample rate device (48000 Hz recommended)
- Pastikan tidak ada audio processing yang mengganggu
- Check buffer size (saat ini 200ms)

## Limitasi

1. **Windows Only** - WASAPI hanya tersedia di Windows
2. **No Pause** - Saat ini tidak ada fitur pause (hanya start/stop)
3. **Single Recording** - Hanya bisa satu recording aktif pada satu waktu
4. **No Format Selection** - Output selalu WAV 32-bit float

## Future Improvements

- [ ] Support untuk macOS (CoreAudio)
- [ ] Support untuk Linux (PulseAudio/ALSA)
- [ ] Pause/Resume functionality
- [ ] Multiple format output (MP3, FLAC, etc.)
- [ ] Audio level monitoring
- [ ] Device selection UI
- [ ] Real-time audio visualization
- [ ] Automatic gain control (AGC)
- [ ] Noise reduction

## Technical Notes

### WASAPI Loopback
WASAPI loopback capture memungkinkan kita untuk merekam audio yang sedang diputar oleh sistem. Ini dilakukan dengan membuat input stream pada output device:

```rust
// This captures what's being played through speakers
let desktop_stream = desktop_device.build_input_stream(
    &desktop_config,
    desktop_callback,
    err_fn,
    None
);
```

### Thread Safety
Recording berjalan di thread terpisah untuk menghindari blocking UI:
```rust
let thread_handle = std::thread::spawn(move || {
    Self::recording_thread_fn(output_path, is_recording)
});
```

### Buffer Management
Ring buffer size dihitung berdasarkan sample rate dan latency:
```rust
let latency_samples = (sample_rate * channels) / 5; // 200ms
let buffer_size = latency_samples * 8; // 1.6 seconds total buffer
```

## References

- [WASAPI Documentation](https://docs.microsoft.com/en-us/windows/win32/coreaudio/wasapi)
- [cpal Documentation](https://docs.rs/cpal/)
- [ringbuf Documentation](https://docs.rs/ringbuf/)
- [hound Documentation](https://docs.rs/hound/)
