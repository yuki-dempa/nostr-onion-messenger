import { Relay } from "nostr-tools";
import type { Filter, NostrEvent } from "nostr-tools";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

type StatusListener = (s: ConnectionStatus, detail?: string) => void;

/**
 * 選択中のrelayに1本だけ接続するマネージャ。
 * switchTo() で必ず前の接続を閉じてから新しいrelayに接続する。
 */
class ActiveRelayConnection {
  private relay: Relay | null = null;
  private url: string | null = null;
  private status: ConnectionStatus = "disconnected";
  private listeners = new Set<StatusListener>();
  private generation = 0;

  onStatus(l: StatusListener): () => void {
    this.listeners.add(l);
    l(this.status);
    return () => this.listeners.delete(l);
  }

  private setStatus(s: ConnectionStatus, detail?: string) {
    this.status = s;
    for (const l of this.listeners) l(s, detail);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getUrl(): string | null {
    return this.url;
  }

  /** 接続を切り替える。同じURLなら何もしない */
  async switchTo(url: string): Promise<void> {
    if (this.url === url && this.status === "connected") return;
    const gen = ++this.generation;
    this.close();
    this.url = url;
    this.setStatus("connecting");
    try {
      const relay = await Relay.connect(url);
      if (gen !== this.generation) {
        // 接続中に別のrelayに切り替わった
        relay.close();
        return;
      }
      this.relay = relay;
      this.setStatus("connected");
      relay.onclose = () => {
        if (this.relay === relay) {
          this.relay = null;
          this.setStatus("disconnected");
        }
      };
    } catch (e) {
      if (gen === this.generation) this.setStatus("error", String(e));
    }
  }

  close() {
    this.generation++;
    this.relay?.close();
    this.relay = null;
    this.url = null;
    this.setStatus("disconnected");
  }

  /**
   * 購読する。接続が切り替わると古い購読は接続ごと破棄される。
   * 戻り値は購読解除関数。
   */
  subscribe(
    filters: Filter[],
    handlers: { onevent: (ev: NostrEvent) => void; oneose?: () => void },
  ): () => void {
    if (!this.relay) return () => {};
    const relay = this.relay;
    const sub = relay.subscribe(filters, {
      onevent: handlers.onevent,
      oneose: handlers.oneose,
      onclose: () => {},
    });
    return () => {
      try {
        sub.close();
      } catch {
        // 接続済み切断時は無視
      }
      void relay;
    };
  }

  async publish(ev: NostrEvent): Promise<void> {
    if (!this.relay) throw new Error("relayに接続していません");
    await this.relay.publish(ev);
  }
}

export const activeRelay = new ActiveRelayConnection();
