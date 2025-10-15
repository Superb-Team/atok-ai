import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Pause, Square, Settings, Sparkles, Maximize2, Play } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);
  
  // Recording state
  const recordingPathRef = useRef<string | null>(null);

  // Format time as MM:SS:MS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
  };

  // Start WASAPI Loopback recording - Desktop Audio (Windows)!
  const startDesktopRecording = async () => {
    try {
      console.log('� Starting Desktop Audio recording (WASAPI Loopback)...');
      
      // Generate filename with timestamp  
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `desktop-audio-${timestamp}.wav`;
      
      // Get Downloads folder path
      const downloadsPath = await downloadDir();
      console.log('📁 Downloads folder:', downloadsPath);
      
      // Build full path
      const separator = downloadsPath.endsWith('\\') || downloadsPath.endsWith('/') ? '' : '\\';
      const fullPath = `${downloadsPath}${separator}${filename}`;
      
      console.log('📁 Full path:', fullPath);
      
      // Call Windows WASAPI Loopback recording
      const result = await invoke('start_desktop_recording', { outputPath: fullPath });
      console.log('🎤 Rust response:', result);
      
      recordingPathRef.current = fullPath;
      setIsRecording(true);
      setIsPaused(false);
      setTime(0);
      
      console.log('✅ Desktop audio recording started!');
      alert(`Recording Desktop Audio!\nSemua suara dari speaker/headphone akan direkam\nFile: ${filename}`);
      
    } catch (error) {
      console.error('❌ Error starting recording:', error);
      alert('Gagal memulai recording: ' + error);
      setIsRecording(false);
    }
  };

  // Stop desktop recording
  const stopDesktopRecording = async () => {
    try {
      console.log('⏹️ Stopping desktop recording...');
      
      const result = await invoke('stop_desktop_recording');
      console.log('🎤 Stop result:', result);
      
      console.log('✅ Recording stopped!');
      console.log('📁 File saved:', result);
      
      alert(`Recording selesai!\nDesktop audio WAV file disimpan di:\n${result}`);
      
      // Show success notification
      const notification = document.createElement('div');
      notification.style.cssText = `
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
      notification.textContent = `✅ Saved: ${recordingPathRef.current?.split('\\').pop()}`;
      document.body.appendChild(notification);
      
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 3000);
      
      recordingPathRef.current = null;
      setIsRecording(false);
      setIsPaused(false);
      setTime(0);
      
    } catch (error) {
      console.error('❌ Error stopping recording:', error);
      alert('Gagal menghentikan recording: ' + error);
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

  // Cleanup on unmount - Desktop Audio
  useEffect(() => {
    return () => {
      if (isRecording) {
        console.log('🧹 Cleanup: stopping recording...');
        invoke('stop_desktop_recording').catch(console.error);
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

  // Button handlers - Desktop Audio (WASAPI Loopback)
  const handleRecord = async () => {
    if (!isRecording) {
      await startDesktopRecording();
    }
  };

  const handlePause = () => {
    console.log('⚠️ Pause not supported in WASAPI Loopback');
  };

  const handleResume = () => {
    console.log('⚠️ Resume not supported in WASAPI Loopback');
  };

  const handleStop = async () => {
    if (isRecording) {
      await stopDesktopRecording();
    }
  };

  const handleFinish = async () => {
    console.log('🔴 FINISH BUTTON CLICKED');
    
    if (isRecording) {
      await handleStop();
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