import type { RelayDto } from "./types";
import { currentPubkey, signEvent } from "./signer";

const TOKEN_KEY = "server_auth_token";

export function authToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = authToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) clearAuthToken(); // サーバー再起動等でトークンが無効化された場合
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

/**
 * ホストモードのサーバーに対してNIP-98署名で認証し、セッショントークンを取得する。
 * 署名は1セッション(30日)につき1回だけ。要ログイン。
 */
export async function authenticate(): Promise<void> {
  if (!currentPubkey()) throw new Error("先にログインしてください");
  const event = await signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", new URL("/api/auth", location.href).href],
      ["method", "POST"],
    ],
    content: "",
  });
  const { token } = await post<{ token: string }>("/api/auth", { event });
  localStorage.setItem(TOKEN_KEY, token);
}

export const api = {
  serverInfo: () => req<{ hosted: boolean }>("/api/server-info"),
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
 * ホストモードで自分のrelayにlocal接続する場合は所有者確認用のトークンを付ける。
 */
export function relayWsUrl(target: { kind: "local"; port: number } | { kind: "onion"; address: string }): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const t = target.kind === "local" ? `local:${target.port}` : `onion:${target.address}`;
  let url = `${proto}//${location.host}/ws?target=${encodeURIComponent(t)}`;
  const token = authToken();
  if (token && target.kind === "local") url += `&token=${token}`;
  return url;
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
