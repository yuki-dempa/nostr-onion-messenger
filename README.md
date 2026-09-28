# Nostr Onion Messenger (Web版)

NIP-29 (relay-based groups) の**招待制onionルーティングrelay**を、GUIの「新しいRelayを作成」ボタンから自由に作成・利用できるメッセンジャー。

ブラウザのWebクライアント + ローカルで動くNode.jsバックエンド (strfry / tor のプロセス管理 + WebSocketプロキシ) の構成。

## 特徴

- **ワンクリックrelay作成**: strfry + strfry29 (NIP-29プラグイン) をローカルで自動起動。localhostポートは未使用ポートを自動割当
- **Tor Hidden Service**: 作成したrelayはv3 onionアドレスで自動公開 (`Flags=Detach` + 鍵永続化で再起動後も同一アドレス)
- **単一relay接続**: 選択中のrelayだけに読み書きを自動切替 (バックエンドのWSプロキシ経由。onionへはTorのSOCKS5経由)
- **ブラウザ拡張でログイン (NIP-07)**: Alby / nos2x 等の拡張機能でアカウント認証。秘密鍵はアプリに渡らない。bunker:// (NIP-46) も併用可
- **招待制グループ**: グループ作成 / 参加リクエスト / メンバー管理 / チャット (kind 9)

## 構成

```
ブラウザ (React + TypeScript + nostr-tools)
  │ HTTP API / WebSocket
  ▼
server/index.mjs (Node.js)
  ├─ strfry 子プロセス管理 (strfry.conf / strfry29.json 自動生成, 空きポート割当)
  ├─ tor 子プロセス管理 (Control Port: ADD_ONION Flags=Detach / DEL_ONION)
  └─ WSプロキシ /ws?target=local:<port> | onion:<host> (onionはSOCKS5経由)
vendor/
  ├─ strfry/      … relay本体 (macOS向けにビルド)
  └─ relay29/strfry29/ … NIP-29 write-policyプラグイン (パッチ適用済み)
data/             … state.json, relays/<id>/ (LMDB), tor/
```

## 前提

- macOS (arm64)
- Node.js, Go
- Homebrew: `tor lmdb secp256k1 zstd libuv flatbuffers`

## セットアップ・起動

```sh
# vendor (strfry / strfry29) の取得・パッチ適用・ビルド (初回のみ)
./scripts/setup-vendor.sh

npm install

# 本番相当: フロントをビルドしてバックエンドが配信
npm start          # → http://localhost:8787

# 開発: バックエンドとviteを別々に起動 (viteは /api, /ws を :8787 にプロキシ)
npm run server     # ターミナル1
npm run dev        # ターミナル2 → http://localhost:1420
```

## 使い方

1. ブラウザで開き、上部バーの「拡張機能でログイン」(NIP-07) または bunker URI で署名機に接続
2. 「新しいRelayを作成」→ 数十秒でonionアドレスが発行される (Torブートストラップ待ち)
3. relayを選択 → 「グループを作成」→ チャット
4. 他ユーザーは「外部Relay (onion)」にそのonionアドレスを追加して参加リクエストを送る

## vendorパッチについて

`vendor/relay29/strfry29/main.go` には以下の修正が入っている (upstreamはアーカイブ済み):

1. **改行バグ**: `strfry import` は改行終端の行しかパースしないが、eventstore/strfryの `SaveEvent` は改行なしで送るためメタデータが一切保存されない → 自前の `saveEvent` で改行を付与
2. **メモリ状態の不整合**: join受理時の put-user (kind 9000) が `strfry import` 経由だとwrite policyを通らずメモリ上のグループ状態に反映されない → `AddEvent` で `ApplyModerationAction` を明示呼出し
3. **replaceable競合**: 更新されたメタデータ (kind 39002等) がグループ作成時刻のまま署名され、同一 `created_at` だとstrfryのreplaceable解決で古い方が残る → `BroadcastEvent` で `created_at` を現在時刻+1秒に繰り上げて再署名

Torの注意点: ephemeral onion serviceは制御接続が切れると消えるため `Flags=Detach` が必須。また `DiscardPK` を付けるとPrivateKeyが返らずアドレスを永続化できないため付けない。

## スモークテスト

```sh
# local経路
node scripts/smoke-nip29.mjs 'ws://127.0.0.1:8787/ws?target=local:<port>'

# onion経路 (遅いのでwaitを伸ばす)
node scripts/smoke-nip29.mjs 'ws://127.0.0.1:8787/ws?target=onion:<addr>.onion' 10000
```
