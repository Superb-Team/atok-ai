import { useState } from 'react';
import { agentService } from '@/services/agent.service';

export default function TestTranscribePage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setResult('');
      setError('');
    }
  };

  const handleTest = async () => {
    if (!file) {
      setError('Please select a file first');
      return;
    }

    setLoading(true);
    setError('');
    setResult('');

    try {
      console.log('🎤 Testing transcription...');
      console.log('📁 File:', file.name, file.size, file.type);

      const enhancedText = await agentService.transcribeAndEnhance(file, 'test recording');
      
      console.log('✅ Success!');
      console.log('Result length:', enhancedText.length);
      
      setResult(enhancedText);
    } catch (err) {
      console.error('❌ Error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-900 dark:to-neutral-950">
      {/* Header */}
      <div className="px-8 py-6 border-b border-neutral-200/50 dark:border-neutral-700/50 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-white">
            🎤 Test Transcribe API
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-2">
            Test the transcription API endpoint
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* File Input */}
          <div className="bg-white dark:bg-neutral-800 rounded-xl p-6 shadow-sm border border-neutral-200 dark:border-neutral-700">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              Select Audio File
            </label>
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              className="block w-full text-sm text-neutral-500 dark:text-neutral-400
                file:mr-4 file:py-2 file:px-4
                file:rounded-lg file:border-0
                file:text-sm file:font-semibold
                file:bg-blue-50 file:text-blue-700
                hover:file:bg-blue-100
                dark:file:bg-blue-900 dark:file:text-blue-300
                dark:hover:file:bg-blue-800"
            />
            {file && (
              <div className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
                <p>📁 File: {file.name}</p>
                <p>📊 Size: {(file.size / 1024 / 1024).toFixed(2)} MB</p>
                <p>🎵 Type: {file.type}</p>
              </div>
            )}
          </div>

          {/* Test Button */}
          <button
            onClick={handleTest}
            disabled={!file || loading}
            className="w-full py-3 px-6 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-400 
              text-white font-semibold rounded-lg transition-colors disabled:cursor-not-allowed"
          >
            {loading ? '⏳ Testing...' : '🚀 Test Transcribe'}
          </button>

          {/* Error */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 
              rounded-lg p-4 text-red-600 dark:text-red-400">
              <p className="font-semibold">❌ Error:</p>
              <p className="mt-1 text-sm">{error}</p>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 
              rounded-lg p-6">
              <p className="font-semibold text-green-700 dark:text-green-400 mb-3">
                ✅ Success! ({result.length} characters)
              </p>
              <div className="bg-white dark:bg-neutral-800 rounded-lg p-4 max-h-96 overflow-y-auto">
                <pre className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">
                  {result}
                </pre>
              </div>
            </div>
          )}

          {/* API Info */}
          <div className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-4 text-sm">
            <p className="font-semibold text-neutral-700 dark:text-neutral-300 mb-2">
              📡 API Endpoint:
            </p>
            <code className="text-neutral-600 dark:text-neutral-400">
              POST https://m9qg7xu5cp.ap-southeast-1.awsapprunner.com/transcribe-enhance
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}
