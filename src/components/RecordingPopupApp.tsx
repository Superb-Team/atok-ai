import React, { useState, useEffect } from 'react';
import { Play, Pause, Settings, Maximize2, Star } from 'lucide-react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);

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
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${hours.toString().padStart(2, '0')} : ${minutes.toString().padStart(2, '0')} : ${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const handleRecord = () => {
    if (!isRecording) {
      setIsRecording(true);
      setIsPaused(false);
    } else {
      setIsPaused(!isPaused);
    }
  };

  const handleSettings = () => {
    console.log('Settings clicked');
  };

  const handleFullscreen = () => {
    console.log('Fullscreen clicked');
  };

  const handleStar = () => {
    console.log('Star clicked');
  };

  const handleFinish = async () => {
    setIsRecording(false);
    setIsPaused(false);
    setTime(0);
    
    // Close the popup window
    try {
      const webview = WebviewWindow.getCurrent();
      await webview.close();
    } catch (error) {
      console.error('Error closing window:', error);
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-transparent">
      <div className="bg-black/90 backdrop-blur-sm rounded-full px-6 py-3 flex items-center gap-4 shadow-2xl border border-gray-700/50">
        {/* Record Button */}
        <button
          onClick={handleRecord}
          className={`px-4 py-2 rounded-full font-medium text-sm transition-all ${
            isRecording
              ? isPaused
                ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                : 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-red-600 hover:bg-red-700 text-white'
          }`}
        >
          {isRecording ? (isPaused ? 'RESUME' : 'RECORDING') : 'RECORD'}
        </button>

        {/* Pause Button (only show when recording) */}
        {isRecording && (
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded-full transition-colors"
          >
            {isPaused ? (
              <Play className="w-4 h-4 text-white" />
            ) : (
              <Pause className="w-4 h-4 text-white" />
            )}
          </button>
        )}

        {/* Settings Button */}
        <button
          onClick={handleSettings}
          className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded-full transition-colors"
        >
          <Settings className="w-4 h-4 text-white" />
        </button>

        {/* Timer Display */}
        <div className="bg-gray-800 px-4 py-2 rounded-full">
          <span className="text-white font-mono text-sm">
            {formatTime(time)}
          </span>
        </div>

        {/* Fullscreen Button */}
        <button
          onClick={handleFullscreen}
          className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded-full transition-colors"
        >
          <Maximize2 className="w-4 h-4 text-white" />
        </button>

        {/* Star Button */}
        <button
          onClick={handleStar}
          className="w-8 h-8 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded-full transition-colors"
        >
          <Star className="w-4 h-4 text-white" />
        </button>

        {/* Finish Button */}
        <button
          onClick={handleFinish}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-medium text-sm transition-colors"
        >
          FINISH
        </button>
      </div>
    </div>
  );
};

export default RecordingPopupApp;