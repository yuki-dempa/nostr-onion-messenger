import { generateSecretKey, getPublicKey } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";

/** NIP-07 ブラウザ拡張の最小型定義 */
interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
}
declare global {
  interface Window {
    nostr?: Nip07;
  }
}

export type SignerKind = "nip07" | "nip46";

const SK_KEY = "nip46_client_sk";
const URI_KEY = "nip46_bunker_uri";
const KIND_KEY = "signer_kind";

let bunkerSigner: BunkerSigner | null = null;
let signerPubkey: string | null = null;
let signerKind: SignerKind | null = (localStorage.getItem(KIND_KEY) as SignerKind | null) ?? null;

export function nip07Available(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

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

/* ---------- NIP-07 (ブラウザ拡張) ---------- */

export async function connectNip07(): Promise<string> {
  if (!window.nostr) throw new Error("NIP-07拡張機能が見つかりません (Alby, nos2x 等をインストールしてください)");
  const pk = await window.nostr.getPublicKey();
  bunkerSigner = null;
  signerPubkey = pk;
  signerKind = "nip07";
  localStorage.setItem(KIND_KEY, "nip07");
  return pk;
}

/* ---------- NIP-46 (bunker) ---------- */

export function savedBunkerUri(): string | null {
  return localStorage.getItem(URI_KEY);
}

export async function connectBunker(input: string): Promise<string> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("bunker URIを解釈できませんでした");
  const sk = loadOrCreateSecretKey();
  const s = BunkerSigner.fromBunker(sk, bp);
  await s.connect();
  const pubkey = await s.getPublicKey();
  bunkerSigner = s;
  signerPubkey = pubkey;
  signerKind = "nip46";
  localStorage.setItem(KIND_KEY, "nip46");
  localStorage.setItem(URI_KEY, input.trim());
  return pubkey;
}

/* ---------- 共通 ---------- */

/** 前回の接続を復旧する。失敗しても例外は投げず null を返す */
export async function restoreSigner(): Promise<string | null> {
  if (signerKind === "nip07" && nip07Available()) {
    try {
      return await connectNip07();
    } catch (e) {
      console.warn("NIP-07復旧失敗:", e);
      return null;
    }
  }
  const uri = savedBunkerUri();
  if (signerKind === "nip46" && uri) {
    try {
      return await connectBunker(uri);
    } catch (e) {
      console.warn("bunker復旧失敗:", e);
      return null;
    }
  }
  return null;
}

export function disconnectSigner() {
  bunkerSigner?.close().catch(() => {});
  bunkerSigner = null;
  signerPubkey = null;
  signerKind = null;
  localStorage.removeItem(KIND_KEY);
  localStorage.removeItem(URI_KEY);
}

export function currentPubkey(): string | null {
  return signerPubkey;
}

export function currentSignerKind(): SignerKind | null {
  return signerKind;
}

export function isSignerReady(): boolean {
  return signerPubkey !== null && (signerKind === "nip07" ? nip07Available() : bunkerSigner !== null);
}

/** イベントに署名する。signer未接続ならエラー */
export async function signEvent(tpl: EventTemplate): Promise<VerifiedEvent> {
  if (signerKind === "nip07") {
    if (!window.nostr) throw new Error("NIP-07拡張機能が見つかりません");
    return window.nostr.signEvent(tpl);
  }
  if (signerKind === "nip46" && bunkerSigner) return bunkerSigner.signEvent(tpl);
  throw new Error("署名機に接続していません");
}

/** 接続テスト用: ローカル一時鍵のpubkey (bunkerではない) */
export function localSessionPubkey(): string {
  return getPublicKey(loadOrCreateSecretKey());
}
