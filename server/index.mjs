#!/usr/bin/env node
// Nostr Onion Messenger — Web版バックエンド
// strfry/strfry29 (NIP-29) と tor を子プロセスとして管理し、
// ブラウザのフロントエンドに HTTP API と WebSocketプロキシを提供する。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
const STRFRY_BIN = process.env.STRFRY_BIN ?? path.join(ROOT, "vendor/strfry/strfry");
const STRFRY29_BIN = process.env.STRFRY29_BIN ?? path.join(ROOT, "vendor/relay29/strfry29/strfry29");
const TOR_BIN = process.env.TOR_BIN ?? "tor";
const HTTP_PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = path.join(ROOT, "dist");

/* ---------- ユーティリティ ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/* ---------- 状態ストア ---------- */

const statePath = path.join(DATA_DIR, "state.json");
let relays = [];
try {
  relays = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  relays = [];
}
function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(relays, null, 2));
  fs.renameSync(tmp, statePath);
}

/* ---------- strfry.conf / strfry29.json 生成 ---------- */

const STRFRY_CONF = (port, name) => `db = "strfry-db/"
dbParams { maxreaders = 256 mapsize = 10995116277760 noReadAhead = false }
events { maxEventSize = 65536 rejectEventsNewerThanSeconds = 900 rejectEventsOlderThanSeconds = 94608000 rejectEphemeralEventsOlderThanSeconds = 60 ephemeralEventsLifetimeSeconds = 300 maxNumTags = 2000 maxTagValSize = 1024 }
relay {
    bind = "127.0.0.1"
    port = ${port}
    nofiles = 0
    realIpHeader = ""
    info { name = "${name.replace(/"/g, "")}" description = "NIP-29 group relay hosted by nostr-onion-messenger" pubkey = "" contact = "" icon = "" }
    maxWebsocketPayloadSize = 131072
    autoPingSeconds = 29
    enableTcpKeepalive = false
    queryTimesliceBudgetMicroseconds = 10000
    maxFilterLimit = 500
    maxSubsPerConnection = 20
    writePolicy { plugin = "${STRFRY29_BIN}" }
    compression { enabled = false slidingWindow = true }
    logging { dumpInAll = false dumpInEvents = false dumpInReqs = false dbScanPerf = false invalidEvents = true }
    numThreads { ingester = 3 reqWorker = 3 reqMonitor = 3 negentropy = 2 }
    negentropy { enabled = true maxSyncEvents = 1000000 }
}
`;

const STRFRY29_JSON = (domain, secret) =>
  JSON.stringify(
    {
      domain,
      relay_secret_key: secret,
      strfry_config_path: "strfry.conf",
      strfry_executable_path: STRFRY_BIN,
      group_creator_default_role: "master",
      permissions: {
        master: ["AddUser", "RemoveUser", "EditMetadata", "DeleteEvent", "AddPermission", "RemovePermission", "DeleteGroup", "CreateInvite", "CreateGroup"],
        admin: ["AddUser", "RemoveUser", "EditMetadata", "DeleteEvent", "CreateInvite"],
        member: [],
      },
    },
    null,
    2,
  );

function writeConfigs(rec) {
  fs.mkdirSync(path.join(rec.dir, "strfry-db"), { recursive: true });
  fs.writeFileSync(path.join(rec.dir, "strfry.conf"), STRFRY_CONF(rec.port, rec.name));
  const domain = rec.onion_address ?? `127.0.0.1:${rec.port}`;
  fs.writeFileSync(path.join(rec.dir, "strfry29.json"), STRFRY29_JSON(domain, rec.relay_secret_key));
}

/* ---------- プロセス管理 ---------- */

const children = new Map(); // relayId -> ChildProcess

function startRelayProc(rec) {
  if (children.has(rec.id)) return;
  writeConfigs(rec);
  const log = fs.openSync(path.join(rec.dir, "strfry.log"), "a");
  const child = spawn(STRFRY_BIN, ["relay"], {
    cwd: rec.dir,
    stdio: ["ignore", log, log],
  });
  child.on("exit", () => {
    children.delete(rec.id);
    if (rec.pid === child.pid) rec.pid = null;
  });
  children.set(rec.id, child);
  // 孤児プロセス掃除用にPIDを記録する
  rec.pid = child.pid;
  saveState();
}

function stopRelayProc(id) {
  const c = children.get(id);
  if (c) {
    children.delete(id);
    c.kill("SIGTERM");
  }
}

/* ---------- Tor管理 ---------- */

let torProc = null;
let torControlPort = 0;
let torSocksPort = 0;
const torDataDir = path.join(DATA_DIR, "tor");

async function startTor() {
  fs.mkdirSync(torDataDir, { recursive: true });
  torControlPort = await findFreePort();
  torSocksPort = await findFreePort();
  const log = fs.openSync(path.join(torDataDir, "tor.log"), "a");
  torProc = spawn(TOR_BIN, [
    "--DataDirectory", torDataDir,
    "--ControlPort", String(torControlPort),
    "--CookieAuthentication", "1",
    "--SocksPort", `127.0.0.1:${torSocksPort}`,
  ], { stdio: ["ignore", log, log] });
  torProc.on("exit", () => (torProc = null));
}

/** Tor Control Port にコマンドを送り、応答行の配列を返す */
function torControl(cmds) {
  return new Promise((resolve, reject) => {
    const cookie = fs.readFileSync(path.join(torDataDir, "control_auth_cookie"));
    const sock = net.connect(torControlPort, "127.0.0.1");
    const lines = [];
    let buf = "";
    let idx = 0;
    const sendNext = () => {
      if (idx < cmds.length) sock.write(cmds[idx++] + "\r\n");
      else sock.end();
    };
    sock.on("connect", () => sendNext());
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (line.startsWith("250 ") || /^[45]/.test(line)) {
          if (/^[45]/.test(line)) {
            sock.destroy();
            reject(new Error(`tor control error: ${line}`));
            return;
          }
          if (idx < cmds.length) sendNext();
          else {
            sock.end();
            resolve(lines);
          }
        }
      }
    });
    sock.on("error", reject);
    sock.setTimeout(15000, () => {
      sock.destroy();
      reject(new Error("tor control timeout"));
    });
  });
}

async function torBootstrapProgress() {
  try {
    const lines = await torControl([
      `AUTHENTICATE ${fs.readFileSync(path.join(torDataDir, "control_auth_cookie")).toString("hex")}`,
      "GETINFO status/bootstrap-phase",
    ]);
    const info = lines.find((l) => l.startsWith("250-status/bootstrap-phase=")) ?? "";
    const m = info.match(/PROGRESS=(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function addOnion(keyBlob, targetPort) {
  const key = keyBlob ?? "NEW:ED25519-V3";
  // Detach: 制御接続が切れてもonionサービスを維持する
  const lines = await torControl([
    `AUTHENTICATE ${fs.readFileSync(path.join(torDataDir, "control_auth_cookie")).toString("hex")}`,
    // Detach: 制御接続が切れてもonionサービスを維持する。
    // DiscardPKは付けない: PrivateKeyが応答で返らず永続化できなくなるため
    `ADD_ONION ${key} Flags=Detach Port=80,127.0.0.1:${targetPort}`,
  ]);
  const id = lines.find((l) => l.startsWith("250-ServiceID="))?.split("=")[1];
  const pk = lines.find((l) => l.startsWith("250-PrivateKey="))?.split("=")[1];
  if (!id) throw new Error("ADD_ONION応答が不正: " + lines.join(" | "));
  return { hostname: id + ".onion", keyBlob: pk ?? keyBlob };
}

async function delOnion(hostname) {
  await torControl([
    `AUTHENTICATE ${fs.readFileSync(path.join(torDataDir, "control_auth_cookie")).toString("hex")}`,
    `DEL_ONION ${hostname.replace(/\.onion$/, "")}`,
  ]);
}

let ensureOnionsRunning = false;

/** ブートストラップ完了後、onion未発行のrelayに発行する (バックグラウンド) */
async function ensureOnions() {
  if (ensureOnionsRunning) return; // 並走して二重発行しない
  ensureOnionsRunning = true;
  try {
    for (let i = 0; i < 240; i++) {
      if ((await torBootstrapProgress()) >= 100) break;
      await sleep(500);
    }
    for (const rec of relays) {
      try {
        // ephemeral onionはtorプロセス再起動で消えるため、保持済みの鍵で毎回再登録する
        // (同じ鍵なら同じアドレスで復元される)
        const svc = await addOnion(rec.onion_key, rec.port);
        if (rec.onion_address !== svc.hostname || rec.onion_key !== svc.keyBlob) {
          rec.onion_address = svc.hostname;
          rec.onion_key = svc.keyBlob;
          saveState();
          console.log(`onion発行: ${rec.name} -> ${svc.hostname}`);
        }
      } catch (e) {
        console.error(`onion発行失敗 (${rec.id}):`, e.message);
        break;
      }
    }
  } finally {
    ensureOnionsRunning = false;
  }
}

/* ---------- SOCKS5 (onion接続用) ---------- */

function onionWsAgent() {
  // wsライブラリは agent 経由でhttp.requestを使うため、SocksProxyAgentがそのまま使える
  return new SocksProxyAgent(`socks5h://127.0.0.1:${torSocksPort}`);
}

/* ---------- HTTP API + 静的ファイル ---------- */

const dto = (r) => ({
  id: r.id,
  name: r.name,
  port: r.port,
  onion_address: r.onion_address ?? null,
  running: children.has(r.id),
});

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (p === "/api/relays" && req.method === "GET") {
      return json(res, 200, relays.map(dto));
    }
    if (p === "/api/relays" && req.method === "POST") {
      const { name } = await readBody(req);
      if (!name) return json(res, 400, { error: "nameが必要です" });
      const id = crypto.randomUUID();
      const port = await findFreePort();
      const rec = {
        id,
        name,
        port,
        onion_address: null,
        onion_key: null,
        relay_secret_key: crypto.randomBytes(32).toString("hex"),
        dir: path.join(DATA_DIR, "relays", id),
      };
      startRelayProc(rec);
      relays.push(rec);
      saveState();
      ensureOnions().catch(() => {});
      return json(res, 200, dto(rec));
    }
    const mRelay = p.match(/^\/api\/relays\/([0-9a-f-]+)(\/start|\/stop)?$/);
    if (mRelay) {
      const rec = relays.find((r) => r.id === mRelay[1]);
      if (!rec) return json(res, 404, { error: "relayが見つかりません" });
      const action = mRelay[2];
      if (req.method === "DELETE") {
        stopRelayProc(rec.id);
        if (rec.onion_address) await delOnion(rec.onion_address).catch((e) => console.error("onion削除失敗:", e.message));
        relays = relays.filter((r) => r.id !== rec.id);
        saveState();
        fs.rmSync(rec.dir, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      if (action === "/start" && req.method === "POST") {
        startRelayProc(rec);
        ensureOnions().catch(() => {});
        return json(res, 200, dto(rec));
      }
      if (action === "/stop" && req.method === "POST") {
        stopRelayProc(rec.id);
        return json(res, 200, dto(rec));
      }
    }
    if (p === "/api/tor-status" && req.method === "GET") {
      return json(res, 200, { progress: await torBootstrapProgress() });
    }

    // 静的ファイル (vite build成果物)
    if (req.method === "GET") {
      let file = path.join(STATIC_DIR, p === "/" ? "index.html" : p);
      if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(STATIC_DIR, "index.html"); // SPAフォールバック
      }
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
        return fs.createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message ?? e) });
  }
});

/* ---------- WebSocketプロキシ ---------- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    sock.destroy();
    return;
  }
  const target = url.searchParams.get("target") ?? "";
  // target: "local:<port>" (自分のrelay) or "onion:<host>" (外部relay)
  const m = target.match(/^(local|onion):(.+)$/);
  if (!m) {
    sock.destroy();
    return;
  }

  wss.handleUpgrade(req, sock, head, async (clientWs) => {
    let upstream;
    try {
      if (m[1] === "local") {
        const port = Number(m[2]);
        if (!relays.some((r) => r.port === port)) throw new Error("未知のrelayポート");
        upstream = new WebSocket(`ws://127.0.0.1:${port}`);
      } else {
        const host = m[2].replace(/^wss?:\/\//, "").replace(/\/$/, "");
        if (!host.endsWith(".onion")) throw new Error("onionアドレスのみ接続可能です");
        upstream = new WebSocket(`ws://${host}`, {
          agent: onionWsAgent(),
        });
      }
    } catch (e) {
      clientWs.close(1011, String(e.message ?? e));
      return;
    }
    // upstream (特にonion) のopenには数秒かかることがあるため、
    // open前に届いたクライアント送信はキューイングしてopen後に流す
    const pending = [];
    clientWs.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push([data, isBinary]);
      }
    });
    upstream.on("open", () => {
      for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b });
      upstream.on("message", (data, isBinary) => clientWs.readyState === WebSocket.OPEN && clientWs.send(data, { binary: isBinary }));
    });
    upstream.on("close", (code, reason) => clientWs.close(code, reason));
    upstream.on("error", (e) => clientWs.close(1011, String(e.message ?? e)));
    clientWs.on("close", () => upstream.close());
    clientWs.on("error", () => upstream.close());
  });
});

/* ---------- 起動 ---------- */

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await startTor();
  console.log(`tor起動 (control=${torControlPort}, socks=${torSocksPort})`);

  // 前回起動時の孤児strfryが残っていたら停止してから再起動する
  for (const rec of relays) {
    if (rec.pid) {
      try {
        process.kill(rec.pid, 0); // 生存確認
        console.log(`前回のrelayプロセスを停止: pid=${rec.pid}`);
        process.kill(rec.pid, "SIGTERM");
      } catch {
        // 既に終了している
      }
      rec.pid = null;
    }
  }
  await sleep(500);

  // 既存relayを自動再起動
  for (const rec of relays) {
    try {
      startRelayProc(rec);
    } catch (e) {
      console.error(`relay再起動失敗 (${rec.id}):`, e.message);
    }
  }
  ensureOnions().catch(() => {});

  server.listen(HTTP_PORT, () => {
    console.log(`Nostr Onion Messenger: http://localhost:${HTTP_PORT}`);
  });

  const shutdown = () => {
    console.log("shutting down...");
    for (const id of [...children.keys()]) stopRelayProc(id);
    torProc?.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
