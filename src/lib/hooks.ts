import { useEffect, useState } from 'react';
import type { ProgressEvent } from '../../shared/ipc';

export function useProgressFeed(): ProgressEvent | null {
  const [event, setEvent] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    const bridge = window.qureka;
    if (!bridge) return;
    return bridge.onProgress(setEvent);
  }, []);

  return event;
}
