import React, { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Play, Pause, Square, Settings, Sparkles, Maximize2, RotateCw } from 'lucide-react';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Format time as MM:SS:MS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
  };

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

  const handleRecord = () => {
    if (!isRecording) {
      setIsRecording(true);
      setIsPaused(false);
      setTime(0);
    } else if (isPaused) {
      setIsPaused(false);
    } else {
      setIsPaused(true);
    }
  };

  const handleStop = () => {
    setIsRecording(false);
    setIsPaused(false);
    setTime(0);
  };

  const handleFinish = async () => {
    try {
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error('Failed to close window:', error);
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

  const handleRotate = () => {
    console.log('Rotate view clicked');
    // TODO: Implement rotate functionality
  };

  return (
    <div 
      className="w-full h-full flex items-center justify-center drag-region"
      style={{ background: 'transparent' }}
    >
      <div 
        className={`
          flex items-center justify-between px-6 py-3 rounded-full
          backdrop-blur-md border shadow-xl
          ${isDarkMode 
            ? 'bg-black/80 border-gray-700 text-white' 
            : 'bg-white/90 border-gray-200 text-gray-900'
          }
          transition-all duration-300 ease-in-out
          w-[720px] h-16
        `}
      >
        {/* Left Section - Record/Pause Button */}
        <div className="flex items-center space-x-3">
          <button
            onClick={handleRecord}
            className={`
              flex items-center space-x-2 px-4 py-2 rounded-full font-medium text-sm no-drag
              transition-all duration-200 hover:scale-105 active:scale-95
              ${isRecording && !isPaused
                ? (isDarkMode ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-red-500 hover:bg-red-600 text-white')
                : (isDarkMode ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-800')
              }
            `}
          >
            {isRecording && !isPaused ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>PAUSE</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>RECORD</span>
              </>
            )}
          </button>

          <button
            onClick={handleStop}
            className={`
              p-2 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode 
                ? 'bg-gray-700 hover:bg-gray-600 text-white' 
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
          >
            <Square className="w-3.5 h-3.5" />
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
        <div className="flex items-center space-x-2">
          <button
            onClick={handleSettings}
            className={`
              p-2 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode 
                ? 'bg-gray-700 hover:bg-gray-600 text-white' 
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleSparkles}
            className={`
              p-2 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode 
                ? 'bg-purple-700 hover:bg-purple-600 text-white' 
                : 'bg-purple-200 hover:bg-purple-300 text-purple-700'
              }
            `}
            title="AI Enhancement"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleMaximize}
            className={`
              p-2 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode 
                ? 'bg-gray-700 hover:bg-gray-600 text-white' 
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            title="Maximize"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleRotate}
            className={`
              p-2 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 no-drag
              ${isDarkMode 
                ? 'bg-gray-700 hover:bg-gray-600 text-white' 
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            title="Rotate View"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleFinish}
            className={`
              px-4 py-2 rounded-full font-medium text-sm no-drag
              transition-all duration-200 hover:scale-105 active:scale-95
              ${isDarkMode 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-red-500 hover:bg-red-600 text-white'
              }
            `}
          >
            FINISH
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecordingPopupApp;