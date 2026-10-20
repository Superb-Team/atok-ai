import { shouldRecoverProcessingJob } from '../../note-generation/lib/processing-review-policy.ts';

export interface ImportJob {
  audioPath: string;
  noteTitle: string;
  language: string;
  ownerUserId?: string;
  source?: string;
  status: string;
  recordedAt?: string;
  timezone?: string;
  attempt?: number;
  nextAttemptAt?: string;
  failureKind?: 'retryable' | 'terminal';
}

export function isRecoverableImport(job: ImportJob, userId: string): boolean {
  return job.source === 'import' && job.ownerUserId === userId && shouldRecoverProcessingJob(job);
}

// One drain at a time, including overlapping timers and enqueue notifications.
interface QueueDependencies {
    userId: string;
    list: () => Promise<ImportJob[]>;
    load: (path: string) => Promise<ImportJob | null>;
    process: (job: ImportJob) => Promise<void>;
    isCurrentUser: () => boolean;
    onJobs: (jobs: ImportJob[]) => void;
    onError: (error: unknown) => void;
}

export class ImportProcessingQueue {
  private activeDrain: Promise<void> | null = null;
  private dependencies: QueueDependencies;

  constructor(dependencies: QueueDependencies) { this.dependencies = dependencies; }

  drain(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    this.activeDrain = this.drainOnce().finally(() => { this.activeDrain = null; });
    return this.activeDrain;
  }

  private async drainOnce(): Promise<void> {
    const { dependencies: d } = this;
    try {
      if (!d.isCurrentUser()) return;
      const jobs = (await d.list()).filter(job => isRecoverableImport(job, d.userId));
      d.onJobs(jobs);
      for (const [index, job] of jobs.entries()) {
        if (!d.isCurrentUser()) break;
        try {
          const current = await d.load(job.audioPath);
          if (current && isRecoverableImport(current, d.userId) && d.isCurrentUser()) {
            await d.process(current);
          }
        } catch (error) {
          d.onError(error);
        }
        d.onJobs(jobs.slice(index + 1));
      }
    } catch (error) {
      d.onError(error);
    } finally {
      d.onJobs([]);
    }
  }
}
