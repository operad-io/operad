# operad-sandbox：访问档——禁入目录与危险命令先行，沙箱壳在后

- 状态：decided（第一版形状；壳的形态未定）
- 涉及 ADR：0012、0016、0020、0039
- 涉及：`operad.md` 决定 7、待决 2；`operad-plugins.md` 决定 5、6；`operad-harness.md` 决定 5
- 来源：OpenClaw 的 `tools.exec` 审批规则与沙箱文档；IronClaw（WASM 加能力权限）；radian 的权限规则（`crates/radian-permissions/README.md`）

## 背景

`operad.md` 决定 7 说生成的步骤默认跑沙箱，壳从 radian 剥出来。壳剥出来之前不能没有防线。OpenClaw 的教训是沙箱默认关、exec 默认 full，于是绝大多数人裸跑；它后来加的审批层有几条规则是对的，直接拿。IronClaw 的做法（密钥只在宿主边界注入、出网白名单）和我们的作用域密钥是同一件事。

## 决定（已定）

1. **访问档（access profile）是 operad 的一份 JSON**，带 Schema，挂在 flow、对话或仓库设置上：`{ cwd, outside: "read" | "none", denyPaths: [], denyCommands: [], askCommands: [], network: "none" | "all" | [host, …] }`。内核不解释它，只把它交给 harness 步骤。
2. **执行归 harness 插件**：每种 harness 把访问档翻译成自己的机制。radian：权限规则加 tier（`workspace` 管网络）；Claude Code：`--disallowedTools` 加 settings 的 deny/ask 规则；只能一次性跑、没有权限机制的命令适配器：只接受 deny，拒绝带 `askCommands` 的访问档。翻译不了的项，harness 的描述文件写明"不支持"，启动时拒绝而不是忽略。
3. **内置一份默认访问档**，所有对话和生成的步骤默认用它，用户只能收紧或显式换掉：
   - `denyPaths`：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.operad`（当前运行自己的目录除外）、`~/.radian` 的凭据、`~/Library/Keychains`、浏览器的 profile 目录、`.git/config` 与 `.git/hooks`；
   - `denyCommands`：`sudo`、`su`、`rm -rf /`、`rm -rf ~`、`mkfs`、`dd`、`diskutil`、`shutdown`、`reboot`、`launchctl`、`crontab -r`、`git push --force*`、`git push --delete`、`curl … | sh`、`wget … | sh`、对不是自己起的进程的 `kill`、`pkill`、`killall`；
   - `askCommands`：`git push`、cwd 内的 `rm -r`、`brew install`、`npm install -g`、`pip install`、`osascript`、`open`、任何对 `~/.zshrc` 和 `~/.*profile` 的写；
   - `network`：对话默认 `all`；生成的步骤默认 `none`，由 flow 显式给主机列表。
4. **从 OpenClaw 抄的四条规则**：审批只能收紧配置，不能放宽；"永远允许"绑定精确的 argv 和工作目录，换个目录就是新问题；`bash -c`、`python -c`、`node -e`、`osascript -e`、`find -exec`、`xargs` 这类内联代码按内联内容再匹配一次，匹配不了就问；`&&`、`;`、`|` 链的每一段都要过。radian 的 shell matcher 已经做了链和内联的匹配；它的 README 里"看不到什么"一节列的东西按问处理。
5. **询问的去处**：一次 ask 是一个待处理项，对象是对话或任务，iOS、Telegram、命令行都能答；没人答按 `askTimeoutSecs` 超时后拒绝一次。回答有三种：`allow_once`、`allow_always`（绑定 argv 和 cwd，写回访问档的用户层）、`reject_once`。
6. **密钥不进步骤**：作用域密钥（`operad-plugins.md` 决定 6）由 harness 或取数步骤在边界注入到具体的 HTTP 调用，步骤的环境变量里没有裸密钥；`denyPaths` 保证它读不到密钥文件。
7. **壳是第二步**：访问档不是边界，是护栏（OpenClaw 自己的文档也这么说）。真正的边界仍按 `operad.md` 决定 7 做：从 radian 剥出的壳包任何命令，访问档届时成为壳的输入，不换格式。
8. **不是人当场发起的运行更严**（2026-11-11 owner 定，`research/2026-11-11-grok-bot.md`）：一个运行如果不是由人在这个对话里的一句话发起的（定时、webhook、来信、别的事件），它对外写的动作一律先问，或者只存草稿等人发：发消息、发邮件、发帖、`git push`、对外部服务的写调用。询问照决定 5 成为待处理项。这类运行里已有的 `allow_always` 不算数，每次都问。来由：Hermes 的定时任务默认拒绝，Rakazo 对 webhook 发起的运行更严，Grok Bot 后台发邮件只存草稿；Grok Bot 上只该读推文的 bot 发了帖，也出在后台运行。
9. **访问档管 MCP 工具**（2026-11-11 owner 定，`research/2026-11-11-grok-bot.md`「技能和 MCP」）：访问档加一项，按服务和工具写允许、先问、禁止。默认是：不认识的工具当作写，写的先问（OpenBot 的做法；Cowork 是每个工具三态，按读和写分组）。operad 自己的 MCP 工具（`operad-conversation.md` 决定 15）照它允许列表的规矩，不受这条影响。MCP 返回的内容是资料，不是指令（`operad-contract.md` 决定 7）。
10. **MCP 服务的密钥在边界注入**：决定 6 延伸到 MCP。远程服务的 token 和 stdio 服务要的密钥由插件在启动服务或发请求时给，不进 bot 的环境变量，bot 的 shell 读不到（NanoClaw 的 vault、Rakazo 和 OpenBot 的后端注入是同一做法）。
11. **`allow_always` 写进访问档的用户层文件**（2026-11-12 owner 定，原待决 3）：用户层是一份带 Schema 的 JSON 文件，人能打开、手改、删行撤销；所有对话和 harness 读同一份。每条记录照决定 4 绑定精确的命令（或工具加路径）和工作目录，只放行原本会问的调用，碰不到 deny。决定 8 的运行里它照旧不算数。回答本身仍是待处理项的回答，history 里有谁、何时、哪个对话；不另把规则写进事实日志，内核仍不解释访问档。默认访问档放哪（待决 2）不受影响，用户层文件不管默认档在哪都单独存在。

## 待决问题（未定）

1. 壳的形态（`radian sandbox -- <命令>` 还是独立小程序），继承 `operad.md` 待决 2。
2. 默认访问档放哪：随 operad 安装的只读文件加用户层覆盖，还是写进 `~/.operad/config.json`。
3. 决定 8 的“对外写”怎么判定：命令列表、插件步骤和 MCP 工具自己声明，还是两者都要；草稿存在哪、人怎么发出去。
4. 访问档里 MCP 工具那一项的字段形状；读和写怎么判定（MCP 工具自己的只读标注能不能信）。

## 验收

一个对话里让 bot 读 `~/.ssh/id_ed25519`，被拒且对话里能看到原因；让它 `git push --force`，被拒；让它 `git push`，手机上出现一个询问，答 `allow_once` 后执行；`bash -c "rm -rf ~"` 被拒；同一访问档在 radian 和 Claude Code 两种 harness 上行为一致，不一致的项在描述文件里写明；默认访问档有一份测试，列表每加一项测试跟着加。
