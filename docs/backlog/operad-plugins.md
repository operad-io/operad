# operad-plugins：插件运行时、SDK、热加载、安全模型

- 状态：种类、启停、热加载、第三方依赖已进 ADR；下面留 SDK 的其余部分
- 涉及 ADR：0011、0012、0010
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「协议要点」「插件体系」；`research/2026-11-05-noop.md`「决定、门禁、自治」

## 背景

要的循环是：用户描述一个需求 → 一个带 `operad-sdk` skill 的 agent 写出 `~/.operad/plugins/<名字>.ts` 或一个 graph 节点的 TS 文件 → operad 热加载 → 立刻在某个节点上用。这要求 SDK 带版本、SDK 文档作为 skill 发给写插件的 agent、一条一致性检查、改坏了能回退。

危险也在这里：用户或 agent 现写的 TS 步骤，处理的是 Telegram、webhook、邮件里别人写的字。注入和任意代码在同一个地方相遇。

## 决定（已定，还没做，所以留在这里）

2. 插件是 TS 模块，放在固定路径：项目级 `.operad/plugins/` → 用户级 `~/.operad/plugins/` → 内置。项目级只在已信任的项目装载。`operad plugin add <git 地址>` 只 clone，不跑安装脚本。
3'. 每种插件一个一致性检查：`operad plugin check <路径>` 起一个临时引擎跑该种类的契约。
4. SDK 文档以 skill 的形式随 operad 安装，给写插件的 agent 读；插件由 agent 替用户写是预期的主路径。
5. **生成的步骤默认跑在沙箱里**：只读工作目录以外的文件系统、无网络，除非 graph 明确给。沙箱由 radian 剥出来的壳提供（`operad.md` 待决问题 2）。
6. 插件不能做的事：source 决定不了路由（事件带 `cwd`、harness、access 直接拒收）；harness 决定不了权限；stage 只给 verdict；channel 只能回答自己送出的卡片，回答要带送达时的 `ref`；每种插件一把作用域密钥（插件的密钥作用域已进 ADR 0010）。
7. 插件文件有历史，可回退到任一版本；引擎记录每个运行用的是哪个版本。

## 待决问题（未定）

1. SDK 的函数形状：每种插件导出一个对象（`channel({ deliver, listen })`），还是类。
2. 插件自带 npm 依赖怎么隔离（怎么装已定，见 ADR 0012）。
3. 回退用 git 还是引擎自己存版本。
4. 沙箱内放行的最小集合（哪些网络地址、哪些目录）由谁声明：插件、graph 还是用户。

## 验收

一个 agent 按 SDK skill 写出一个 Telegram 通道插件和一个自定义检查节点，不改核心代码；`operad plugin check` 通过；改坏其中一个后一条命令回退；一个会读外部文本的插件在沙箱里尝试越界写文件被拒。
