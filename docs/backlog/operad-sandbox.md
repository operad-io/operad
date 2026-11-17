# operad-sandbox：访问档——禁入目录与危险命令先行，沙箱壳在后

- 状态：第一版形状已定，已做的点进了 ADR；壳的形态未定
- 涉及 ADR：0025、0010
- 涉及：`operad.md` 决定 7、待决 2（仍未进 ADR）；`operad-plugins.md` 决定 5、6（仍未进 ADR）；`operad-harness.md`（ADR 0022 D3）
- 来源：OpenClaw 的 `tools.exec` 审批规则与沙箱文档；IronClaw；radian 的权限规则（`crates/radian-permissions/README.md`）

## 背景

`operad.md` 决定 7 说生成的步骤默认跑沙箱，壳从 radian 剥出来。壳剥出来之前不能没有防线。OpenClaw 的教训是沙箱默认关、exec 默认 full，于是绝大多数人裸跑；它后来加的审批层有几条规则是对的，直接拿（已进 ADR 0025）。IronClaw 的做法（密钥只在宿主边界注入、出网白名单）和我们的作用域密钥是同一件事。

## 已定，尚未做或未核实

1. 访问档的字段里还有 `cwd`、`outside: "read" | "none"`、`network: "none" | "all" | [host, …]`；这几项代码里没有对应，未做。
2. **内置一份默认访问档**，所有对话和生成的步骤默认用它，用户只能收紧或显式换掉：
   - `denyPaths`：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.operad`（当前运行自己的目录除外）、`~/.radian` 的凭据、`~/Library/Keychains`、浏览器的 profile 目录、`.git/config` 与 `.git/hooks`；
   - `denyCommands`：`sudo`、`su`、`rm -rf /`、`rm -rf ~`、`mkfs`、`dd`、`diskutil`、`shutdown`、`reboot`、`launchctl`、`crontab -r`、`git push --force*`、`git push --delete`、`curl … | sh`、`wget … | sh`、对不是自己起的进程的 `kill`、`pkill`、`killall`；
   - `askCommands`：`git push`、cwd 内的 `rm -r`、`brew install`、`npm install -g`、`pip install`、`osascript`、`open`、任何对 `~/.zshrc` 和 `~/.*profile` 的写；
   - `network`：对话默认 `all`；生成的步骤默认 `none`，由 flow 显式给主机列表。
   （bot 一侧已有按此写的默认档，全局的一份未做。）
3. 没人答一个询问时，按 `askTimeoutSecs` 超时后拒绝一次。（未核实代码里有这个设置。）
4. **不是人当场发起的运行更严**：一个运行如果不是由人在这个对话里的一句话发起的（定时、webhook、来信、别的事件），它对外写的动作一律先问，或者只存草稿等人发：发消息、发邮件、发帖、`git push`、对外部服务的写调用。询问照 ADR 0025 D4 成为待处理项。这类运行里对话里的 `allow_always` 不算数（按对象的授权见下）。来由：Hermes 的定时任务默认拒绝，Rakazo 对 webhook 发起的运行更严，Grok Bot 后台发邮件只存草稿；Grok Bot 上只该读推文的 bot 发了帖，也出在后台运行。（`research/2026-11-11-grok-bot.md`）
   - **什么算对外**（2026-11-17 owner 定）：发给 owner 自己的通道不算对外，白名单里的目标也不算；其余都算对外。白名单写在访问档里（字段形状未定），列通道里的会话、邮箱地址、仓库等目标；owner 自己的通道默认在里面，不用另写。所以每天的 digest 发到 owner 自己的 Telegram 不问；发给别人、发帖、`git push`、对外部服务的写调用，要么先问，要么只存草稿。
   - **批准按对象记**（2026-11-17 owner 定，参照 OpenClaw 的 scoped standing grant）：后台运行碰到对外写时成为一个待处理项，写明对象（发给谁、发到哪个通道或会话、推到哪个仓库和分支、调哪个服务）和要发的完整内容。人可以只批这一次，也可以批「以后都允许」。「以后都允许」记成一条授权，绑定这个 flow 的定义加这个对象：同一个 flow 以后对同一个对象写不再问；换了对象、或者 flow 的定义改了（改回原样也算改过），重新问。授权列得出来、能撤销，撤销后下一次重新问。这取代上面「已有的 `allow_always` 不算数」的说法：对话里的 `allow_always`（ADR 0025 D3 的精确调用）在后台运行里仍不算数，后台运行只认按对象记的这种授权。
   - 草稿就是这个待处理项，带发送和丢弃两个动作，手机和 desktop 上都能点；不另建草稿箱，不加用户词。
   - OpenClaw 的授权绑的是精确命令，不是对象；它的对象说明只给人看，不参与授权（`docs.openclaw.ai/tools/exec-approvals`）。我们按对象绑，是因为同一个 digest 每天内容不同，按精确内容绑就每天都要问。
   - 所有执行路径过同一道检查：harness 里模型调的工具，和插件步骤自己跑的命令、发的请求，都按这一条判。OpenClaw 的定时任务直接写命令时绕过了它的执行审批，这里不能有这个口子。
5. **访问档管 MCP 工具**：访问档加一项，按服务和工具写允许、先问、禁止。默认是：不认识的工具当作写，写的先问（OpenBot 的做法；Cowork 是每个工具三态，按读和写分组）。operad 自己的 MCP 工具（ADR 0028 D4）照它允许列表的规矩，不受这条影响。MCP 返回的内容是资料，不是指令（ADR 0009 D1）。（`research/2026-11-11-grok-bot.md`「技能和 MCP」）
6. **MCP 服务的密钥在边界注入**：ADR 0025 D5 延伸到 MCP。远程服务的 token 和 stdio 服务要的密钥由插件在启动服务或发请求时给，不进 bot 的环境变量，bot 的 shell 读不到（NanoClaw 的 vault、Rakazo 和 OpenBot 的后端注入是同一做法）。

## 待决问题（未定）

1. 壳的形态（`radian sandbox -- <命令>` 还是独立小程序），继承 `operad.md` 待决 2。
2. 默认访问档放哪：随 operad 安装的只读文件加用户层覆盖，还是写进 `~/.operad/config.json`。
3. 已定第 4 条里“对外写”怎么判定：命令列表、插件步骤和 MCP 工具自己声明，还是两者都要；白名单和授权的字段形状。（白名单和自己的通道不算对外、按对象批准、草稿即待处理项，已定。）
4. 访问档里 MCP 工具那一项的字段形状；读和写怎么判定（MCP 工具自己的只读标注能不能信）。

## 验收

一个对话里让 bot 读 `~/.ssh/id_ed25519`，被拒且对话里能看到原因；让它 `git push --force`，被拒；让它 `git push`，手机上出现一个询问，答 `allow_once` 后执行；`bash -c "rm -rf ~"` 被拒；同一访问档在 radian 和 Claude Code 两种 harness 上行为一致，不一致的项在描述文件里写明；默认访问档有一份测试，列表每加一项测试跟着加。
