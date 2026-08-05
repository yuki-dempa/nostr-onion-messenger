import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RelayDto } from "./types";

export const api = {
  listRelays: () => invoke<RelayDto[]>("list_relays"),
  createRelay: (name: string) => invoke<RelayDto>("create_relay", { name }),
  startRelay: (id: string) => invoke<RelayDto>("start_relay", { id }),
  stopRelay: (id: string) => invoke<void>("stop_relay", { id }),
  deleteRelay: (id: string) => invoke<void>("delete_relay", { id }),
  torStatus: () => invoke<number>("tor_status"),
  openOnionBridge: (onionHost: string) =>
    invoke<string>("open_onion_bridge", { onionHost }),
};

/** onion発行完了などでrelay情報が更新されたときに呼ばれる */
export function onRelayUpdated(cb: () => void): () => void {
  const unlisten = listen("relay-updated", cb);
  return () => {
    unlisten.then((f) => f());
  };
}

const EXTERNAL_KEY = "external_relays";

export function loadExternalRelays(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXTERNAL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveExternalRelays(list: string[]) {
  localStorage.setItem(EXTERNAL_KEY, JSON.stringify(list));
}
