import React, { useState, useEffect } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Settings, Sparkles, Square, Circle } from 'lucide-react';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Get theme from main window
  useEffect(() => {
    const checkTheme = () => {
      const isDark = document.documentElement.classList.contains('dark') || 
                    window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDarkMode(isDark);
    };
    
    checkTheme();
    
    // Listen for theme changes
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
    
    return () => observer.disconnect();
  }, []);

  // Timer logic
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording && !isPaused) {
      interval = setInterval(() => {
        setTime(prevTime => prevTime + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleRecord = () => {
    if (!isRecording) {
      setIsRecording(true);
      setIsPaused(false);
      setTime(0);
    }
  };

  const handlePause = () => {
    setIsPaused(!isPaused);
  };

  const handleStop = () => {
    setIsRecording(false);
    setIsPaused(false);
    setTime(0);
  };

  const handleFinish = async () => {
    console.log('Recording finished');
    handleStop();
    
    // Close the popup window
    try {
      const webview = WebviewWindow.getCurrent();
      await webview.close();
    } catch (error) {
      console.error('Error closing window:', error);
    }
  };

  const handleSettings = () => {
    console.log('Settings clicked');
  };

  const handleSparkles = () => {
    console.log('AI Enhancement clicked');
  };

  return (
    <div 
      className={`${isDarkMode ? 'dark' : ''}`}
      style={{ 
        background: 'transparent',
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        overflow: 'hidden'
      }}
    >
      <div 
        data-tauri-drag-region
        className="flex items-center justify-between px-4 py-2 select-none cursor-move"
        style={{
          background: isDarkMode 
            ? 'rgba(0, 0, 0, 0.8)' 
            : 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(10px)',
          borderRadius: '24px',
          border: isDarkMode 
            ? '1px solid rgba(255, 255, 255, 0.1)' 
            : '1px solid rgba(0, 0, 0, 0.1)',
          boxShadow: isDarkMode 
            ? '0 8px 32px rgba(0, 0, 0, 0.3)' 
            : '0 8px 32px rgba(0, 0, 0, 0.1)',
          width: 'fit-content',
          margin: '8px auto',
          minWidth: '600px',
          height: '60px'
        }}
      >
        {/* Left Section - Record/Pause Button */}
        <div className="flex items-center gap-3">
          {!isRecording ? (
            <button
              onClick={handleRecord}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                isDarkMode
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-red-500 hover:bg-red-600 text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <Circle className="w-3 h-3 fill-current" />
                RECORD
              </div>
            </button>
          ) : (
            <button
              onClick={handlePause}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                isPaused
                  ? isDarkMode
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-green-500 hover:bg-green-600 text-white'
                  : isDarkMode
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                {isPaused ? (
                  <>
                    <Circle className="w-3 h-3 fill-current" />
                    RESUME
                  </>
                ) : (
                  <>
                    <Square className="w-3 h-3 fill-current" />
                    PAUSE
                  </>
                )}
              </div>
            </button>
          )}
        </div>

        {/* Center Section - Timer */}
        <div 
          className={`px-6 py-2 rounded-full text-lg font-mono font-bold ${
            isDarkMode 
              ? 'bg-gray-800 text-white' 
              : 'bg-gray-100 text-gray-900'
          }`}
        >
          00:{formatTime(time)}
        </div>

        {/* Right Section - Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Settings Button */}
          <button
            onClick={handleSettings}
            className={`p-2 rounded-full transition-all duration-200 ${
              isDarkMode
                ? 'hover:bg-gray-700 text-gray-300 hover:text-white'
                : 'hover:bg-gray-200 text-gray-600 hover:text-gray-900'
            }`}
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* AI Enhancement Button */}
          <button
            onClick={handleSparkles}
            className={`p-2 rounded-full transition-all duration-200 ${
              isDarkMode
                ? 'hover:bg-purple-700 text-purple-300 hover:text-white'
                : 'hover:bg-purple-200 text-purple-600 hover:text-purple-900'
            }`}
            title="AI Enhancement"
          >
            <Sparkles className="w-4 h-4" />
          </button>

          {/* Finish Button */}
          <button
            onClick={handleFinish}
            className={`px-6 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              isDarkMode
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-red-500 hover:bg-red-600 text-white'
            }`}
          >
            FINISH
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecordingPopupApp;