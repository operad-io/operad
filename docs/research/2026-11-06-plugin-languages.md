# 插件语言与热加载：TypeScript 之外有没有别的选择（2026-11-06）

ADR 0001 D3 把 TypeScript 定为唯一的扩展语言，理由是"扩展面必须是热加载、无构建、agent 几秒钟能写出来的文本"。那条是凭印象定的，这份笔记补上出处和实测。判断单列，其余是核实过的事实。

## 问题

要的循环是：用户描述需求 → agent 写出一个文本文件 → 立刻能用。拆成四个要求：无构建、agent 写得顺、和核心同语言能做类型检查（`operad plugin check`）、对不信任的插件有隔离的办法；再加一条运行时好分发。

## 本机实测（Apple Silicon Mac）

| 项目 | 结果 |
|---|---|
| Bun 1.3.14：运行时 `import()` 一个改过的 TS 文件 | 同一路径返回旧版本（模块缓存）；路径加 `?v=<时间戳>` 返回新版本。无构建热加载成立；每次重载多一个缓存项 |
| `bun build --compile` | 存在，产出单二进制 |
| Bun Worker 里读 `/etc/hosts` | 可以读。Bun 没有权限模型 |
| Deno 2.7.9：Worker `deno.permissions: "none"` | 生效，worker 里 fs 和 net 都是 `NotCapable`，宿主持有两者；需要 `--unstable-worker-options`，API 仍是 unstable |
| `tsc` 5.9.3 检查单个文件（`--noEmit --strict`） | 0.49 秒，类型错误被报出 |
| pyright 检查单个文件（`uvx pyright`） | 1.52 秒 |
| quickjs-emscripten 0.31（QuickJS 嵌在 wasm 里，运行时喂源码） | 引擎加载 8 毫秒，执行 3 毫秒；沙箱内没有 `require`、`fetch`、`process`；可设内存上限和中断；README 自述未经审计 |
| `uv run` 带 PEP 723 内联依赖（httpx）热缓存 | 0.06 秒 |

## 运行时

- **Bun**：热加载和单二进制如上；没有权限或沙箱模型，Worker 和宿主同权限。
- **Deno**：权限是进程级旗标（`--allow-net=example.com` 等，`--deny-*` 覆盖 `--allow-*`）；官方建议不信任代码放进权限更少的 Web Worker，worker 不能超过父进程的权限；`deno compile` 把权限旗标烤进二进制，运行时动态 import 的文件要 `--include`。Worker 权限选项在参考文档里标为 unstable。
- **Node**：权限模型（`--permission`、`--allow-fs-read` 等）自 22.13 起稳定，但文档称它是给可信代码的"安全带"，不是安全边界；`node:vm` 文档明说"不是安全机制，不要用来跑不信任的代码"；isolated-vm 处于维护模式，内存上限只是指导值。
- **Python**：`importlib.reload` 在原模块字典上重新执行，旧引用不重绑、`from x import y` 会过期、不是线程安全；每插件依赖靠 PEP 723 加 `uv run`，`uv python install` 提供托管运行时；进程内沙箱不存在，RestrictedPython 自称不是沙箱。
- **Lua**：mlua 支持 Lua 5.1 到 5.5、LuaJIT 和 Luau，`Lua::sandbox` 只对 Luau 有效。

## WASM 一族

- Extism：宿主 SDK 覆盖 JS（含 Bun，"部分实现 WASI"）等十余种语言；核心 v1.41.0（2026-10）活跃，但 JS 宿主 SDK 的 npm 最新版是 2025-05 的 2.0.0-rc13。JS 插件要先用 esbuild 打包再 `extism-js` 编译（内含 QuickJS-ng 加 Wizer 快照），需要安装 `extism-js` 和 Binaryen；插件里没有事件循环、没有 Node API。能力由 manifest 控制：`allowed_hosts`、`allowed_paths`、`memory.max_pages`。
- Javy：`javy build` 是编译步骤，静态链接产物 869 KB 起，动态链接 1 到 16 KB。
- ComponentizeJS：`jco componentize` 是编译步骤，README 自称实验性，嵌入约 8 MB。
- Zed 扩展：Rust 编译到 `wasm32-wasip2`，安装开发扩展时由 Zed 编译，需要 rustup 工具链；wasmtime 加载；官方博客说选 Rust 是因为不想写 JavaScript，没有对 wasm 做安全承诺。
- IronClaw（NEAR AI）：工具跑在 wasm 里，HTTP 全部经过端点白名单、泄漏扫描、宿主边界注入凭据、响应扫描，能力显式 opt-in；工具用什么语言、怎么编译，公开文档里没找到。
- Bun 的 `WebAssembly` 全局完整；`node:wasi` 是部分实现，`returnOnExit` 被忽略，wasm 里的 `proc_exit` 会退出整个 Bun 进程。

## 同行怎么做

| 产品 | 插件语言 | 构建 | 热加载 | 隔离 | 进程 |
|---|---|---|---|---|---|
| pi | TS | 无（jiti） | `/reload`，agent 运行中不能重载 | 无："和 pi 进程同样的操作系统权限" | 进程内 |
| OpenClaw | TS ESM | 本地源码无，发布要编译 JS | `openclaw plugins reload` | 无沙箱；只有 allow/deny 名单、trust 记录、安装策略 | 进程内 |
| oh-my-pi | TS | 无 | `/reload-plugins` | 无；`--trusted-extension` 白名单 | 进程内 |
| Hermes | Python | 无 | 新会话生效 | 默认进程内；`plugins.isolation: host` 起独立宿主进程，可加 `launcher` 前缀包沙箱；文档称能力是"同意层，不是沙箱" | 两者 |
| nanoclaw | TS，改 fork 代码 | 有 | 无 | 每个 agent 一个 Docker 容器，凭据由网关注入 | 容器 |
| Claude Code | shell hook、Markdown skill、MCP、JS mod | 无 | hook 由文件监视器接管；插件有 reload | 无；"插件以你的身份运行" | 进程为主 |
| Codex | skill、MCP、hook | 未查到 | 新会话 | 未查到 | 进程 |
| Zed 的 agent server | 任意，ACP | 无 | 不适用 | 进程 | 进程 |
| MCP | 任意，stdio | 无 | `list_changed` | 进程边界 | 进程 |
| Obsidian、VS Code | TS 到 JS | 通常有 | 有 | 无；Obsidian："无法可靠地限制插件的权限" | 进程内（VS Code 是共享的扩展宿主进程） |

模式：选择进程内脚本的（pi、OpenClaw、oh-my-pi、Obsidian、VS Code）全部放弃隔离，文档都写"只装信任的来源"；选择进程边界的（Claude Code、Codex、MCP、Zed 的 agent、Hermes 的宿主模式）换来语言自由和崩溃隔离，权限仍要靠外面的沙箱；选 wasm 的只有 Zed 的扩展，代价是 Rust 工具链。

## 判断

1. **TS 站得住，现在有数据。** 无构建热加载在 Bun 上实测成立，单文件 `tsc` 半秒，三个最像 operad 的同行都是 TS 进程内加载。唯一真正的替代是 Python：Hermes 走这条路，uv 让每个插件自带依赖只要几十毫秒，但核心也要是 Python，类型检查慢三倍，隔离同样没有。
2. **"同一个进程"不能作为理由。** 没有任何运行时能在进程内给出真边界：Bun 没有，Node 自己说不是，Python 没有，Deno 的 Worker 权限最接近但 API 不稳定。生成的步骤默认沙箱（`docs/backlog/operad.md` 里尚未进 ADR 的那条）只能是进程加系统沙箱。可信插件进程内跑是快路径，不可信的跨进程，同一份合约。
3. **不换 Deno。** Worker 权限是一层便宜的额外护栏，但 unstable，而且 harness 本来就是独立进程，系统沙箱躲不掉；换运行时配不上 `bun:sqlite`、`bun:test` 已经铺下的成本。API 稳定后可以再看。
4. **第二种语言以后免费。** Hermes 的宿主进程加 launcher 前缀就是"插件宿主"的原型，MCP 是更大的先例；只要步骤继续只走 runner 一条路，加一个 Python 宿主是纯增量，合约不加字段。
5. 两个实现细节：热重载用带版本的 import 路径；QuickJS 嵌 wasm 可以留作"只做纯计算的生成步骤"的零成本沙箱选项，不作为默认。

未核实：Deno 2 的 Worker 权限强度（官方当边界，没有独立审计）；IronClaw 工具的编译流程；各方案的启动时间只有上表一组本机数字。

## 来源

Extism `github.com/extism/extism`、`github.com/extism/js-pdk`、`extism.org/docs/concepts/manifest`；Javy `github.com/bytecodealliance/javy`；quickjs-emscripten `github.com/justjake/quickjs-emscripten`；ComponentizeJS `github.com/bytecodealliance/ComponentizeJS`；IronClaw `github.com/nearai/ironclaw`；Zed `zed.dev/docs/extensions/developing-extensions`、`zed.dev/blog/zed-decoded-extensions`、`zed.dev/docs/ai/external-agents`；Deno `docs.deno.com/runtime/fundamentals/security/`、`docs.deno.com/api/web/~/WorkerOptions.deno`、`docs.deno.com/runtime/reference/cli/compile/`；Bun `bun.sh/docs/runtime/nodejs-apis`；Node `nodejs.org/docs/latest/api/permissions.html`、`nodejs.org/docs/latest/api/vm.html`；isolated-vm `github.com/laverdet/isolated-vm`；Python `docs.python.org/3/library/importlib.html#importlib.reload`；uv `docs.astral.sh/uv/guides/scripts/`、`docs.astral.sh/uv/concepts/python-versions/`；RestrictedPython `pypi.org/project/RestrictedPython/`；mlua `github.com/mlua-rs/mlua`；pi `github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md`；OpenClaw `docs.openclaw.ai/plugins/building-plugins`、`docs.openclaw.ai/tools/plugin`；oh-my-pi `github.com/can1357/oh-my-pi`；Hermes `hermes-agent.nousresearch.com/docs/user-guide/features/plugins`；nanoclaw `github.com/qwibitai/nanoclaw`；Claude Code `code.claude.com/docs/en/plugins`、`code.claude.com/docs/en/hooks`、`code.claude.com/docs/en/mcp`；MCP `modelcontextprotocol.io/docs/learn/architecture`；Obsidian `obsidian.md/help/plugin-security`；VS Code `code.visualstudio.com/docs/configure/extensions/extension-runtime-security`。
