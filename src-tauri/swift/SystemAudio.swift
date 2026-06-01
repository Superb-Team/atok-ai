// SystemAudio.swift — macOS ScreenCaptureKit system audio capture
// Captures desktop/system audio without any external drivers (BlackHole, SoundFlower, etc.)
// Uses Apple's native ScreenCaptureKit API (macOS 12.3+)

import Foundation
import ScreenCaptureKit
import CoreMedia
import SwiftRs

// MARK: - Global state

private var g_stream: SCStream?
private var g_fileHandle: FileHandle?
private var g_outputURL: URL?
private let g_lock = NSLock()
private var g_isCapturing = false

// MARK: - Stream Output Delegate

@available(macOS 12.3, *)
class AudioCaptureDelegate: NSObject, SCStreamOutput, SCStreamDelegate {

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        g_lock.lock()
        guard g_isCapturing, let fileHandle = g_fileHandle else {
            g_lock.unlock()
            return
        }
        g_lock.unlock()

        // Extract audio data from CMSampleBuffer
        guard sampleBuffer.isValid else { return }
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        var lengthAtOffset: Int = 0
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?

        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )

        guard status == noErr, let dataPointer = dataPointer else { return }

        // ScreenCaptureKit delivers Float32 interleaved audio
        // Convert to Int16 (S16LE) for efficient storage and mixing
        let floatCount = totalLength / MemoryLayout<Float>.size
        let floatPointer = UnsafeRawPointer(dataPointer).bindMemory(to: Float.self, capacity: floatCount)

        var int16Buffer = [Int16](repeating: 0, count: floatCount)
        for i in 0..<floatCount {
            let sample = floatPointer[i]
            int16Buffer[i] = Int16(max(-32768, min(32767, sample * 32767.0)))
        }

        let pcmData = Data(bytes: int16Buffer, count: int16Buffer.count * MemoryLayout<Int16>.size)

        g_lock.lock()
        do {
            try fileHandle.write(contentsOf: pcmData)
        } catch {
            print("[SystemAudio] Failed to write audio data: \(error)")
        }
        g_lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[SystemAudio] Stream stopped with error: \(error.localizedDescription)")
        g_lock.lock()
        g_isCapturing = false
        g_lock.unlock()
    }
}

// MARK: - Singleton delegate

@available(macOS 12.3, *)
private let g_delegate = AudioCaptureDelegate()

// MARK: - Exported C functions for swift-rs

/// Start capturing system audio via ScreenCaptureKit.
/// Audio is written as S16LE (Int16, 48kHz, stereo) to the specified file path.
/// Returns true on success, false on failure.
@_cdecl("sc_start_system_audio")
func scStartSystemAudio(pathPtr: UnsafePointer<CChar>, pathLen: UInt) -> Bool {
    let path = String(cString: pathPtr)
    let url = URL(fileURLWithPath: path)

    g_lock.lock()
    defer { g_lock.unlock() }

    if g_isCapturing {
        print("[SystemAudio] Already capturing")
        return false
    }

    // Create output file
    let fileManager = FileManager.default
    if !fileManager.fileExists(atPath: url.deletingLastPathComponent().path) {
        try? fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    fileManager.createFile(atPath: path, contents: nil)
    guard let fileHandle = FileHandle(forWritingAtPath: path) else {
        print("[SystemAudio] Failed to create output file: \(path)")
        return false
    }

    g_fileHandle = fileHandle
    g_outputURL = url

    // Start ScreenCaptureKit capture on main thread
    let semaphore = DispatchSemaphore(value: 0)
    var success = false

    DispatchQueue.main.async {
        Task {
            do {
                // Get available screen content
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: false
                )

                guard let display = content.displays.first else {
                    print("[SystemAudio] No display found")
                    semaphore.signal()
                    return
                }

                // Create filter for entire display — captures all system audio
                let filter = SCContentFilter(
                    display: display,
                    excludingApplications: [],
                    exceptingWindows: []
                )

                // Configure for audio-only capture (minimal video to satisfy API requirements)
                let config = SCStreamConfiguration()
                config.width = 2
                config.height = 2
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps minimum
                config.capturesAudio = true
                config.sampleRate = 48000
                config.channelCount = 2

                // Create and start the stream
                let stream = SCStream(filter: filter, configuration: config, delegate: g_delegate)
                try stream.addStreamOutput(
                    g_delegate,
                    type: .audio,
                    sampleHandlerQueue: DispatchQueue.global(qos: .userInteractive)
                )
                try await stream.startCapture()

                g_stream = stream
                success = true
                print("[SystemAudio] ScreenCaptureKit audio capture started")
            } catch {
                print("[SystemAudio] Failed to start capture: \(error.localizedDescription)")
                success = false
            }
            semaphore.signal()
        }
    }

    semaphore.wait()

    if success {
        g_isCapturing = true
    }

    return success
}

/// Stop the system audio capture and finalize the output file.
@_cdecl("sc_stop_system_audio")
func scStopSystemAudio() -> Bool {
    g_lock.lock()
    guard g_isCapturing else {
        g_lock.unlock()
        return true
    }
    g_isCapturing = false
    let stream = g_stream
    let fileHandle = g_fileHandle
    g_stream = nil
    g_fileHandle = nil
    g_lock.unlock()

    // Stop the stream
    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        Task {
            try? await stream?.stopCapture()
            semaphore.signal()
        }
    }
    semaphore.wait()

    // Close file
    try? fileHandle?.close()

    print("[SystemAudio] Capture stopped")
    return true
}
