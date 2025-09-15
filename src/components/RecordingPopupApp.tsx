import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Mic, Settings, Maximize, Star } from 'lucide-react';

declare global {
  interface CSSStyleDeclaration {
    webkitAppRegion?: string;
  }
}

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Timer logic
  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isRecording && !isPaused) {
      interval = setInterval(() => {
        setTime(prevTime => {
          const newSeconds = prevTime.seconds + 1;
          const newMinutes = prevTime.minutes + Math.floor(newSeconds / 60);
          const newHours = prevTime.hours + Math.floor(newMinutes / 60);
          
          return {
            hours: newHours,
            minutes: newMinutes % 60,
            seconds: newSeconds % 60,
          };
        });
      }, 1000);
    }
    
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  // Check for theme from parent window or system
  useEffect(() => {
    const checkTheme = () => {
      const isDark = document.documentElement.classList.contains('dark') || 
                     window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDarkMode(isDark);
    };
    
    checkTheme();
    
    // Listen for theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', checkTheme);
    
    return () => mediaQuery.removeEventListener('change', checkTheme);
  }, []);

  const handleRecord = () => {
    if (!isRecording) {
      setIsRecording(true);
      setIsPaused(false);
    } else {
      setIsPaused(!isPaused);
    }
  };

  const handleStop = () => {
    setIsRecording(false);
    setIsPaused(false);
    setTime({ hours: 0, minutes: 0, seconds: 0 });
  };

  const formatTime = (value: number) => value.toString().padStart(2, '0');

  return (
    <div 
      className={`w-full h-full flex items-center justify-center ${isDarkMode ? 'dark' : ''}`}
      style={{
        background: 'transparent',
      }}
    >
      {/* Main recording bar - wider and more horizontal */}
      <div 
        className="flex items-center justify-between px-4 py-2 rounded-full shadow-2xl border backdrop-blur-md drag-region"
        style={{
          background: isDarkMode 
            ? 'rgba(17, 17, 17, 0.95)' 
            : 'rgba(255, 255, 255, 0.95)',
          border: isDarkMode 
            ? '1px solid rgba(255, 255, 255, 0.1)' 
            : '1px solid rgba(0, 0, 0, 0.1)',
          minWidth: '600px',
          height: '50px',
        }}
      >
        {/* Left section - Record button */}
        <div className="flex items-center gap-3 no-drag">
          <Button
            onClick={handleRecord}
            size="sm"
            className={`rounded-full px-4 py-2 font-medium transition-all ${
              isRecording
                ? isPaused
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-red-500 hover:bg-red-600 text-white'
            }`}
          >
            {isRecording ? (isPaused ? 'RESUME' : 'PAUSE') : 'RECORD'}
          </Button>

          {/* Pause/Play icon */}
          <Button
            onClick={handleRecord}
            size="sm"
            variant="ghost"
            className={`w-8 h-8 rounded-full p-0 ${
              isDarkMode 
                ? 'hover:bg-white/10 text-white' 
                : 'hover:bg-black/10 text-black'
            }`}
          >
            {isRecording && !isPaused ? (
              <div className="w-3 h-3 bg-current rounded-sm flex gap-0.5">
                <div className="w-1 h-full bg-current"></div>
                <div className="w-1 h-full bg-current"></div>
              </div>
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </Button>
        </div>

        {/* Center section - Timer */}
        <div 
          className={`px-4 py-1 rounded-full font-mono text-sm font-medium ${
            isDarkMode 
              ? 'bg-black/30 text-white' 
              : 'bg-white/50 text-black'
          }`}
        >
          {formatTime(time.hours)}:{formatTime(time.minutes)}:{formatTime(time.seconds)}
        </div>

        {/* Right section - Controls */}
        <div className="flex items-center gap-2 no-drag">
          <Button
            size="sm"
            variant="ghost"
            className={`w-8 h-8 rounded-full p-0 ${
              isDarkMode 
                ? 'hover:bg-white/10 text-white' 
                : 'hover:bg-black/10 text-black'
            }`}
          >
            <Settings className="w-4 h-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className={`w-8 h-8 rounded-full p-0 ${
              isDarkMode 
                ? 'hover:bg-white/10 text-white' 
                : 'hover:bg-black/10 text-black'
            }`}
          >
            <Maximize className="w-4 h-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className={`w-8 h-8 rounded-full p-0 ${
              isDarkMode 
                ? 'hover:bg-white/10 text-white' 
                : 'hover:bg-black/10 text-black'
            }`}
          >
            <Star className="w-4 h-4" />
          </Button>

          <Button
            onClick={handleStop}
            size="sm"
            className="rounded-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium"
          >
            FINISH
          </Button>
        </div>
      </div>
    </div>
  );
};

export default RecordingPopupApp;