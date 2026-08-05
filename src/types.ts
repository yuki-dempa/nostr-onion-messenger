export interface RelayDto {
  id: string;
  name: string;
  port: number;
  local_url: string;
  onion_address: string | null;
  running: boolean;
}

/** 外部(onion) relay の保存レコード */
export interface ExternalRelay {
  address: string; // "xxxx.onion"
  addedAt: number;
}

/** 選択中の接続先。local=自分のrelay, external=外部onion relay */
export type RelayTarget =
  | { kind: "local"; relay: RelayDto }
  | { kind: "external"; address: string };

export interface GroupMeta {
  id: string; // d タグ = グループID
  name: string;
  about: string;
  picture: string;
  raw: unknown;
}
