# Time in the Bottle — 后端规范

> 本文件定义 **Cloudflare Workers + Durable Objects 后端的协议、结构和部署方式**。
> 系统架构背景见 `architecture.md`。

---

## 架构

```
[GitHub Pages UI]  ←→  WebSocket(wss)  ←→  [Worker] → [Durable Object: 一个房间]
                                            /parties/main/{roomId}?_pk={connId}
```

Worker 按 `roomId` 把连接路由到对应 DO（`idFromName(roomId)`）。
后端只有一个职责：**收到某玩家的 ticks，广播给同房间所有人**。
不感知沙粒状态，不感知物理模拟，只传递整数。

---

## 消息协议

### 客户端 → 服务端

```ts
{ type: "join",     name: "Fay" }        // 加入房间
{ type: "progress", ticks: 42 }          // 定时上报击键累计数
```

### 服务端 → 客户端（广播）

```ts
{
  type: "state",
  players: {
    "conn-id-abc": { name: "Fay",   ticks: 42 },
    "conn-id-xyz": { name: "Mina",  ticks: 67 }
  }
}
```

---

## 节流（客户端负责）

```js
const TICK_INTERVAL_MS = 100; // 唯一需要调整的节流参数，10fps

let pendingTicks = null;

function onTick(currentTicks) {
  pendingTicks = currentTicks; // 只保留最新值
}

setInterval(() => {
  if (pendingTicks !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "progress", ticks: pendingTicks }));
    pendingTicks = null;
  }
}, TICK_INTERVAL_MS);
```

服务端收到什么就广播什么，不做额外节流。

---

## 服务端结构（`party/server.ts`）

> ⚠️ 代码中的 `RaceRoom` 类名沿用自旧版本（Project Bar 赛车主题），语义已不符，建议后续重命名为 `SandRoom` 或 `BottleRoom`。

```ts
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/parties\/main\/([^/]+)/);
    if (request.headers.get("Upgrade") === "websocket" && m) {
      const stub = env.RACEROOM.get(
        env.RACEROOM.idFromName(decodeURIComponent(m[1]))
      );
      return stub.fetch(request);
    }
    return new Response("Time in the Bottle room server");
  },
};

export class RaceRoom {          // TODO: 重命名为 SandRoom 或 BottleRoom
  players = {};                  // connId → { name, ticks }
  conns = new Map();             // WebSocket → connId

  async fetch(request) {
    const connId =
      new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.conns.set(server, connId);
    server.send(JSON.stringify({ type: "state", players: this.players }));
    server.addEventListener("message", (e) => this.onMessage(connId, e.data));
    const drop = () => this.onClose(server, connId);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    return new Response(null, { status: 101, webSocket: client });
  }
  // onMessage: join → 建档；progress → 更新整数 ticks；坏/未知消息忽略；然后 broadcast()
  // onClose:   从 conns/players 移除并 broadcast()
  // broadcast: 向 conns 里所有 socket 发 { type:"state", players }
}
```

---

## 配置（`wrangler.toml`）

```toml
name = "time-in-the-bottle"
main = "party/server.ts"
compatibility_date = "2026-06-18"

[[durable_objects.bindings]]
name = "RACEROOM"
class_name = "RaceRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RaceRoom"]   # SQLite 版 DO = 免费套餐可用
```

---

## 前端接入要点

- **自带连接 ID**：用 `?_pk=<随机uuid>` 连接，前端**知道自己的 connId**，渲染广播时跳过自己
- **本地出沙零延迟**：自己的沙粒由本地 `keycount` 事件即时驱动；只有**别人的**出沙速率从广播 `state` 获取
- **房间码**：4 位易读码（去掉 I L O 0 1），存 `localStorage['titb.room']`；菜单「新建 / 加入 / 复制链接」
- **昵称**：`localStorage['titb.name']`，默认 `玩家-<id前4>`，菜单可改，改后自动重连
- **主机解析**：`file://` / `localhost` / `127.0.0.1` → `ws://127.0.0.1:8787`（本地 wrangler dev）；否则 → `wss://<PROD_HOST>`
- **优雅退回单机**：无 `?room=` 参数且未配置 host 时静默不连，不影响单机体验

### WebSocket 连接示例

```js
const roomId  = new URLSearchParams(location.search).get("room")
             || Math.random().toString(36).slice(2, 8);
const myId    = crypto.randomUUID();
const ws      = new WebSocket(
  `${wsProto}://${PARTY_HOST}/parties/main/${roomId}?_pk=${myId}`
);

ws.onopen = () =>
  ws.send(JSON.stringify({ type: "join", name: playerName }));

ws.onmessage = ({ data }) => {
  const { type, players } = JSON.parse(data);
  if (type !== "state") return;
  for (const id in players) {
    if (id === myId) continue;       // 自己本地驱动，跳过
    const { name, ticks } = players[id];
    // 根据 ticks 设置该用户的出沙速率
    setSandRate(id, name, ticks);
  }
};
```

---

## 部署

```bash
# 本地联调（推荐先做，无需账号）
npm run party:dev    # = npx wrangler dev，监听 127.0.0.1:8787
# 浏览器开两个标签：.../index.html?room=TEST&sim

# 上云（异地联机）
npx wrangler login
npm run party:deploy  # 打印 time-in-the-bottle.<子域名>.workers.dev
# 把该地址填进 index.html 的 PROD_HOST
```

### 房间分享 URL 格式

```
https://<你的域名>/?room=ABCD
# Tauri 叠加层需带 #overlay：?room=ABCD#overlay
```

---

## 待决

- **中国大陆可达性**：`*.workers.dev` 常被墙，面向大陆分发时需改用海外 VPS 方案（见 `architecture.md`）
- **服务端类名重命名**：`RaceRoom` → `SandRoom` / `BottleRoom`，需同步更新 `wrangler.toml` 的 binding 配置
