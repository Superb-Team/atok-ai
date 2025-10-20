import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Pause, Square, Settings, Sparkles, Maximize2 } from 'lucide-react';

const RecordingPopupApp: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);

  // Format time as MM:SS:MS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${ms.toString().padStart(2, '0')}`;
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
      try {
        const { recordingService } = await import('@/services/recording.service');
        const outputPath = await recordingService.startRecording();

        setIsRecording(true);
        setIsPaused(false);
        setTime(0);

        console.log('✅ Recording started:', outputPath);
      } catch (error) {
        console.error('❌ Failed to start recording:', error);
        alert(`Failed to start recording: ${error}`);
      }
    }
  };

  const handlePause = () => {
    if (isRecording && !isPaused) {
      setIsPaused(true);
      // Note: Pause functionality would need backend support
      console.log('⏸️ Pause requested (not yet implemented in backend)');
    }
  };

  const handleStop = async () => {
    if (isRecording) {
      try {
        const { recordingService } = await import('@/services/recording.service');
        const savedPath = await recordingService.stopRecording();

        setIsRecording(false);
        setIsPaused(false);
        setTime(0);

        console.log('✅ Recording stopped:', savedPath);

        // Start processing workflow
        await processRecording(savedPath);
      } catch (error) {
        console.error('❌ Failed to stop recording:', error);
        alert(`Failed to stop recording: ${error}`);
      }
    }
  };

  const processRecording = async (audioPath: string) => {
    console.log('🎙️ Starting audio processing workflow...');
    console.log('📁 Audio path:', audioPath);

    try {
      // Step 1: Read audio file using Tauri invoke
      console.log('📖 Step 1: Reading audio file...');
      const { invoke } = await import('@tauri-apps/api/core');
      
      // Read file as base64
      const base64Data = await invoke<string>('read_audio_file', { path: audioPath });
      console.log('✅ Audio file read, converting to blob...');
      
      // Convert base64 to blob
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
      const audioFile = new File([audioBlob], 'recording.mp3', { type: 'audio/mpeg' });
      console.log('✅ Audio file loaded:', audioFile.size, 'bytes');

      // Step 2: Transcribe and enhance
      console.log('🤖 Step 2: Transcribing and enhancing...');
      const { agentService } = await import('@/services/agent.service');

      const enhancedText = await Promise.race([
        agentService.transcribeAndEnhance(audioFile, 'voice recording'),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Transcription timeout after 60s')), 60000)
        )
      ]);

      console.log('✅ Transcription completed:', enhancedText.substring(0, 100) + '...');

      // Step 3: Get user info
      console.log('👤 Step 3: Getting user info...');
      const { authService } = await import('@/services/auth.service');
      const user = authService.getUser();

      if (!user) {
        throw new Error('User not authenticated');
      }
      console.log('✅ User:', user.id);

      // Step 4: Save to notes
      console.log('📝 Step 4: Saving to notes...');
      const { noteService } = await import('@/services/note.service');
      const currentDate = new Date().toISOString().split('T')[0];
      const noteTitle = `Voice Recording - ${currentDate}`;

      const newNote = {
        title: noteTitle,
        content: enhancedText,
        tags: ['voice-recording', 'transcription'],
        color: '#E0F2FE', // Light blue
        is_favorite: false,
      };

      await noteService.createNote(user.id, newNote);

      console.log('✅ Note created successfully');

      // Step 5: Insert to OpenSearch RAG
      console.log('🔍 Step 5: Inserting to RAG...');
      await agentService.insertDocument(user.id, enhancedText, {
        type: 'voice_recording',
        date: currentDate,
        source: 'audio_transcription',
      });
      console.log('✅ Document inserted to RAG');

      // Success notification
      console.log('🎉 Workflow completed successfully!');
      alert(`✅ Recording processed successfully!\n\n📝 Note created: "${noteTitle}"\n🔍 Added to knowledge base for AI search`);

    } catch (error) {
      console.error('❌ Failed to process recording:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`Failed to process recording:\n${errorMessage}`);
    }
  };


  const handleFinish = async () => {
    console.log('🔴 FINISH BUTTON CLICKED - Starting close process');

    let savedPath: string | null = null;

    // Stop recording first if it's active
    if (isRecording) {
      console.log('⏹️ Stopping recording before closing...');
      try {
        const { recordingService } = await import('@/services/recording.service');
        savedPath = await recordingService.stopRecording();
        console.log('✅ Recording stopped successfully:', savedPath);

        setIsRecording(false);
        setIsPaused(false);
        setTime(0);
      } catch (error) {
        console.error('❌ Failed to stop recording:', error);
      }
    }

    // Process recording if we have a saved path
    if (savedPath) {
      console.log('🎙️ Processing recording before closing...');
      try {
        await processRecording(savedPath);
      } catch (error) {
        console.error('❌ Failed to process recording:', error);
        // Continue to close even if processing fails
      }
    }

    // Wait a bit for processing to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Close window
    console.log('🚪 Closing window...');
    if (appWindow) {
      console.log('✅ Using stored window reference to close...');
      try {
        await appWindow.close();
        console.log('✅ Window closed successfully');
      } catch (error) {
        console.error('❌ Window close error:', error);
      }
    } else {
      console.log('⚠️ No stored window reference, trying getCurrentWindow...');
      try {
        const currentWindow = getCurrentWindow();
        console.log('✅ Got current window, calling close...');
        await currentWindow.close();
        console.log('✅ Window closed successfully');
      } catch (error) {
        console.error('❌ Error closing window:', error);
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
          cursor: 'move',
          WebkitAppRegion: 'drag',
          // @ts-ignore
          appRegion: 'drag'
        }}
      >
        {/* Left Section - Record/Pause Button */}
        <div className="flex items-center space-x-2 ml-2">
          <button
            onClick={handleRecord}
            className={`
              px-1.5 py-1 rounded font-medium text-xs ml-1
              transition-all duration-200 hover:scale-105 active:scale-95
              ${!isRecording
                ? (isDarkMode ? 'text-green-400 hover:text-green-300' : 'text-green-600 hover:text-green-500')
                : (isDarkMode ? 'text-gray-400' : 'text-gray-500')
              }
            `}
            style={{
              borderRadius: '4px',
              background: 'transparent',
              WebkitAppRegion: 'no-drag',
              // @ts-ignore
              appRegion: 'no-drag',
              pointerEvents: 'auto',
              cursor: isRecording ? 'not-allowed' : 'pointer',
              zIndex: 9999,
              position: 'relative'
            }}
            disabled={isRecording}
          >
            RECORD
          </button>

          {isRecording && !isPaused && (
            <button
              onClick={handlePause}
              className={`
                p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95
                ${isDarkMode
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-white'
                }
              `}
              style={{
                WebkitAppRegion: 'no-drag',
                // @ts-ignore
                appRegion: 'no-drag',
                pointerEvents: 'auto',
                cursor: 'pointer',
                zIndex: 9999,
                position: 'relative'
              }}
              title="Pause"
            >
              <Pause className="w-3 h-3" />
            </button>
          )}

          {isRecording && (
            <button
              onClick={handleStop}
              className={`
                p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95
                ${isDarkMode
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-red-500 hover:bg-red-600 text-white'
                }
              `}
              style={{
                WebkitAppRegion: 'no-drag',
                // @ts-ignore
                appRegion: 'no-drag',
                pointerEvents: 'auto',
                cursor: 'pointer',
                zIndex: 9999,
                position: 'relative'
              }}
              title="Stop"
            >
              <Square className="w-3 h-3" />
            </button>
          )}

          <button
            onClick={handleSettings}
            className={`
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95
              ${isDarkMode
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            style={{
              WebkitAppRegion: 'no-drag',
              // @ts-ignore
              appRegion: 'no-drag',
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 9999,
              position: 'relative'
            }}
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
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95
              ${isDarkMode
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }
            `}
            style={{
              WebkitAppRegion: 'no-drag',
              // @ts-ignore
              appRegion: 'no-drag',
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 9999,
              position: 'relative'
            }}
            title="Maximize"
          >
            <Maximize2 className="w-3 h-3" />
          </button>

          <button
            onClick={handleSparkles}
            className={`
              p-1.5 rounded-full transition-all duration-200 hover:scale-105 active:scale-95
              ${isDarkMode
                ? 'bg-purple-700 hover:bg-purple-600 text-white'
                : 'bg-purple-200 hover:bg-purple-300 text-purple-700'
              }
            `}
            style={{
              WebkitAppRegion: 'no-drag',
              // @ts-ignore
              appRegion: 'no-drag',
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 9999,
              position: 'relative'
            }}
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
              e.stopPropagation();
            }}
            className={`
              px-1.5 py-1 font-medium text-xs mr-1
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
              background: 'transparent',
              WebkitAppRegion: 'no-drag',
              // @ts-ignore
              appRegion: 'no-drag',
              zIndex: 9999,
              position: 'relative'
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