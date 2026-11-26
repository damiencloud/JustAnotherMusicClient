import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";
import { getAppSetting, setAppSetting } from "../../internal/appSettings";

const ENABLED_STORAGE_KEY = "remote-control-enabled";
const PORT_STORAGE_KEY = "remote-control-port";
const ENABLED_CHANGE_EVENT = "remote-control-enabled-change";
const PORT_CHANGE_EVENT = "remote-control-port-change";

export const DEFAULT_REMOTE_PORT = 9863;

function readRemoteControlEnabled(): boolean {
  return readLocalBooleanSetting(ENABLED_STORAGE_KEY, true);
}

function readRemoteControlPort(): number {
  try {
    const stored = localStorage.getItem(PORT_STORAGE_KEY);
    if (!stored) return DEFAULT_REMOTE_PORT;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed > 1024 && parsed < 65535 ? parsed : DEFAULT_REMOTE_PORT;
  } catch {
    return DEFAULT_REMOTE_PORT;
  }
}

function subscribeEnabled(callback: () => void) {
  window.addEventListener(ENABLED_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(ENABLED_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function subscribePort(callback: () => void) {
  window.addEventListener(PORT_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(PORT_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setRemoteControlEnabled(enabled: boolean) {
  writeLocalBooleanSetting(ENABLED_STORAGE_KEY, enabled, ENABLED_CHANGE_EVENT);
}

export function getRemoteControlEnabled() {
  return readRemoteControlEnabled();
}

export function useRemoteControlEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, readRemoteControlEnabled, () => true);
}

export function setRemoteControlPort(port: number) {
  const safePort = Number.isFinite(port) && port > 1024 && port < 65535 ? port : DEFAULT_REMOTE_PORT;
  try {
    localStorage.setItem(PORT_STORAGE_KEY, String(safePort));
  } catch {
    // fall through
  }
  window.dispatchEvent(new Event(PORT_CHANGE_EVENT));
  void setAppSetting(PORT_STORAGE_KEY, safePort);
}

export function getRemoteControlPort(): number {
  return readRemoteControlPort();
}

export function useRemoteControlPort(): number {
  return useSyncExternalStore(subscribePort, readRemoteControlPort, () => DEFAULT_REMOTE_PORT);
}

export async function hydrateRemoteControlSettings(): Promise<void> {
  await hydrateLocalBooleanSetting(ENABLED_STORAGE_KEY, true, ENABLED_CHANGE_EVENT);
  const storedPort = await getAppSetting<number>(PORT_STORAGE_KEY);
  if (typeof storedPort === "number" && storedPort > 1024 && storedPort < 65535) {
    try {
      localStorage.setItem(PORT_STORAGE_KEY, String(storedPort));
    } catch {}
    window.dispatchEvent(new Event(PORT_CHANGE_EVENT));
  }
}
