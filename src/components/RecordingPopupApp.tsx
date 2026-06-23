import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { AudioDeviceInfo } from '@/services/recording.service';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
    appRegion?: 'drag' | 'no-drag';
  }
}

// Transcription language pinned for Whisper. Auto ('') lets the API detect, but
// that drifts to the wrong language on quiet chunks — default to Indonesian.
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'id', label: 'ID' },
  { code: 'en', label: 'EN' },
  { code: 'ja', label: 'JA' },
  { code: 'ko', label: 'KO' },
  { code: 'zh', label: 'ZH' },
  { code: 'es', label: 'ES' },
  { code: 'ar', label: 'AR' },
  { code: '', label: 'AUTO' },
];

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [time, setTime] = useState(0);
  const [_isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);
  const isRecordingRef = useRef(false);

  // Transcription language. A ref mirrors it so the close handler (registered once)
  // reads the current value instead of a stale closure.
  const [selectedLanguage, setSelectedLanguage] = useState<string>('id');
  const selectedLanguageRef = useRef<string>('id');

  // Device state
  const [micAvailable, setMicAvailable] = useState(false);
  const [sysAudioAvailable, setSysAudioAvailable] = useState(false);
  const [sysDisplayName, setSysDisplayName] = useState<string>('System Audio');
  const [micDevices, setMicDevices] = useState<AudioDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [devicesLoaded, setDevicesLoaded] = useState(false);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const { recordingService } = await import('@/services/recording.service');
        const [status, devices] = await Promise.all([
          recordingService.getDeviceStatus(),
          recordingService.listInputDevices(),
        ]);
        setMicAvailable(status.mic_available);
        setSysAudioAvailable(status.system_audio_available);
        setSysDisplayName(status.system_audio_display_name ?? 'System Audio');
        setMicDevices(devices);

        const defaultDevice = devices.find((d) => d.is_default);
        if (defaultDevice) {
          setSelectedMic(defaultDevice.raw_name);
        } else if (devices.length > 0) {
          setSelectedMic(devices[0].raw_name);
        }
        setDevicesLoaded(true);
      } catch (err) {
        console.error('Failed to load devices:', err);
        setDevicesLoaded(true);
      }
    };
    loadDevices();
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    try {
      setAppWindow(getCurrentWindow());
    } catch (err) {
      console.error("Failed to get window reference:", err);
    }
  }, []);

  // Keep a ref in sync so the close handler reads the latest value.
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    selectedLanguageRef.current = selectedLanguage;
  }, [selectedLanguage]);

  // If the window is closed mid-recording, stop the backend AND hand the take to
  // the processing pipeline (same as Finish) so the recording isn't silently lost
  // and the recorder isn't left wedged.
  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    let closing = false;
    appWindow
      .onCloseRequested(async (event) => {
        if (isRecordingRef.current && !closing) {
          closing = true;
          event.preventDefault();
          try {
            const { recordingService } = await import('@/services/recording.service');
            const savedPath = await recordingService.stopRecording();
            const { generateNoteTitle } = await import('@/services/audio-processor.service');
            const noteTitle = generateNoteTitle();
            localStorage.setItem('audio_to_process', JSON.stringify({
              audioPath: savedPath,
              noteTitle,
              language: selectedLanguageRef.current,
              timestamp: Date.now(),
            }));
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('notify_recording_started', { noteTitle });
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 200));
          } catch (err) {
            console.error('Failed to finalize recording on close:', err);
          }
          await appWindow.destroy();
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, [appWindow]);

  useEffect(() => {
    if (!appWindow || !dragAreaRef.current) return;
    const dragArea = dragAreaRef.current;
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      try { await appWindow.startDragging(); } catch {}
    };
    dragArea.addEventListener('mousedown', handleMouseDown);
    return () => dragArea.removeEventListener('mousedown', handleMouseDown);
  }, [appWindow]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      interval = setInterval(() => setTime(prev => prev + 0.01), 10);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    setIsDarkMode(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleRecord = async () => {
    if (isRecording || isFinalizing) return;
    try {
      const { recordingService } = await import('@/services/recording.service');
      await recordingService.startRecording(selectedMic || undefined, selectedLanguage);
      setIsRecording(true);
      setTime(0);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setAlertMessage(`Failed to start recording: ${err}`);
    }
  };

  const handleFinish = async () => {
    if (isFinalizing) return;
    let savedPath: string | null = null;
    let noteTitle: string | null = null;

    if (isRecording) {
      setIsRecording(false);
      setIsFinalizing(true);
      try {
        const { recordingService } = await import('@/services/recording.service');
        savedPath = await recordingService.stopRecording();
        const { generateNoteTitle } = await import('@/services/audio-processor.service');
        noteTitle = generateNoteTitle();
        setTime(0);
      } catch (err) {
        // The backend recorder is already torn down on a failed stop. Stay in the
        // idle state (not LIVE) so the user can't "finish" again and reprocess a
        // corrupt take; surface the error instead.
        console.error("Failed to stop recording:", err);
        setAlertMessage(`Failed to stop recording: ${err}`);
        return;
      } finally {
        setIsFinalizing(false);
      }
    }

    if (savedPath && noteTitle) {
      localStorage.setItem('audio_to_process', JSON.stringify({
        audioPath: savedPath,
        noteTitle,
        language: selectedLanguage,
        timestamp: Date.now()
      }));
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('notify_recording_started', { noteTitle });
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    try {
      const win = appWindow || getCurrentWindow();
      await win.close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  };

  const selectedMicDevice = micDevices.find((d) => d.raw_name === selectedMic);
  const selectedMicDisplay = selectedMicDevice?.display_name ?? 'Microphone';

  const MicIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3"/>
      <path d="M5 10a7 7 0 0 0 14 0"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="9" y1="22" x2="15" y2="22"/>
    </svg>
  );

  const SpeakerIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
    </svg>
  );

  return (
    <>
      <ConfirmDialog
        open={alertMessage !== null}
        onOpenChange={(open) => { if (!open) setAlertMessage(null); }}
        title="Recording error"
        description={alertMessage ?? ""}
        confirmText="OK"
        mode="alert"
        variant="destructive"
      />

      {/* Full window transparent container */}
      <div
        className="recording-popup-ui"
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          padding: '0 16px',
        }}
      >
        {/* Main pill bar */}
        <div
          ref={dragAreaRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            height: '72px',
            borderRadius: '9999px',
            backgroundColor: '#111111',
            border: '1px solid rgba(255,255,255,0.06)',
            padding: '0 28px',
            gap: '20px',
            cursor: 'move',
            WebkitAppRegion: 'drag',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          } as React.CSSProperties}
        >
          {/* === LEFT SECTION: Device badges === */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {/* Mic badge — icon only, click opens device picker */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '42px',
                  height: '42px',
                  borderRadius: '10px',
                  border: micAvailable ? '1px solid rgba(16,185,129,0.25)' : '1px solid rgba(239,68,68,0.25)',
                  backgroundColor: micAvailable ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
                  color: micAvailable ? '#34d399' : '#f87171',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
                title={micAvailable ? `🎙️ ${selectedMicDisplay}` : '❌ No Microphone'}
              >
                <MicIcon />
              </div>
              {devicesLoaded && micDevices.length >= 1 && (
                <select
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  disabled={isRecording || isFinalizing}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                  title="Select Microphone"
                >
                  {micDevices.map((device) => (
                    <option key={device.raw_name} value={device.raw_name}>
                      {device.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Speaker badge — icon only, click shows active system audio */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '42px',
                  height: '42px',
                  borderRadius: '10px',
                  border: sysAudioAvailable ? '1px solid rgba(16,185,129,0.25)' : '1px solid rgba(239,68,68,0.25)',
                  backgroundColor: sysAudioAvailable ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
                  color: sysAudioAvailable ? '#34d399' : '#f87171',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
                title={sysAudioAvailable ? `🔊 ${sysDisplayName || 'System Audio'}` : '❌ No System Audio'}
              >
                <SpeakerIcon />
              </div>
              <select
                disabled
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'pointer',
                }}
                title="System Audio Device"
                value={sysDisplayName || 'System Audio'}
              >
                <option value={sysDisplayName || 'System Audio'}>
                  {sysAudioAvailable ? (sysDisplayName || 'System Audio') : 'No System Audio'}
                </option>
              </select>
            </div>

            {/* Language badge — pinned transcription language, click to change */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '42px',
                  height: '42px',
                  padding: '0 8px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                  color: '#d1d5db',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                }}
                title="Transcription language"
              >
                {LANGUAGES.find((l) => l.code === selectedLanguage)?.label ?? 'ID'}
              </div>
              <select
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value)}
                disabled={isRecording || isFinalizing}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'pointer',
                }}
                title="Select transcription language"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code || 'auto'} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* === CENTER-LEFT: Status indicator === */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: isRecording ? '#ef4444' : isFinalizing ? '#f59e0b' : '#6b7280',
                boxShadow: isRecording ? '0 0 10px rgba(239,68,68,0.8)' : 'none',
                animation: isRecording ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }}
            />
            <span
              style={{
                color: '#ffffff',
                fontSize: '14px',
                fontWeight: 700,
                letterSpacing: '0.18em',
              }}
            >
              {isRecording ? 'LIVE' : isFinalizing ? 'SAVING' : 'READY'}
            </span>
          </div>

          {/* === CENTER: Timer pill (flex-grow to fill remaining space) === */}
          <div
            style={{
              flex: '1 1 0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            <div
              style={{
                backgroundColor: '#1a1a1a',
                borderRadius: '9999px',
                padding: '10px 32px',
                minWidth: '200px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", ui-monospace, monospace',
                  fontSize: '17px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  color: isRecording ? '#34d399' : '#6b7280',
                }}
              >
                {isFinalizing ? 'SAVING...' : formatTime(time)}
              </span>
            </div>
          </div>

          {/* === RIGHT: Action buttons === */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '24px',
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {isRecording ? (
              /* While recording: only FINISH */
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleFinish(); }}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  color: '#ffffff',
                  cursor: 'pointer',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                FINISH
              </button>
            ) : isFinalizing ? (
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  color: '#6b7280',
                }}
              >
                WAIT...
              </span>
            ) : (
              /* Before recording: CLOSE + RECORD */
              <>
                <button
                  onClick={() => { appWindow?.close(); }}
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    letterSpacing: '0.1em',
                    color: '#6b7280',
                    cursor: 'pointer',
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#d1d5db')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
                >
                  CLOSE
                </button>
                <button
                  onClick={handleRecord}
                  style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    color: '#34d399',
                    cursor: 'pointer',
                    transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                >
                  RECORD
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default RecordingPopupApp;
