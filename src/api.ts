import type { RelayDto } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

export const api = {
  listRelays: () => req<RelayDto[]>("/api/relays"),
  createRelay: (name: string) => post<RelayDto>("/api/relays", { name }),
  startRelay: (id: string) => post<RelayDto>(`/api/relays/${id}/start`),
  stopRelay: (id: string) => post<RelayDto>(`/api/relays/${id}/stop`),
  deleteRelay: (id: string) =>
    req<{ ok: boolean }>(`/api/relays/${id}`, { method: "DELETE" }),
  torStatus: () => req<{ progress: number }>("/api/tor-status"),
};

/**
 * relay接続用のWebSocketプロキシURLを返す。
 * ブラウザからonionへ直接接続できないため、必ずバックエンド経由にする。
 */
export function relayWsUrl(target: { kind: "local"; port: number } | { kind: "onion"; address: string }): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const t = target.kind === "local" ? `local:${target.port}` : `onion:${target.address}`;
  return `${proto}//${location.host}/ws?target=${encodeURIComponent(t)}`;
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
