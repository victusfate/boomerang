import { useCallback, useMemo, useState } from 'react';
import { PLATFORM_WORKER_URL } from '../config/workerEnv.ts';
import { loadSyncRoom } from '../services/syncWorker.ts';
import {
  buildBookmarklet,
  loadCaptureState,
  saveCaptureState,
  clearCaptureState,
  requestCaptureToken,
  revokeCaptureTokenRequest,
  type CaptureDestination,
} from '../services/captureWorker.ts';

export interface UseCaptureTokenResult {
  captureToken: string | null;
  destination: CaptureDestination | null;
  bookmarklet: string;
  hasRoom: boolean;
  busy: boolean;
  error: string | null;
  generate: (destination: CaptureDestination) => Promise<void>;
  revoke: () => Promise<void>;
}

export function useCaptureToken(): UseCaptureTokenResult {
  const [state, setState] = useState(loadCaptureState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasRoom = loadSyncRoom() !== null;

  const generate = useCallback(async (destination: CaptureDestination) => {
    const room = loadSyncRoom();
    if (!room) { setError('Set up cross-device sync first — capture needs a room to attach to.'); return; }
    setBusy(true);
    setError(null);
    try {
      const token = await requestCaptureToken(PLATFORM_WORKER_URL, room, destination);
      const next = { token, destination };
      saveCaptureState(next);
      setState(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate capture token.');
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(async () => {
    const room = loadSyncRoom();
    setBusy(true);
    setError(null);
    try {
      if (room) await revokeCaptureTokenRequest(PLATFORM_WORKER_URL, room);
      clearCaptureState();
      setState(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke capture token.');
    } finally {
      setBusy(false);
    }
  }, []);

  const bookmarklet = useMemo(
    () => buildBookmarklet(PLATFORM_WORKER_URL, state?.token ?? ''),
    [state],
  );

  return {
    captureToken: state?.token ?? null,
    destination: state?.destination ?? null,
    bookmarklet,
    hasRoom,
    busy,
    error,
    generate,
    revoke,
  };
}
