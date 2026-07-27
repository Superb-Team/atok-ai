import CoreMedia
import Foundation
import ScreenCaptureKit

private let captureSampleRate = 48_000
private let captureChannels = 2
private let bytesPerSample = MemoryLayout<Int16>.size
private let chunkSeconds = 180
private let bytesPerChunk = captureSampleRate * captureChannels * bytesPerSample * chunkSeconds

@available(macOS 13.0, *)
private final class SystemAudioCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let stateLock = NSLock()
    private let ioQueue = DispatchQueue(label: "com.superbteam.atok.system-audio-io")
    // Bound queued writes so a slow disk cannot grow memory for the whole take.
    private let pendingWrites = DispatchSemaphore(value: 64)
    private let outputDirectory: URL

    private var stream: SCStream?
    private var fileHandle: FileHandle?
    private var chunkIndex = 0
    private var bytesInChunk = 0
    private var acceptingAudio = false
    private var paused = false
    private var runtimeError: String?

    init(outputDirectory: URL) {
        self.outputDirectory = outputDirectory
    }

    func start() -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: outputDirectory,
                withIntermediateDirectories: true
            )
            try openChunk(index: 0)
        } catch {
            recordError("Failed to create system-audio chunk: \(error.localizedDescription)")
            closeFile()
            return false
        }

        let semaphore = DispatchSemaphore(value: 0)
        var started = false

        DispatchQueue.main.async {
            Task {
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(
                        false,
                        onScreenWindowsOnly: false
                    )
                    guard let display = content.displays.first else {
                        throw CaptureError.noDisplay
                    }

                    let filter = SCContentFilter(
                        display: display,
                        excludingApplications: [],
                        exceptingWindows: []
                    )
                    let config = SCStreamConfiguration()
                    config.width = 2
                    config.height = 2
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                    config.capturesAudio = true
                    config.sampleRate = captureSampleRate
                    config.channelCount = captureChannels

                    let stream = SCStream(
                        filter: filter,
                        configuration: config,
                        delegate: self
                    )
                    try stream.addStreamOutput(
                        self,
                        type: .audio,
                        sampleHandlerQueue: DispatchQueue.global(qos: .userInteractive)
                    )
                    try await stream.startCapture()

                    self.stateLock.withLock {
                        self.stream = stream
                        self.acceptingAudio = true
                    }
                    started = true
                    print("[SystemAudio] ScreenCaptureKit audio capture started")
                } catch {
                    self.recordError(
                        "Failed to start capture: \(error.localizedDescription)"
                    )
                }
                semaphore.signal()
            }
        }

        semaphore.wait()
        if !started {
            closeFile()
        }
        return started
    }

    func stop() -> Bool {
        let capturedStream = stateLock.withLock { () -> SCStream? in
            acceptingAudio = false
            let current = self.stream
            self.stream = nil
            return current
        }

        if let capturedStream {
            let semaphore = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                Task {
                    do {
                        try await capturedStream.stopCapture()
                    } catch {
                        self.recordError(
                            "Failed to stop capture: \(error.localizedDescription)"
                        )
                    }
                    semaphore.signal()
                }
            }
            semaphore.wait()
        }

        ioQueue.sync {
            closeFile()
        }

        let error = stateLock.withLock { runtimeError }
        if let error {
            print("[SystemAudio] \(error)")
            return false
        }
        print("[SystemAudio] Capture stopped")
        return true
    }

    func setPaused(_ value: Bool) {
        stateLock.withLock {
            paused = value
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard stateLock.withLock({ acceptingAudio && !paused }) else { return }
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == noErr, let dataPointer else { return }

        let floatCount = totalLength / MemoryLayout<Float>.size
        let floatPointer = UnsafeRawPointer(dataPointer).bindMemory(
            to: Float.self,
            capacity: floatCount
        )
        var int16Buffer = [Int16](repeating: 0, count: floatCount)
        for index in 0..<floatCount {
            let sample = floatPointer[index]
            int16Buffer[index] = Int16(
                max(-32_768, min(32_767, sample * 32_767.0))
            )
        }

        let data = int16Buffer.withUnsafeBytes { Data($0) }
        guard pendingWrites.wait(timeout: .now()) == .success else {
            recordError("System-audio write queue overflowed")
            return
        }
        ioQueue.async { [weak self] in
            defer { self?.pendingWrites.signal() }
            self?.write(data)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stateLock.withLock {
            acceptingAudio = false
            runtimeError = "Capture stopped unexpectedly: \(error.localizedDescription)"
        }
    }

    private func write(_ data: Data) {
        var offset = 0
        while offset < data.count {
            if fileHandle == nil {
                do {
                    try openChunk(index: chunkIndex)
                } catch {
                    recordError("Failed to open system-audio chunk: \(error.localizedDescription)")
                    return
                }
            }

            let available = bytesPerChunk - bytesInChunk
            let count = min(available, data.count - offset)
            let range = offset..<(offset + count)
            do {
                try fileHandle?.write(contentsOf: data.subdata(in: range))
            } catch {
                recordError("Failed to write system audio: \(error.localizedDescription)")
                return
            }
            bytesInChunk += count
            offset += count

            if bytesInChunk == bytesPerChunk {
                closeFile()
                chunkIndex += 1
                bytesInChunk = 0
            }
        }
    }

    private func openChunk(index: Int) throws {
        let name = String(format: "sys_%04d.raw", index)
        let url = outputDirectory.appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: url.path) else {
            throw CaptureError.fileOpen(url.path)
        }
        fileHandle = handle
    }

    private func closeFile() {
        do {
            try fileHandle?.synchronize()
            try fileHandle?.close()
        } catch {
            recordError("Failed to finalize system audio: \(error.localizedDescription)")
        }
        fileHandle = nil
    }

    private func recordError(_ message: String) {
        stateLock.withLock {
            acceptingAudio = false
            if runtimeError == nil {
                runtimeError = message
            }
        }
    }
}

private enum CaptureError: LocalizedError {
    case noDisplay
    case fileOpen(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay:
            return "No display is available for ScreenCaptureKit"
        case .fileOpen(let path):
            return "Could not open \(path)"
        }
    }
}

private let globalLock = NSLock()
@available(macOS 13.0, *)
private var activeSession: SystemAudioCaptureSession?

@_cdecl("sc_start_system_audio")
func scStartSystemAudio(pathPtr: UnsafePointer<UInt8>, pathLen: UInt32) -> Bool {
    guard #available(macOS 13.0, *) else {
        print("[SystemAudio] macOS 13 or newer is required")
        return false
    }
    guard pathLen > 0 else {
        print("[SystemAudio] Empty session path")
        return false
    }
    let pathData = Data(bytes: pathPtr, count: Int(pathLen))
    guard let path = String(data: pathData, encoding: .utf8), !path.isEmpty else {
        print("[SystemAudio] Session path is not valid UTF-8")
        return false
    }

    let canStart = globalLock.withLock { activeSession == nil }
    guard canStart else {
        print("[SystemAudio] A capture session is already active")
        return false
    }

    let session = SystemAudioCaptureSession(
        outputDirectory: URL(fileURLWithPath: path, isDirectory: true)
    )
    guard session.start() else {
        return false
    }

    return globalLock.withLock {
        guard activeSession == nil else {
            _ = session.stop()
            return false
        }
        activeSession = session
        return true
    }
}

@_cdecl("sc_stop_system_audio")
func scStopSystemAudio() -> Bool {
    guard #available(macOS 13.0, *) else { return false }
    let session = globalLock.withLock { () -> SystemAudioCaptureSession? in
        let current = activeSession
        activeSession = nil
        return current
    }
    return session?.stop() ?? true
}

@_cdecl("sc_set_system_audio_paused")
func scSetSystemAudioPaused(_ paused: Bool) -> Bool {
    guard #available(macOS 13.0, *) else { return false }
    return globalLock.withLock {
        guard let session = activeSession else { return false }
        session.setPaused(paused)
        return true
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
