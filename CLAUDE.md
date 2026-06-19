# Time in the Bottle — Claude Code 契约

> 这是跨 session 的硬约束文件。Claude Code 每次启动必须读取并遵守。
> 会演化的完整方案放在 `doc/` 目录下各专项文档，本文件只放硬规则，保持精简。
> 不确定某个改动是否违反约束时，**先提问，不要直接改**。

---

## 这是什么

一个透明、始终置顶的桌面叠加层（"智能贴纸"，Bongo-Cat 式悬浮），把多人实时数字劳动数据可视化为**像素沙粒落入瓶中**：每位参与者的键盘输入化为带颜色的沙粒，在共享的沙井中堆积、沉降、形成地质层。基调是轻松的派对感，是"带数据叙事的工具"。

---

## 核心不变量

1. **沙粒物理在客户端本地计算。** 服务端只传递整数 `ticks`（击键次数），**绝不**传递沙粒坐标、颜色或物理状态。各客户端根据 ticks 自行驱动本地像素沙模拟。

2. **UI 与外壳解耦，方向不可反。**
   - `index.html` = 纯 Web（无框架、无构建步骤），托管在 GitHub Pages，任意设备可改。
   - Tauri 外壳只**加载** Pages 的 URL；在本地按系统构建。
   - 外壳不承载 UI 逻辑；UI 不依赖外壳才能在浏览器里跑。

3. **原生边界。**
   - 全局输入统计**只在 Rust 层**做（rdev），webview **永不**直接读全局输入。
   - webview 只通过 Tauri 事件 `keycount` 接收整数计数，再驱动沙粒生成。
   - 隐私红线：**只对输入计数**，绝不记录具体键位内容，绝不记录输入文本。

4. **后端 = Cloudflare Workers + Durable Objects。** 后端只做一件事：把某玩家的整数 `ticks` 广播给同房间所有人。**不感知沙粒状态，不感知物理模拟。** 完整协议见 `doc/backend.md`。

5. **无构建步骤约束。** 纯 HTML/CSS/vanilla JS，不引入前端框架或构建工具，保持 GitHub Pages 可直接编辑。除非显式批准，否则此约束不可更改。

---

## 平台规则

- **Windows 是当前主力开发/构建目标**，macOS 之后支持。
- **Tauri 不跨平台编译**：Windows 包在 Windows 上构建，macOS 包在 macOS 上构建（或用 CI）。
- UI 层（网页）跨平台免费，两端渲染一致。
- macOS 额外项（以后处理）：透明需 `macOSPrivateApi: true`；全局输入需"输入监控"授权。

---

## 仓库结构

```
index.html          # 主 UI（纯 Web，Pages 托管）
README.md
CLAUDE.md           # 本契约（必读）
doc/
  game-design.md    # 游戏设计：玩法、成就系统、游戏化机制
  frontend.md       # 前端设计：CSS 变量、组件、动效、canvas 规格
  architecture.md   # 系统架构：分层、数据流、技术选型
  backend.md        # 后端规范：协议、DO 结构、部署
  hardware.md       # 硬件接口（预留）
package.json        # Tauri CLI + wrangler 工具
src-tauri/          # Tauri 外壳（本地构建）
party/server.ts     # Cloudflare Worker + Durable Object
wrangler.toml       # Cloudflare Workers 部署配置
```

---

## 给 Claude Code 的护栏

- **不要**给网页 UI 引入前端框架或构建步骤。
- **不要**把输入统计逻辑搬进 webview。
- **不要**让后端感知沙粒状态或物理模拟；后端只传整数 `ticks`。
- **不要**在服务端存储或传输任何键位内容。
- 改动 `doc/architecture.md` 中的技术选型前，必须先说明理由并等待确认。
