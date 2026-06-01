import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
    appRegion?: 'drag' | 'no-drag';
  }
}

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!appWindow || !dragAreaRef.current) return;

    const dragArea = dragAreaRef.current;
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('input')) return;
      try {
        await appWindow.startDragging();
      } catch (err) {
        console.error("Failed to start window drag:", err);
      }
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
      await recordingService.startRecording();
      setIsRecording(true);
      setTime(0);
    } catch (err) {
      console.error("Failed to start recording:", err);
      alert(`Failed to start recording: ${err}`);
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
        setIsRecording(true);
        console.error("Failed to stop recording:", err);
        alert(`Failed to stop recording: ${err}`);
        return;
      } finally {
        setIsFinalizing(false);
      }
    }

    if (savedPath && noteTitle) {
      localStorage.setItem('audio_to_process', JSON.stringify({
        audioPath: savedPath,
        noteTitle,
        timestamp: Date.now()
      }));

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('notify_recording_started', { noteTitle });
      } catch {
        // Tauri notification is optional backup
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    try {
      const win = appWindow || getCurrentWindow();
      await win.close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  };

  return (
    <div className="recording-popup-ui w-full h-full flex items-center justify-center" style={{ background: 'transparent' }}>
      <div
        ref={dragAreaRef}
        className={`
          grid grid-cols-[1fr_auto_1fr] items-center gap-5 px-5 rounded-full
          backdrop-blur-xl border shadow-2xl
          ${isDarkMode ? 'bg-neutral-950/88 border-white/12 text-white shadow-black/40' : 'bg-white/90 border-black/10 text-neutral-950 shadow-black/15'}
          transition-all duration-300 ease-out w-[720px] h-[64px] mx-4
        `}
        style={{ cursor: 'move' }}
      >
        <div className="flex items-center justify-start">
          <button
            onClick={handleRecord}
            disabled={isRecording || isFinalizing}
            className={`inline-flex h-10 min-w-[132px] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold tracking-[0.1em] transition-[color,opacity,transform] duration-200 ${
              isRecording
                ? (isDarkMode ? 'text-red-200' : 'text-red-700')
                : isFinalizing
                  ? (isDarkMode ? 'text-white/35' : 'text-neutral-400')
                  : (isDarkMode ? 'text-white/90 hover:text-emerald-300 active:scale-[0.98]' : 'text-neutral-800 hover:text-emerald-700 active:scale-[0.98]')
            }`}
            style={{ WebkitAppRegion: 'no-drag', pointerEvents: 'auto', cursor: isRecording || isFinalizing ? 'default' : 'pointer' }}
          >
            {isRecording && <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.9)]" />}
            {isRecording ? 'LIVE' : isFinalizing ? 'LOCKED' : 'RECORD'}
          </button>
        </div>

        <div className={`min-w-[172px] rounded-full px-5 py-2 text-center font-mono text-base font-semibold tracking-[0.06em] ${isDarkMode ? 'bg-white/7 text-emerald-300' : 'bg-neutral-100 text-neutral-950'} transition-all duration-300`}>
          {isFinalizing ? (
            <span className="inline-flex items-center justify-center gap-2 text-emerald-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              SAVING
            </span>
          ) : (
            formatTime(time)
          )}
        </div>

        <div className="flex items-center justify-end">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleFinish(); }}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isFinalizing}
            className={`inline-flex h-10 min-w-[132px] items-center justify-center rounded-full px-5 text-sm font-semibold tracking-[0.1em] transition-[color,opacity,transform] duration-200 ${
              isFinalizing
                ? (isDarkMode ? 'text-white/35' : 'text-neutral-400')
                : isRecording
                  ? 'text-red-300 hover:text-red-200 active:scale-[0.98]'
                  : (isDarkMode ? 'text-white/90 hover:text-white active:scale-[0.98]' : 'text-neutral-700 hover:text-neutral-950 active:scale-[0.98]')
            }`}
            style={{ pointerEvents: 'auto', cursor: isFinalizing ? 'wait' : 'pointer', WebkitAppRegion: 'no-drag' }}
          >
            {isFinalizing ? 'SAVING' : isRecording ? 'FINISH' : 'CLOSE'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecordingPopupApp;
