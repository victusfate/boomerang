import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadSyncRoom, saveSyncRoom, clearSyncRoom, parseSyncFragment,
  buildSyncUrl, buildSyncFragment, migrateLegacySyncRoom,
  type SyncRoom,
} from '../services/syncWorker';
import { PLATFORM_WORKER_URL } from '../config/workerEnv';

export interface UseSyncRoomResult {
  room: SyncRoom | null;
  roomRef: React.MutableRefObject<SyncRoom | null>;
  syncUrl: string | null;
  consumedSyncHashRef: React.MutableRefObject<boolean>;
  activate: (r: SyncRoom) => void;
  clearRoom: (displayRoom?: SyncRoom) => void;
}

export function useSyncRoom(
  onRoomActivated: () => unknown,
): UseSyncRoomResult {
  const [room, setRoom] = useState<SyncRoom | null>(null);
  const [syncUrl, setSyncUrl] = useState<string | null>(null);
  const roomRef = useRef<SyncRoom | null>(null);
  const consumedSyncHashRef = useRef(false);
  const onRoomActivatedRef = useRef(onRoomActivated);
  onRoomActivatedRef.current = onRoomActivated;

  const activate = useCallback((r: SyncRoom) => {
    roomRef.current = r;
    setRoom(r);
    saveSyncRoom(r);
    if (PLATFORM_WORKER_URL || r.workerUrl) {
      setSyncUrl(buildSyncUrl(r.roomId, r.token));
    }
  }, []);

  const clearRoom = useCallback((displayRoom?: SyncRoom) => {
    if (displayRoom) {
      saveSyncRoom(displayRoom);
    } else {
      clearSyncRoom();
    }
    roomRef.current = null;
    setRoom(null);
    if (displayRoom) {
      setSyncUrl(buildSyncUrl(displayRoom.roomId, displayRoom.token));
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${buildSyncFragment(displayRoom.roomId, displayRoom.token)}`,
      );
    } else {
      setSyncUrl(null);
    }
  }, []);

  // On mount: prefer URL fragment, then localStorage
  useEffect(() => {
    const fromFragment = parseSyncFragment(undefined, PLATFORM_WORKER_URL);
    if (fromFragment) {
      const migrated = migrateLegacySyncRoom(fromFragment, PLATFORM_WORKER_URL);
      activate(migrated);
      consumedSyncHashRef.current = true;
      return;
    }
    const stored = loadSyncRoom();
    if (stored) activate(migrateLegacySyncRoom(stored, PLATFORM_WORKER_URL));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull once when a room is activated
  useEffect(() => {
    if (!room) return;
    onRoomActivatedRef.current();
  }, [room]);

  return { room, roomRef, syncUrl, consumedSyncHashRef, activate, clearRoom };
}
