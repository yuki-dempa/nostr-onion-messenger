# Nostr Onion Messenger

NIP-29 (relay-based groups) の**招待制onionルーティングrelay**を、GUIの「新しいRelayを作成」ボタンから自由に作成・利用できるメッセンジャー (macOS向けTauriアプリ)。

## 特徴

- **ワンクリックrelay作成**: strfry + strfry29 (NIP-29プラグイン) をローカルで自動起動。localhostポートは未使用ポートを自動割当
- **Tor Hidden Service**: 作成したrelayはv3 onionアドレスで自動公開され、外部から `ws://xxxx.onion` でアクセス可能
- **単一relay接続**: 選択中のrelayだけに読み書きを自動切替
- **NIP-46リモート署名**: 秘密鍵をアプリに持たない (bunker:// 対応)
- **招待制グループ**: グループ作成 / 参加リクエスト / 承認・メンバー削除 / チャット (kind 9)

## 構成

```
Tauri App (React + TypeScript / Rust)
  ├─ RelayManager … strfry子プロセス管理 (strfry.conf/strfry29.json自動生成)
  ├─ TorManager   … torプロセス + Control Port (ADD_ONIONでonion発行)
  └─ Bridge       … 外部onion relayへのSOCKS5→ローカルWebSocketブリッジ
vendor/
  ├─ strfry/      … relay本体 (macOS向けにビルド)
  └─ relay29/strfry29/ … NIP-29 write-policyプラグイン (パッチ適用済み)
```

## 前提

- macOS (arm64)
- Rust (rustup), Node.js, Go
- Homebrew: `tor lmdb secp256k1 zstd libuv flatbuffers`

## ビルド

```sh
# vendor (strfry / strfry29) の取得・パッチ適用・ビルド (初回のみ)
./scripts/setup-vendor.sh

# アプリ
npm install && npm run tauri dev
```

## vendorパッチについて

`vendor/relay29/strfry29/main.go` には以下の修正が入っている (upstreamはアーカイブ済み):

1. **改行バグ**: `strfry import` は改行終端の行しかパースしないが、eventstore/strfryの `SaveEvent` は改行なしで送るためメタデータが一切保存されない → 自前の `saveEvent` で改行を付与
2. **メモリ状態の不整合**: join受理時の put-user (kind 9000) が `strfry import` 経由だとwrite policyを通らずメモリ上のグループ状態に反映されない → `AddEvent` で `ApplyModerationAction` を明示呼出し
3. **replaceable競合**: 更新されたメタデータ (kind 39002等) がグループ作成時刻のまま署名され、同一 `created_at` だとstrfryのreplaceable解決で古い方が残る → `BroadcastEvent` で `created_at` を現在時刻+1秒に繰り上げて再署名

また Tor の ephemeral onion service は制御接続が切れると消えるため、`ADD_ONION` に `Flags=Detach` が必須 (`src-tauri/src/tor.rs` 参照)。

## 手動E2E確認手順

1. `npm run tauri dev` でアプリ起動 (Torブートストラップ完了まで待つ)
2. 「新しいRelayを作成」→ relayが一覧に現れ、数十秒以内にonionアドレスが付く
3. 上部バーに bunker:// URI (nsec.app 等で発行) を入力して署名機に接続
4. relayを選択 → 「グループを作成」→ チャット送信できること
5. 別アカウントで: 「外部relayを追加」に 2 のonionアドレスを入力 → 選択 → グループを開いて「参加リクエストを送る」→ メンバーに追加されチャットできること
6. 管理側でメンバーの「削除」が効くこと

スモークテスト (GUIなしでstrfry+strfry29のNIP-29動作を検証):

```sh
# relayを手動で立てた状態で
node scripts/smoke-nip29.mjs ws://127.0.0.1:17777
```

## データ保存先

`~/Library/Application Support/dev.onionmessenger.app/`
- `state.json` — relay定義 (ポート/onion鍵/relay署名鍵)
- `relays/<id>/` — strfry.conf, strfry29.json, strfry-db (LMDB)
- `tor/` — tor data dir
