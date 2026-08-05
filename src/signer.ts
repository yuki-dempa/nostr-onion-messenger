import { generateSecretKey, getPublicKey } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";

const SK_KEY = "nip46_client_sk";
const URI_KEY = "nip46_bunker_uri";

export interface SignerState {
  connected: boolean;
  connecting: boolean;
  pubkey: string | null;
  error: string | null;
}

let signer: BunkerSigner | null = null;
let signerPubkey: string | null = null;

function loadOrCreateSecretKey(): Uint8Array {
  const saved = localStorage.getItem(SK_KEY);
  if (saved && /^[0-9a-f]{64}$/.test(saved)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(saved.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  const sk = generateSecretKey();
  localStorage.setItem(SK_KEY, Array.from(sk, (b) => b.toString(16).padStart(2, "0")).join(""));
  return sk;
}

export function savedBunkerUri(): string | null {
  return localStorage.getItem(URI_KEY);
}

/** bunker:// URI (またはNIP-05) に接続する */
export async function connectBunker(input: string): Promise<string> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("bunker URIを解釈できませんでした");
  const sk = loadOrCreateSecretKey();
  const s = BunkerSigner.fromBunker(sk, bp);
  await s.connect();
  const pubkey = await s.getPublicKey();
  signer = s;
  signerPubkey = pubkey;
  localStorage.setItem(URI_KEY, input.trim());
  return pubkey;
}

/** 前回の接続を復旧する。失敗しても例外は投げず false を返す */
export async function restoreBunker(): Promise<string | null> {
  const uri = savedBunkerUri();
  if (!uri) return null;
  try {
    return await connectBunker(uri);
  } catch (e) {
    console.warn("bunker復旧失敗:", e);
    return null;
  }
}

export function disconnectBunker() {
  signer?.close().catch(() => {});
  signer = null;
  signerPubkey = null;
  localStorage.removeItem(URI_KEY);
}

export function currentPubkey(): string | null {
  return signerPubkey;
}

export function isSignerReady(): boolean {
  return signer !== null && signerPubkey !== null;
}

/** イベントに署名する。signer未接続ならエラー */
export async function signEvent(tpl: EventTemplate): Promise<VerifiedEvent> {
  if (!signer) throw new Error("署名機に接続していません");
  return signer.signEvent(tpl);
}

/** 接続テスト用: ローカル一時鍵のpubkey (bunkerではない) */
export function localSessionPubkey(): string {
  return getPublicKey(loadOrCreateSecretKey());
}
