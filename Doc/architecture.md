# Time in the Bottle — 系统架构

> 本文件定义**系统分层、数据流和技术选型理由**。
> 变更技术选型前必须在本文件说明理由，并在 `CLAUDE.md` 中确认是否影响硬约束。

---

## 系统分层结构

核心三层，硬件端为可选扩展层：

```
                        ┌─────────────────────────────────────────────┐
                        │  Layer 1 · Web UI                            │
                        │  纯 HTML/CSS/vanilla JS，GitHub Pages 托管   │
                        │  canvas 像素沙物理 + 排行榜 + 沉积交互        │
                        │  接收 ticks（本机/硬件）/ 房间状态（后端）     │
                        └──────────▲──────────────────▲───────────────┘
                                   │ Tauri 事件        │ WebSocket(wss)
                                   │ 'keycount'        │ 房间状态广播
          ┌────────────────────────┴──────┐  ┌─────────┴──────────────┐
          │  Layer 2 · Tauri 外壳 (Rust)   │  │  Layer 3 · CF Workers  │
          │  透明/无边框/置顶 原生窗口      │  │  每房间一个 DO 实例     │
          │  加载 Pages URL               │  │  收 ticks → 广播 state  │
          │  全局输入统计 (rdev)           │  │  不感知沙粒/物理模拟     │
          │  写本地文件持久化              │  └────────────────────────┘
          └──────────────┬────────────────┘
                         │ 可选：ticks 输入源
          ┌──────────────┴────────────────┐
          │  Layer 4 · 硬件端（可选）      │
          │  专用显示设备 / 传感器          │
          │  作为额外的 ticks 输入源       │
          │  或作为独立的可视化显示器       │
          │  接口方案待定（见 hardware.md） │
          └───────────────────────────────┘
```

---

## 数据流

### 单机闭环（Stage 1）

```
你打字/点击
  → Rust (rdev) 监听 KeyPress/ButtonPress → 累加 count
  → emit('keycount', count) 给 webview
  → webview：生成对应颜色沙粒，执行本地物理模拟
  → 每 25 次写入本地文件（app_data_dir/keycount.txt），重启恢复
```

### 多人房间（Stage 2）

```
本机 count
  → 前端节流（10fps）→ ws.send({ type:'progress', ticks })
  → 房间 DO 合并 → 广播 { type:'state', players: { id: { name, ticks } } }
  → 各端：根据对应玩家 ticks 决定该用户出沙速率
  → 沙粒轨迹各自本地计算（不同步物理状态）
```

**关键决策：物理模拟完全本地化**
- 原因：多人同时高频输入时，同步每颗沙粒的坐标成本极高（带宽 + 延迟）
- 后果：不同客户端上同一房间的画面不完全一致（沙粒分布不同），但出沙速率一致
- 接受度：视觉差异可接受，重要的是"大家都在倒沙"的共同感

### 硬件端接入（待定）

硬件端只是另一种 ticks 输入源，接入后数据流与本机键盘输入等价：

```
硬件传感器 / 设备
  → 通过待定接口（USB HID / BLE / 串口 / WebSocket）提供 ticks
  → 软件端像对待本机 keycount 一样处理
  → 或作为独立显示器，接收并渲染房间状态
```

具体接口方案见 `doc/hardware.md`（待确认后填充）。

---

## 技术选型

### 为什么 Web + Tauri

产品主体是数据可视化 UI，Web 做 UI 最快、迭代成本最低。透明叠加层 + 全局输入在任何路线都需要原生能力，Tauri 的原生适配面最小、最轻。其他技术路线（如游戏引擎）留给后续阶段按需评估，不在当前阶段排除。

### 为什么 Cloudflare Workers + Durable Objects

- "每房间一个 DO 实例"与本产品的"房间"模型 1:1 对应，服务端只有约 50 行代码
- 本地开发零摩擦：`npx wrangler dev` 起 localhost 实例，两个浏览器标签即可联调
- 免费套餐可用（需 SQLite 版 DO：`new_sqlite_classes`）
- 省去局域网主机方案的痛点（找 IP、同 WiFi、放行端口、主机下线房间消失）

### 为什么不用 PartyKit

PartyKit 是 CF DO 的便利包装，但其共享域名 `partykit.dev` 撞到 Cloudflare"单域名最多 10000 子域名"上限，2026-06 起免费新部署全部失败。直接用其底层 CF DO 绕开此限制，技术栈等价。

### 为什么 rdev

跨平台全局输入监听，能逐次捕获 `KeyPress`/`ButtonPress` 用于计数，无需记录内容。

---

## 跨平台计划

| 层 | Windows（现在） | macOS（以后） |
|---|---|---|
| Web UI | 免费一致 | 免费一致 |
| 透明置顶 | `transparent:true` 即可 | 需 `macOSPrivateApi:true`（上架受限）|
| 全局统计 | 免授权直接跑 | 需"输入监控"授权；rdev 可能需独立进程 |
| 打包 | 本机构建 .exe/.msi | **必须在 Mac 上**构建 .app/.dmg |
| 后端 | CF Workers + DO，与系统无关 | 同左 |
| 硬件端 | 待定 | 待定 |

---

## 已知风险

- **rdev 焦点夺键（Tauri #14770）**：rdev 在 Tauri 进程内时，Tauri 窗口获得焦点会收不到键盘事件。缓解：`device_event_filter(Never)`；终极方案是独立监听进程。
- **大陆可达性**：`*.workers.dev` 在中国大陆常被限速/墙。原型阶段 VPN 可接受；面向大陆免 VPN 分发需改用海外 VPS + 非 Cloudflare 域名。
- **DO 免费套餐**：必须用 SQLite 版（`new_sqlite_classes`）才可用，部署失败需检查账号计划。
- **杀软告警**：全局输入钩子像键盘记录器，Windows Defender/SmartScreen 可能提示，自机放行即可。
- **物理性能**：活跃粒子上限 5000 颗（见 `frontend.md`），超出自动压缩，避免 CPU 占用过高导致用户卸载。

---

## 阶段计划

### Stage 1 · 单机（已完成）

- Tauri v2 外壳，透明/无边框/置顶，加载 Pages URL
- rdev 全局输入统计，emit 到 webview
- 本地 canvas 像素沙基本运行（沙粒生成 + 重力 + 堆积）
- 本地计数持久化

### Stage 2 · 多人（进行中）

- Cloudflare Workers + DO 房间后端（协议见 `backend.md`）
- 前端 WebSocket 客户端接入
- 多用户出沙速率同步
- 房间码创建/加入/分享流程

### Stage 3 · 产品化（以后）

- 沉积冻结与快照压缩展开（1px 细条堆叠 + 滑动展开）
- 成就系统（里程碑触发成就物件落入并永久封存）
- 游戏化系统（赌注、暴击、非操作性累积等，详见 `game-design.md`）
- 双形态（小窗叠加层 ↔ 展开面板）
- 皮肤/主题系统（利用现有 CSS 变量）
- 硬件端接入（专用显示设备或传感器输入，见 `hardware.md`）
