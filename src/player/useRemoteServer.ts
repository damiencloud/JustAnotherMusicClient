import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playerController, tabManager, searchController } from "./playerStore";
import { useRemoteControlEnabled, useRemoteControlPort } from "../ui/settings/remoteControl";
import { logInternalDebug, logInternalWarn } from "../internal/logging";
import type { Track } from "../datasource/types";

interface RemoteActionPayload {
  action: string;
  time?: number;
  volume?: number;
  index?: number;
  videoId?: string;
  query?: string;
  track?: Track;
  tracks?: Track[];
  playlistId?: string;
}

export interface RemoteServerInfo {
  enabled: boolean;
  port: number;
  addresses: string[];
  defaultUrl: string;
}

export function useRemoteServer() {
  const enabled = useRemoteControlEnabled();
  const port = useRemoteControlPort();
  const [serverInfo, setServerInfo] = useState<RemoteServerInfo>({
    enabled,
    port,
    addresses: [`http://localhost:${port}`],
    defaultUrl: `http://localhost:${port}`,
  });

  const lastSyncedStateRef = useRef<string>("");

  // 1. Fetch server info on mount and when port/enabled changes
  useEffect(() => {
    let active = true;

    async function updateInfo() {
      if (isTauri()) {
        try {
          const info = await invoke<RemoteServerInfo>("remote_server_get_status");
          if (active) setServerInfo(info);
        } catch (err) {
          logInternalWarn("Failed to fetch remote server status from Tauri", { error: String(err) });
        }
      } else {
        try {
          const res = await fetch(`http://localhost:${port}/api/info`);
          if (res.ok && active) {
            const data = await res.json();
            setServerInfo(data);
          }
        } catch {
          // Node server might not be running in browser dev mode
        }
      }
    }

    void updateInfo();
    const interval = setInterval(updateInfo, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enabled, port]);

  // 2. Listen to actions sent by mobile remote
  useEffect(() => {
    if (!enabled) return;

    const executeAction = async (payload: RemoteActionPayload) => {
      logInternalDebug("Received remote control action", payload as unknown as Record<string, unknown>);
      try {
        switch (payload.action) {
          case "play":
            await playerController.play();
            break;
          case "pause":
            playerController.pause();
            break;
          case "togglePlayPause":
            await playerController.togglePlayPause();
            break;
          case "skipToNext":
            await playerController.skipToNext();
            break;
          case "skipToPrevious":
            await playerController.skipToPrevious();
            break;
          case "seek":
            if (typeof payload.time === "number") {
              await playerController.seekTo(payload.time);
            }
            break;
          case "setVolume":
            if (typeof payload.volume === "number") {
              await playerController.setVolume(payload.volume);
            }
            break;
          case "toggleMute":
            await playerController.toggleMute();
            break;
          case "cyclePlaybackOrderMode":
            playerController.cyclePlaybackOrderMode();
            break;
          case "playQueueTrack":
            if (typeof payload.index === "number") {
              await playerController.playQueueTrackAt(payload.index);
            }
            break;
          case "removeFromQueue":
            if (typeof payload.index === "number") {
              playerController.removeFromQueueAt(payload.index);
            }
            break;
          case "playTrack":
            if (payload.videoId) {
              await playerController.playTrackById(payload.videoId);
            }
            break;
          case "addToQueue":
            if (payload.track) {
              playerController.addToQueue(payload.track);
            }
            break;
          case "queuePlaylist":
            if (payload.tracks && payload.tracks.length > 0) {
              playerController.addTracksToQueue(payload.tracks);
            }
            break;
          case "clearQueue":
            playerController.clearQueue();
            break;
          case "playPlaylist":
            if (payload.tracks && payload.tracks.length > 0) {
              await playerController.playTrackById(payload.tracks[0].id, payload.tracks);
            } else if (payload.videoId) {
              await playerController.playTrackById(payload.videoId);
            }
            break;
        }
      } catch (err) {
        logInternalWarn("Error executing remote control action", { error: String(err) });
      }
    };

    if (isTauri()) {
      const unlistenPromise = listen<RemoteActionPayload>(
        "remote-control:action",
        async ({ payload }) => {
          await executeAction(payload);
        }
      );

      // Listen to search queries from mobile
      const unlistenSearch = listen<{ query: string }>(
        "remote-control:search",
        async ({ payload }) => {
          if (!payload.query) return;
          try {
            const results = await searchController.search(payload.query);
            const tracks = results.tracks || [];
            await invoke("remote_server_set_search_results", {
              results: { results: tracks.slice(0, 25) },
            });
          } catch (err) {
            logInternalWarn("Error handling remote search query", { error: String(err) });
          }
        }
      );

      return () => {
        unlistenPromise.then((fn) => fn());
        unlistenSearch.then((fn) => fn());
      };
    } else {
      // In web browser dev mode, connect to the local Node server's SSE action stream
      let es: EventSource | null = null;
      try {
        es = new EventSource(`http://localhost:${port}/api/events`);
        es.addEventListener("action", (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            void executeAction(payload);
          } catch {}
        });
      } catch {}

      return () => {
        if (es) es.close();
      };
    }
  }, [enabled, port]);

  // 3. Sync player state to remote server whenever state or time updates
  useEffect(() => {
    if (!enabled) return;

    function buildCurrentState() {
      const activeState = tabManager.getActiveState();
      const activeSession = tabManager.getActiveSession();
      const track = activeState.currentTrack;
      const duration = playerController.getDuration() || track?.durationSec || 0;
      const currentTime = playerController.getCurrentTime() || 0;

      return {
        status: activeState.status,
        currentTrack: track
          ? {
              id: track.id,
              title: track.title,
              artist: track.artist,
              artworkUrl: track.artworkUrl,
              durationSec: track.durationSec,
            }
          : null,
        currentTime,
        duration,
        volume: playerController.getVolume(),
        muted: playerController.isMuted(),
        playbackOrderMode: activeState.playbackOrderMode || "in-order",
        queue: (activeSession?.queue || []).map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          artworkUrl: t.artworkUrl,
          durationSec: t.durationSec,
        })),
        queueIndex: activeSession?.queueIndex || 0,
      };
    }

    async function syncState(force = false) {
      const payload = buildCurrentState();
      const key = `${payload.status}:${payload.currentTrack?.id}:${Math.floor(payload.currentTime)}:${payload.volume}:${payload.muted}:${payload.playbackOrderMode}:${payload.queue.length}`;

      if (!force && key === lastSyncedStateRef.current) return;
      lastSyncedStateRef.current = key;

      if (isTauri()) {
        try {
          await invoke("remote_server_update_state", { state: payload });
        } catch {
          // Ignore
        }
      } else {
        try {
          await fetch(`http://localhost:${port}/api/update-state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch {
          // Server might not be up
        }
      }
    }

    // Sync on tabManager change
    const unsubscribe = tabManager.subscribe(() => {
      void syncState(true);
    });

    // Sync time every 1.5s while playing
    const timer = setInterval(() => {
      const st = tabManager.getActiveState();
      if (st.status === "playing") {
        void syncState(false);
      }
    }, 1500);

    // Initial sync
    void syncState(true);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [enabled, port]);

  return { serverInfo };
}
