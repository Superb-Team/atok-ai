import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { AudioDeviceInfo } from '@/services/recording.service';
import type { RecordingNoteContext } from '@/services/recording-note-metadata';

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
const MIC_STORAGE_KEY = 'recording-mic-device';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [shotFlash, setShotFlash] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);
  const isRecordingRef = useRef(false);
  const recordingContextRef = useRef<RecordingNoteContext | null>(null);

  // Transcription language. A ref mirrors it so the close handler (registered once)
  // reads the current value instead of a stale closure.
  const [selectedLanguage, setSelectedLanguage] = useState<string>('id');
  const selectedLanguageRef = useRef<string>('id');

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

        const savedMic = localStorage.getItem(MIC_STORAGE_KEY);
        const savedDevice = devices.find((device) => device.raw_name === savedMic);
        const defaultDevice = devices.find((device) => device.is_default);
        if (savedDevice) {
          setSelectedMic(savedDevice.raw_name);
        } else if (defaultDevice) {
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
            const context = recordingContextRef.current;
            const timestamp = Date.now();
            // localStorage is the fallback handoff; the event below is the fast
            // path that lets the main window start processing immediately.
            localStorage.setItem('audio_to_process', JSON.stringify({
              audioPath: savedPath,
              noteTitle,
              language: selectedLanguageRef.current,
              timestamp,
              recordedAt: context?.recordedAt,
              timezone: context?.timezone,
            }));
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('notify_recording_started', {
                noteTitle,
                audioPath: savedPath,
                language: selectedLanguageRef.current,
                timestamp,
                recordedAt: context?.recordedAt,
                timezone: context?.timezone,
              });
            } catch {}
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
    if (isRecording && !isPaused) {
      interval = setInterval(() => setTime(prev => prev + 0.01), 10);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const resolveTheme = () => {
      const preference = localStorage.getItem('theme') ?? 'system';
      setIsDarkMode(preference === 'dark' || (preference === 'system' && mq.matches));
    };
    const handler = () => resolveTheme();
    resolveTheme();
    mq.addEventListener('change', handler);
    window.addEventListener('storage', handler);
    return () => {
      mq.removeEventListener('change', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const handleRecord = async () => {
    if (isRecording || isFinalizing) return;
    try {
      const { recordingService } = await import('@/services/recording.service');
      const started = await recordingService.startRecording(selectedMic || undefined, selectedLanguage);
      recordingContextRef.current = {
        recordedAt: started.recordedAt,
        timezone: started.timezone,
      };
      setIsRecording(true);
      setIsPaused(false);
      setTime(0);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setAlertMessage(`Failed to start recording: ${err}`);
    }
  };

  const handlePauseToggle = async () => {
    if (!isRecording || isFinalizing) return;
    const nextPaused = !isPaused;
    try {
      const { recordingService } = await import('@/services/recording.service');
      await recordingService.setPaused(nextPaused);
      setIsPaused(nextPaused);
    } catch (err) {
      console.error('Failed to change pause state:', err);
      setAlertMessage(`Failed to ${nextPaused ? 'pause' : 'resume'} recording: ${err}`);
    }
  };

  // Screenshot the screen (popup hidden so it isn't in the shot) and log it with
  // the current elapsed time; failures alert but never interrupt the recording.
  const handleScreenshot = async () => {
    if (!isRecording || isCapturing) return;
    setIsCapturing(true);
    const elapsedMs = time * 1000;
    try {
      const { recordingService } = await import('@/services/recording.service');
      const { noteAssetService } = await import('@/services/note-asset.service');
      const audioPath = recordingService.getCurrentRecordingPath();
      if (!audioPath) throw new Error('No active recording');

      await appWindow?.hide();
      let asset;
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        asset = await noteAssetService.captureScreenshot();
      } finally {
        await appWindow?.show();
      }

      await noteAssetService.recordScreenshotAsset(audioPath, asset.saved_path, elapsedMs);
      setShotFlash(true);
      setTimeout(() => setShotFlash(false), 1200);
    } catch (err) {
      console.error('Screenshot failed:', err);
      setAlertMessage(`Screenshot failed: ${err}`);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleFinish = async () => {
    if (isFinalizing) return;
    let savedPath: string | null = null;
    let noteTitle: string | null = null;

    if (isRecording) {
      setIsRecording(false);
      setIsPaused(false);
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
      const context = recordingContextRef.current;
      const timestamp = Date.now();
      // localStorage is the fallback handoff; the event below is the fast path
      // that lets the main window start processing immediately.
      localStorage.setItem('audio_to_process', JSON.stringify({
        audioPath: savedPath,
        noteTitle,
        language: selectedLanguage,
        timestamp,
        recordedAt: context?.recordedAt,
        timezone: context?.timezone,
      }));
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('notify_recording_started', {
          noteTitle,
          audioPath: savedPath,
          language: selectedLanguage,
          timestamp,
          recordedAt: context?.recordedAt,
          timezone: context?.timezone,
        });
      } catch {}
    }

    await closeWindowHard();
  };

  // close() goes through the close-requested path, which on Linux
  // transparent/undecorated windows can be silently swallowed. After the take is
  // handed off there is nothing graceful left to do, so fall back to destroy()
  // if the window is still alive shortly after.
  const closeWindowHard = async () => {
    const win = appWindow || getCurrentWindow();
    try {
      await win.close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
    setTimeout(() => {
      win.destroy().catch(() => {});
    }, 500);
  };

  const selectedMicDevice = micDevices.find((d) => d.raw_name === selectedMic);
  const selectedMicDisplay = selectedMicDevice?.display_name ?? 'Microphone';
  const palette = isDarkMode
    ? {
        surface: 'rgba(20, 20, 22, 0.96)',
        raised: 'rgba(255, 255, 255, 0.07)',
        border: 'rgba(255, 255, 255, 0.12)',
        text: '#f5f5f7',
        muted: '#a1a1aa',
        subtle: '#71717a',
        accent: '#f5f5f7',
        shadow: '0 12px 32px rgba(0, 0, 0, 0.32)',
      }
    : {
        surface: 'rgba(250, 250, 250, 0.97)',
        raised: 'rgba(0, 0, 0, 0.055)',
        border: 'rgba(0, 0, 0, 0.13)',
        text: '#18181b',
        muted: '#52525b',
        subtle: '#8e8e93',
        accent: '#09090b',
        shadow: '0 12px 32px rgba(0, 0, 0, 0.16)',
      };

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
            backgroundColor: palette.surface,
            border: `1px solid ${palette.border}`,
            padding: '0 28px',
            gap: '20px',
            cursor: 'move',
            WebkitAppRegion: 'drag',
            boxShadow: palette.shadow,
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
            {/* Selected mic stays visible so virtual devices cannot be missed. */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '42px',
                  maxWidth: '148px',
                  height: '42px',
                  padding: '0 11px',
                  gap: '7px',
                  borderRadius: '10px',
                  border: `1px solid ${palette.border}`,
                  backgroundColor: palette.raised,
                  color: micAvailable ? palette.text : palette.subtle,
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
                title={micAvailable ? `🎙️ ${selectedMicDisplay}` : '❌ No Microphone'}
              >
                <MicIcon />
                <span
                  style={{
                    maxWidth: '96px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  {selectedMicDisplay}
                </span>
              </div>
              {devicesLoaded && micDevices.length >= 1 && (
                <select
                  value={selectedMic}
                  onChange={(e) => {
                    setSelectedMic(e.target.value);
                    localStorage.setItem(MIC_STORAGE_KEY, e.target.value);
                  }}
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
                  border: `1px solid ${palette.border}`,
                  backgroundColor: palette.raised,
                  color: sysAudioAvailable ? palette.text : palette.subtle,
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
                  border: `1px solid ${palette.border}`,
                  backgroundColor: palette.raised,
                  color: palette.text,
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
                backgroundColor: isRecording && !isPaused ? '#ef4444' : palette.subtle,
                boxShadow: isRecording && !isPaused ? '0 0 8px rgba(239,68,68,0.45)' : 'none',
                animation: isRecording && !isPaused ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }}
            />
            <span
              style={{
                color: palette.text,
                fontSize: '14px',
                fontWeight: 700,
                letterSpacing: '0.18em',
              }}
            >
              {isRecording ? (isPaused ? 'PAUSED' : 'LIVE') : isFinalizing ? 'SAVING' : 'READY'}
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
                backgroundColor: palette.raised,
                border: `1px solid ${palette.border}`,
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
                  color: isRecording && !isPaused ? palette.text : palette.subtle,
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
              /* While recording: pause/resume + screenshot + finish */
              <>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handlePauseToggle(); }}
                onMouseDown={(e) => e.stopPropagation()}
                title={isPaused ? 'Resume recording' : 'Pause recording'}
                style={{
                  fontSize: '13px',
                  fontWeight: 650,
                  letterSpacing: '0.08em',
                  color: palette.text,
                  cursor: 'pointer',
                }}
              >
                {isPaused ? 'RESUME' : 'PAUSE'}
              </button>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleScreenshot(); }}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={isCapturing}
                title="Capture screen as note context"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '14px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  color: shotFlash ? palette.text : isCapturing ? palette.subtle : palette.muted,
                  cursor: isCapturing ? 'wait' : 'pointer',
                  transition: 'color 0.15s, opacity 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
                  <circle cx="12" cy="13" r="3"/>
                </svg>
                {shotFlash ? 'SAVED' : isCapturing ? 'SNAP...' : 'SNAP'}
              </button>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleFinish(); }}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  color: palette.text,
                  cursor: 'pointer',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                FINISH
              </button>
              </>
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
              /* Before recording: dim camera hint + CLOSE + RECORD */
              <>
                <span
                  title="Start recording to capture screenshots"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: '#3f3f46',
                    cursor: 'not-allowed',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
                    <circle cx="12" cy="13" r="3"/>
                  </svg>
                </span>
                <button
                  onClick={() => { closeWindowHard(); }}
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
                    color: palette.accent,
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
