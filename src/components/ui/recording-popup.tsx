"use client";

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { X, Play, Pause, Settings, Maximize2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface RecordingPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

const RecordingPopup: React.FC<RecordingPopupProps> = ({ isOpen, onClose }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [time, setTime] = useState({ minutes: 0, seconds: 0, milliseconds: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Timer logic
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      interval = setInterval(() => {
        setTime((prevTime) => {
          let newMilliseconds = prevTime.milliseconds + 1;
          let newSeconds = prevTime.seconds;
          let newMinutes = prevTime.minutes;

          if (newMilliseconds >= 100) {
            newMilliseconds = 0;
            newSeconds += 1;
          }

          if (newSeconds >= 60) {
            newSeconds = 0;
            newMinutes += 1;
          }

          return {
            minutes: newMinutes,
            seconds: newSeconds,
            milliseconds: newMilliseconds,
          };
        });
      }, 10);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  // ESC key support
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const toggleRecording = () => {
    setIsRecording(!isRecording);
  };

  const handleFinish = () => {
    setIsRecording(false);
    setTime({ minutes: 0, seconds: 0, milliseconds: 0 });
    onClose();
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const formatTime = (value: number) => {
    return value.toString().padStart(2, '0');
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
            onClick={onClose}
          />
          
          {/* Popup */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{
              type: "spring",
              duration: 0.3,
              stiffness: 300,
              damping: 25,
            }}
            className={cn(
              "fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50",
              "bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl border border-neutral-200 dark:border-neutral-700",
              isFullscreen ? "w-full h-full rounded-none" : "w-[600px] max-w-[90vw]"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Recording Session
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleFullscreen}
                  className="w-8 h-8 p-0"
                >
                  <Maximize2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  className="w-8 h-8 p-0"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Main Content */}
            <div className="p-8">
              {/* Timer Display */}
              <div className="text-center mb-8">
                <div className="text-6xl font-mono font-bold text-neutral-800 dark:text-neutral-200 mb-2">
                  {formatTime(time.minutes)}:{formatTime(time.seconds)}:{formatTime(time.milliseconds)}
                </div>
                <div className="text-sm text-neutral-500 dark:text-neutral-400">
                  {isRecording ? "Recording in progress..." : "Ready to record"}
                </div>
              </div>

              {/* Control Buttons */}
              <div className="flex items-center justify-center gap-4 mb-8">
                {/* Record/Pause Button */}
                <Button
                  onClick={toggleRecording}
                  className={cn(
                    "w-16 h-16 rounded-full text-white shadow-lg transition-all duration-200",
                    isRecording 
                      ? "bg-red-500 hover:bg-red-600" 
                      : "bg-gray-600 hover:bg-gray-700"
                  )}
                >
                  {isRecording ? (
                    <Pause className="w-6 h-6" />
                  ) : (
                    <Play className="w-6 h-6 ml-1" />
                  )}
                </Button>

                {/* Settings Button */}
                <Button
                  variant="outline"
                  size="lg"
                  className="w-12 h-12 rounded-full"
                >
                  <Settings className="w-5 h-5" />
                </Button>

                {/* AI Enhancement Button */}
                <Button
                  variant="outline"
                  size="lg"
                  className="w-12 h-12 rounded-full"
                >
                  <Sparkles className="w-5 h-5" />
                </Button>
              </div>

              {/* Status and Actions */}
              <div className="space-y-4">
                {/* Recording Status */}
                <div className="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={cn(
                        "w-2 h-2 rounded-full",
                        isRecording ? "bg-red-500 animate-pulse" : "bg-gray-400"
                      )}></div>
                      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        {isRecording ? "Recording" : "Standby"}
                      </span>
                    </div>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      Audio: {isRecording ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>

                {/* Finish Button */}
                <Button
                  onClick={handleFinish}
                  className="w-full bg-red-600 hover:bg-red-700 text-white font-medium py-3"
                  disabled={!isRecording && time.minutes === 0 && time.seconds === 0}
                >
                  FINISH
                </Button>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded-b-2xl">
              <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                <span>Atok.ai Recording Studio</span>
                <span>Press ESC to close</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default RecordingPopup;