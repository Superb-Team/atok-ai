import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authService } from '@/features/auth/api/auth.service';
import { processAudioRecording } from '@/features/note-generation/audio-processor.service';
import { loadProcessingManifest } from '@/features/note-generation/api/processing-manifest';
import { MAX_PROCESSING_ATTEMPTS } from '@/features/note-generation/lib/processing-review-policy';
import { audioImportService } from '@/features/recording/api/audio-import.service';
import type { ProcessingJobSummary } from '@/features/recording/api/recording.service';
import { recordingService } from '@/features/recording/api/recording.service';
import { ImportProcessingQueue } from '@/features/recording/lib/import-processing-queue';
import { importPreparationErrorMessage, recordingProcessingErrorMessage } from '@/features/recording/lib/recording-error-message';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { errorMessage, logger } from '@/lib/logger';

const ImportProcessingContext = createContext({ titles: [] as string[], revision: 0 });
export const useImportProcessing = () => useContext(ImportProcessingContext);

export function ImportProcessingProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [titles, setTitles] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [failedJobs, setFailedJobs] = useState<ProcessingJobSummary[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const queue = new ImportProcessingQueue({
      userId,
      list: async () => {
        const jobs = await recordingService.listProcessingJobs();
        if (mounted) setFailedJobs(jobs.filter(job => job.source === 'import' && job.ownerUserId === userId &&
          (job.status === 'failed' || (job.attempt ?? 0) >= MAX_PROCESSING_ATTEMPTS) && job.status !== 'complete' && job.status !== 'partial'));
        return jobs;
      },
      load: loadProcessingManifest,
      isCurrentUser: () => mounted && authService.getUser()?.id === userId,
      onJobs: jobs => { if (mounted) setTitles(jobs.map(job => job.noteTitle)); },
      onError: error => {
        logger.error('recording.import_queue_failed', { error: errorMessage(error) });
        if (mounted && authService.getUser()?.id === userId) setNotice(importPreparationErrorMessage(error));
      },
      process: async job => {
        if (!await audioImportService.prepareQueuedImport(job.audioPath, userId)) return;
        const result = await processAudioRecording(job.audioPath, job.noteTitle, job.language,
          job.recordedAt && job.timezone ? { recordedAt: job.recordedAt, timezone: job.timezone } : undefined,
          { resumeOnly: true });
        if (!mounted || authService.getUser()?.id !== userId) return;
        setRevision(value => value + 1);
        if (!result.success) setNotice(recordingProcessingErrorMessage(result.error));
        else if (result.outcome === 'no_speech') setNotice('The imported audio was saved, but no speech was detected.');
      },
    });
    const drain = () => { void queue.drain(); };
    drain();
    const timer = setInterval(drain, 5000);
    window.addEventListener('audio-import-queued', drain);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('audio-import-queued', drain);
    };
  }, [userId]);

  return <ImportProcessingContext.Provider value={{ titles, revision }}>
    {children}
    {(titles.length > 0 || failedJobs.length > 0) && <div role="status" className="fixed bottom-4 left-4 z-40 rounded-lg border bg-background px-4 py-3 text-sm shadow-sm">
      {titles.length > 0 && <p>Processing {titles.length} imported recording{titles.length === 1 ? '' : 's'}…</p>}
      {failedJobs.length > 0 && <div className="max-h-40 max-w-sm space-y-2 overflow-y-auto">
        <p>Imported recordings need attention:</p>
        {failedJobs.map(job => <div key={job.audioPath} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{job.noteTitle}</span>
          <button className="shrink-0 rounded border px-2 py-1 disabled:opacity-50" disabled={retrying !== null}
            onClick={async () => {
              setRetrying(job.audioPath);
              setRetryError(null);
              try {
                await audioImportService.retryImport(job.audioPath, userId);
                setFailedJobs(jobs => jobs.filter(item => item.audioPath !== job.audioPath));
              } catch (error) { setRetryError(errorMessage(error)); }
              finally { setRetrying(null); }
            }}>Retry</button>
        </div>)}
        {retryError && <p role="alert">{retryError}</p>}
      </div>}
    </div>}
    <ConfirmDialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}
      title="Audio import" description={notice ?? ''} confirmText="OK" mode="alert" />
  </ImportProcessingContext.Provider>;
}
