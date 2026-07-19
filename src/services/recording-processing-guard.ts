export interface RecordingProcessingGuard {
  run<T>(audioPath: string, task: () => Promise<T> | T): Promise<T>;
  isActive(audioPath: string): boolean;
}

export function createRecordingProcessingGuard(): RecordingProcessingGuard {
  const active = new Map<string, Promise<unknown>>();

  return {
    run<T>(audioPath: string, task: () => Promise<T> | T): Promise<T> {
      const existing = active.get(audioPath) as Promise<T> | undefined;
      if (existing) return existing;

      let started: Promise<T>;
      try {
        started = Promise.resolve(task());
      } catch (error) {
        started = Promise.reject(error);
      }
      const tracked = started.finally(() => {
        if (active.get(audioPath) === tracked) active.delete(audioPath);
      });
      active.set(audioPath, tracked);
      return tracked;
    },

    isActive(audioPath: string): boolean {
      return active.has(audioPath);
    },
  };
}

export function installAsyncListener<T>(
  register: (handler: (event: T) => void) => Promise<() => void>,
  handler: (event: T) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void register(handler)
    .then((registeredUnlisten) => {
      if (disposed) {
        registeredUnlisten();
      } else {
        unlisten = registeredUnlisten;
      }
    })
    .catch((error) => {
      if (!disposed) console.error("Failed to register recording listener:", error);
    });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

export const recordingProcessingGuard = createRecordingProcessingGuard();
