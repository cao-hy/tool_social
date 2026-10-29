'use client';

import type { WorkspaceRealtimeEvent } from '@socialhub/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getWorkspaceEventsStreamUrl } from '@/lib/api-client';

type WorkspaceEventHandler = (event: WorkspaceRealtimeEvent) => void;

interface WorkspaceEventsContextValue {
  connected: boolean;
  subscribe: (handler: WorkspaceEventHandler) => () => void;
}

const WorkspaceEventsContext = createContext<WorkspaceEventsContextValue>({
  connected: false,
  subscribe: () => () => undefined,
});

export function WorkspaceEventsProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: ReactNode;
}) {
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Set<WorkspaceEventHandler>>(new Set());

  const subscribe = useCallback((handler: WorkspaceEventHandler) => {
    listenersRef.current.add(handler);
    return () => {
      listenersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (!workspaceId || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setConnected(false);
      return;
    }

    const url = getWorkspaceEventsStreamUrl(workspaceId);
    const source = new EventSource(url, { withCredentials: true });
    let hasConnectedOnce = false;
    let wasDisconnected = false;

    const dispatchEvent = (parsed: WorkspaceRealtimeEvent) => {
      for (const listener of listenersRef.current) {
        try {
          listener(parsed);
        } catch {
          // Do not let one subscriber break others
        }
      }
    };

    const handleConnected = () => {
      setConnected(true);
      if (hasConnectedOnce && wasDisconnected) {
        wasDisconnected = false;
        dispatchEvent({
          id: `reconnected-${Date.now()}`,
          workspaceId,
          type: 'stream.reconnected',
          timestamp: new Date().toISOString(),
        });
      }
      hasConnectedOnce = true;
    };

    source.onopen = handleConnected;
    source.addEventListener('connected', handleConnected);

    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as WorkspaceRealtimeEvent;
        if (!parsed?.type) return;
        dispatchEvent(parsed);
      } catch {
        // Ignore non-JSON frames
      }
    };

    source.onerror = () => {
      wasDisconnected = true;
      setConnected(false);
      // EventSource automatically attempts reconnection
    };

    return () => {
      setConnected(false);
      source.close();
    };
  }, [workspaceId]);

  const value = useMemo<WorkspaceEventsContextValue>(
    () => ({
      connected,
      subscribe,
    }),
    [connected, subscribe],
  );

  return (
    <WorkspaceEventsContext.Provider value={value}>{children}</WorkspaceEventsContext.Provider>
  );
}

export function useWorkspaceEvents(): WorkspaceEventsContextValue {
  return useContext(WorkspaceEventsContext);
}

export function useWorkspaceEventSubscription(handler: WorkspaceEventHandler): {
  connected: boolean;
} {
  const { connected, subscribe } = useWorkspaceEvents();
  const handlerRef = useRef<WorkspaceEventHandler>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((event) => {
      handlerRef.current(event);
    });
  }, [subscribe]);

  return { connected };
}
