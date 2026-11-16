# operad-desktop-reload-reset：serve 重载时正在看的对话

- 状态：proposed（2026-11-16 T-0522 查「serve 十二小时没重载」时发现；等 owner 决定要不要在 operad-desktop 开 task）
- 涉及 ADR：0029（D1、D2）、0014（显示接口）
- 涉及：`operad-desktop.md`（桌面应用只通过 `/v1` 读写）、`packages/engine/src/http/server.ts`（事件流）
- 来源：T-0522；`~/.operad/serve.log` 2026-11-15 21:56 到 2026-11-16 10:23 那段

## 现在重载时客户端看到什么

- `serve` 换进程时先停 HTTP：每条 `/v1/events` 的 SSE 流直接结束（旧连接不发最后一个事件）。
- 客户端按 SSE 的规矩重连，带 `Last-Event-ID: <旧 bootId>-<seq>`。新进程的同一接口看到 bootId 不是自己的，回一条 `event: reset\ndata: {}`，不重放。
- 所以断流期间变了的对象没有逐个事件，只有这一条 reset：客户端必须自己重新读它正在显示的东西（对话回复的 `get`/`section`），否则那段回复在旧进程里写完、断流时没送出的部分不会出现。

## 要做的

1. 在 operad-desktop 里确认：事件流结束时重连；收到 `reset` 时重读当前页面（对话页重读正在看的那条回复和它的 log section），不是只等事件。
2. 如果要改，在 operad-desktop 开 task；operad 这边不改客户端，也不改接口（reset 已经是这个意思）。
