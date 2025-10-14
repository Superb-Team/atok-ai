import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Pause, Square, Settings, Sparkles, Maximize2, Play } from 'lucide-react';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);
  const [showPermissionGuide, setShowPermissionGuide] = useState(false);
  
  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mergedStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Format time as MM:SS:MS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
  };

  // Merge audio streams using Web Audio API
  const mergeAudioStreams = (desktopStream: MediaStream, micStream: MediaStream): MediaStream => {
    const context = new AudioContext();
    audioContextRef.current = context;

    const desktopSource = context.createMediaStreamSource(desktopStream);
    const micSource = context.createMediaStreamSource(micStream);
    const destination = context.createMediaStreamDestination();
    
    desktopSource.connect(destination);
    micSource.connect(destination);
    
    return destination.stream;
  };

  // Start recording with better permission handling
  const startRecordingWithGuide = async () => {
    try {
      console.log('🎙️ Starting audio recording...');
      
      let desktopStream: MediaStream | null = null;
      let micStream: MediaStream | null = null;

      // Step 1: Request desktop audio
      try {
        console.log('📺 Requesting screen/audio capture...');
        
        // Show guide first
        const proceed = confirm('Atok AI akan meminta akses:\n\n1. Audio Desktop (pilih tab/window + centang "Share audio")\n2. Microphone\n\nLanjutkan?');
        
        if (!proceed) {
          setIsRecording(false);
          return;
        }
        
        desktopStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,  // MUST be true to get audio option in Chrome
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
          } as any
        });

        // Remove video track immediately, keep only audio
        const videoTracks = desktopStream.getVideoTracks();
        videoTracks.forEach((track: MediaStreamTrack) => track.stop());
        
        const audioTracks = desktopStream.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error('NO_AUDIO_TRACK');
        }

        console.log('✅ Desktop audio captured');
      } catch (error: any) {
        console.error('❌ Desktop audio error:', error);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          confirm('Akses ditolak.\n\nTips: Pada dialog berikutnya, centang "Share audio" dan klik "Share"');
        } else if (error.message === 'NO_AUDIO_TRACK') {
          confirm('Audio tidak terdeteksi!\n\nPastikan centang "Share audio" saat memilih tab/window');
        } else {
          confirm('Error: ' + error.message);
        }
        
        setIsRecording(false);
        return;
      }
      
      // Step 2: Request microphone
      try {
        console.log('🎤 Requesting microphone...');
        
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          }
        });
        
        console.log('✅ Microphone captured');
      } catch (error: any) {
        console.error('❌ Microphone error:', error);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          confirm('Microphone ditolak.\n\nSilakan izinkan akses microphone.');
        } else {
          confirm('Error mic: ' + error.message);
        }
        
        // Cleanup desktop stream
        if (desktopStream) {
          desktopStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        }
        setIsRecording(false);
        return;
      }
      
      // Store streams
      desktopStreamRef.current = desktopStream;
      micStreamRef.current = micStream;
      
      // Merge streams
      const mergedStream = mergeAudioStreams(desktopStream, micStream);
      mergedStreamRef.current = mergedStream;
      
      // Create MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      
      const mediaRecorder = new MediaRecorder(mergedStream, {
        mimeType,
        audioBitsPerSecond: 128000
      });
      
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          console.log('📦 Chunk:', event.data.size, 'bytes');
        }
      };
      
      mediaRecorder.onstop = async () => {
        console.log('⏹️ Saving recording...');
        await saveRecording();
      };
      
      mediaRecorder.start(1000);
      console.log('✅ Recording started!');
      
      setIsRecording(true);
      setIsPaused(false);
      
    } catch (error) {
      console.error('❌ Unexpected error:', error);
      alert('Error: ' + error);
      setIsRecording(false);
    }
  };

  // Stop all streams
  const stopAllStreams = () => {
    if (desktopStreamRef.current) {
      desktopStreamRef.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    if (mergedStreamRef.current) {
      mergedStreamRef.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
  };

  // Save recording
  const saveRecording = async () => {
    if (audioChunksRef.current.length === 0) {
      console.log('⚠️ No data');
      return;
    }

    try {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `atok-recording-${timestamp}.webm`;
      
      // Method 1: Browser download (auto ke Downloads folder)
      const url = URL.createObjectURL(audioBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('✅ Saved:', filename);
      console.log('📁 Location: Downloads folder');
      
      // Show notification in popup
      const savedMessage = document.createElement('div');
      savedMessage.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: ${isDarkMode ? '#22c55e' : '#16a34a'};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      `;
      savedMessage.textContent = `✅ Saved: ${filename}`;
      document.body.appendChild(savedMessage);
      
      setTimeout(() => {
        document.body.removeChild(savedMessage);
      }, 3000);
      
      audioChunksRef.current = [];
      
    } catch (error) {
      console.error('❌ Save error:', error);
      alert('Gagal menyimpan recording');
    }
  };

  // Get window reference in useEffect (Tauri 2.0 best practice)
  useEffect(() => {
    async function fetchWindow() {
      try {
        const window = getCurrentWindow();
        setAppWindow(window);
        console.log('✅ Window reference stored successfully');
      } catch (error) {
        console.error('❌ Error getting window reference:', error);
      }
    }
    fetchWindow();
  }, []);

  // Setup drag functionality using JavaScript API
  useEffect(() => {
    if (!appWindow || !dragAreaRef.current) return;

    const dragArea = dragAreaRef.current;

    const handleMouseDown = async (e: MouseEvent) => {
      // Ignore if clicking on interactive elements
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('input')) {
        return;
      }

      console.log('🎯 Mouse down on drag area, starting drag...');
      
      try {
        await appWindow.startDragging();
        console.log('✅ Drag started successfully');
      } catch (error) {
        console.error('❌ Error starting drag:', error);
      }
    };

    dragArea.addEventListener('mousedown', handleMouseDown);

    return () => {
      dragArea.removeEventListener('mousedown', handleMouseDown);
    };
  }, [appWindow]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isRecording) {
        stopAllStreams();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      }
    };
  }, [isRecording]);

  // Timer effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording && !isPaused) {
      interval = setInterval(() => {
        setTime(prevTime => prevTime + 0.01);
      }, 10);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  // Dark mode detection from system
  useEffect(() => {
    const checkDarkMode = () => {
      const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setIsDarkMode(darkModeQuery.matches);
    };
    
    checkDarkMode();
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    darkModeQuery.addEventListener('change', checkDarkMode);
    
    return () => darkModeQuery.removeEventListener('change', checkDarkMode);
  }, []);

  const handleRecord = async () => {
    if (!isRecording) {
      setTime(0);
      await startRecordingWithGuide();
    }
  };

  const handlePause = () => {
    if (isRecording && !isPaused && mediaRecorderRef.current) {
      setIsPaused(true);
      mediaRecorderRef.current.pause();
      console.log('⏸️ Paused');
    }
  };

  const handleResume = () => {
    if (isRecording && isPaused && mediaRecorderRef.current) {
      setIsPaused(false);
      mediaRecorderRef.current.resume();
      console.log('▶️ Resumed');
    }
  };

  const handleStop = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    stopAllStreams();
    setIsRecording(false);
    setIsPaused(false);
    setTime(0);
  };

  const handleFinish = async () => {
    console.log('🔴 FINISH BUTTON CLICKED');
    
    if (isRecording) {
      handleStop();
    }
    
    // Close window
    if (appWindow) {
      console.log('✅ Using stored window reference to close...');
      appWindow.close().then(() => {
        console.log('✅ Window close promise resolved');
      }).catch((error) => {
        console.error('❌ Window close promise rejected:', error);
      });
    } else {
      console.log('⚠️ No stored window reference, trying getCurrentWindow...');
      try {
        const currentWindow = getCurrentWindow();
        console.log('✅ Got current window, calling close...');
        currentWindow.close().then(() => {
          console.log('✅ Window close promise resolved');
        }).catch((error) => {
          console.error('❌ Window close promise rejected:', error);
        });
      } catch (error) {
        console.error('❌ Error getting current window:', error);
      }
    }
  };

  const handleSettings = () => {
    console.log('Settings clicked');
    // TODO: Implement settings functionality
  };

  const handleSparkles = () => {
    console.log('AI Enhancement clicked');
    // TODO: Implement AI enhancement functionality
  };

  const handleMaximize = () => {
    console.log('Maximize clicked');
    // TODO: Implement maximize functionality
  };

  return (
    <div 
      className="w-full h-full flex items-center justify-center"
      style={{ background: 'transparent' }}
    >
      <div 
        ref={dragAreaRef}
        data-tauri-drag-region
        className={`
          flex items-center justify-between px-8 py-4 rounded-full
          backdrop-blur-md border shadow-xl
          ${isDarkMode 
            ? 'bg-black/80 border-gray-700 text-white' 
            : 'bg-white/90 border-gray-200 text-gray-900'
          }
          transition-all duration-300 ease-in-out
          w-[720px] h-15 mx-4
        `}
        style={{ 
          cursor: 'move'
        }}
      >
        {/* Left Section - Record/Pause Button */}
        <div className="flex items-center space-x-2 ml-2">
          <button
            onClick={handleRecord}
            className={`
              px-1.5 py-1 rounded font-medium text-xs no-drag ml-1
              transition-all duration-200 hover:scale-105 active:scale-95
              ${!isRecording
                ? (isDarkMode ? 'text-green-400 hover:text-green-300' : 'text-green-600 hover:text-green-500')
                : (isDarkMode ? 'text-gray-400' : 'text-gray-500')
              }
            `}
            style={{ 
              borderRadius: '4px', 
              background: 'transparent',
              // @ts-ignore
              WebkitAppRegion: 'no-drag',
              appRegion: 'no-drag'
            }}
            disabled={isRecording}
          >
            RECORD
          </button>

          {isRecording && isPaused && (
            <button
              onClick={handleResume}
              className={`
                p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
                ${isDarkMode
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : 'bg-green-500 hover:bg-green-600 text-white'
                }
              `}
              title="Resume"
            >
              <Play className="w-3 h-3" />
            </button>
          )}

          {isRecording && !isPaused && (
            <button
              onClick={handlePause}
              className={`
                p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
                ${isDarkMode
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-white'
                }
              `}
              title="Pause"
            >
              <Pause className="w-3 h-3" />
            </button>
          )}

          {isRecording && (
            <button
              onClick={handleStop}
              className={`
                p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
                ${isDarkMode
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-red-500 hover:bg-red-600 text-white'
                }
              `}
              title="Stop"
            >
              <Square className="w-3 h-3" />
            </button>
          )}

          <button
            onClick={handleSettings}
            className={`
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            title="Settings"
          >
            <Settings className="w-3 h-3" />
          </button>
        </div>

        {/* Center Section - Timer */}
        <div className={`
          px-6 py-2 rounded-full font-mono text-lg font-semibold
          ${isDarkMode 
            ? 'bg-gray-800/80 text-green-400' 
            : 'bg-gray-100 text-gray-900'
          }
          transition-all duration-300
        `}>
          {formatTime(time)}
        </div>

        {/* Right Section - Action Buttons */}
        <div className="flex items-center space-x-2 mr-2">
          <button
            onClick={handleMaximize}
            className={`
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            title="Maximize"
          >
            <Maximize2 className="w-3 h-3" />
          </button>

          <button
            onClick={handleSparkles}
            className={`
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode
                ? 'bg-purple-700 hover:bg-purple-600 text-white'
                : 'bg-purple-200 hover:bg-purple-300 text-purple-700'
              }
            `}
            title="AI Enhancement"
          >
            <Sparkles className="w-3 h-3" />
          </button>

          <button
            onClick={(e) => {
              console.log('🟡 FINISH button onClick fired!', e.type);
              e.preventDefault();
              e.stopPropagation();
              handleFinish();
            }}
            onMouseDown={(e) => {
              console.log('🟡 FINISH button onMouseDown fired!');
              e.preventDefault();
            }}
            onPointerDown={() => {
              console.log('🟡 FINISH button onPointerDown fired!');
            }}
            className={`
              px-1.5 py-1 font-medium text-xs no-drag mr-1
              transition-all duration-200 hover:scale-105 active:scale-95
              ${isDarkMode
                ? 'text-red-400 hover:text-red-300'
                : 'text-red-600 hover:text-red-500'
              }
            `}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              borderRadius: '4px',
              background: 'transparent'
            }}
          >
            FINISH
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecordingPopupApp;