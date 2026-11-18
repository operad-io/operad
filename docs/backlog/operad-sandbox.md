# operad-sandbox：访问档——禁入目录与危险命令先行，沙箱壳在后

- 状态：第一版形状已定，已做的点进了 ADR；壳的形态未定
- 涉及 ADR：0025、0010
- 涉及：`operad.md` 决定 7、待决 2（仍未进 ADR）；`operad-plugins.md` 决定 5、6（仍未进 ADR）；`operad-harness.md`（ADR 0022 D3）
- 来源：OpenClaw 的 `tools.exec` 审批规则与沙箱文档；IronClaw；radian 的权限规则（`crates/radian-permissions/README.md`）

## 背景

`operad.md` 决定 7 说生成的步骤默认跑沙箱，壳从 radian 剥出来。壳剥出来之前不能没有防线。OpenClaw 的教训是沙箱默认关、exec 默认 full，于是绝大多数人裸跑；它后来加的审批层有几条规则是对的，直接拿（已进 ADR 0025）。IronClaw 的做法（密钥只在宿主边界注入、出网白名单）和我们的作用域密钥是同一件事。

## 已定，尚未做或未核实

1. 访问档的字段里还有 `cwd`、`outside: "read" | "none"`、`network: "none" | "all" | [host, …]`；这几项代码里没有对应，未做。
2. **内置一份默认访问档**，所有对话和生成的步骤默认用它，用户只能收紧或显式换掉（已做：默认档在 `@operad-io/access-match`，见 ADR 0025 D9；`network` 一项仍未做）：
   - `denyPaths`：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.operad`（当前运行自己的目录除外）、`~/.radian` 的凭据、`~/Library/Keychains`、浏览器的 profile 目录、`.git/config` 与 `.git/hooks`；
   - `denyCommands`：`sudo`、`su`、`rm -rf /`、`rm -rf ~`、`mkfs`、`dd`、`diskutil`、`shutdown`、`reboot`、`launchctl`、`crontab -r`、`git push --force*`、`git push --delete`、`curl … | sh`、`wget … | sh`、对不是自己起的进程的 `kill`、`pkill`、`killall`；
   - `askCommands`：`git push`、cwd 内的 `rm -r`、`brew install`、`npm install -g`、`pip install`、`osascript`、`open`、任何对 `~/.zshrc` 和 `~/.*profile` 的写；
   - `network`：对话默认 `all`；生成的步骤默认 `none`，由 flow 显式给主机列表。
   （bot 一侧和仓库对话按此收紧，生成的步骤由 harness 补上默认档。）
3. 没人答一个询问时，按 `askTimeoutSecs` 超时后拒绝一次。（未核实代码里有这个设置。）
4. **按对象批准「以后都允许」**（下一步做；这次只做了这一次的发送和拒绝）：后台运行碰到对外写时成为一个待处理项，写明对象（发给谁、发到哪个通道或会话、推到哪个仓库和分支、调哪个服务）和要发的完整内容（ADR 0025 D10）。这次的选择是 `send_once` 和 `reject_once`。下一步加「以后都允许」：记成一条授权，绑定这个 flow 的定义加这个对象；同一个 flow 以后对同一个对象写不再问；换了对象、或者 flow 的定义改了（改回原样也算改过），重新问。授权列得出来、能撤销，撤销后下一次重新问。对话里的 `allow_always`（ADR 0025 D3 的精确调用）在后台运行里仍不算数。
   - OpenClaw 的授权绑的是精确命令，不是对象；它的对象说明只给人看，不参与授权（`docs.openclaw.ai/tools/exec-approvals`）。我们按对象绑，是因为同一个 digest 每天内容不同，按精确内容绑就每天都要问。
   - 草稿就是这个待处理项，不另建草稿箱，不加用户词。
5. **MCP 服务的密钥在边界注入**：ADR 0025 D5 延伸到 MCP。远程服务的 token 和 stdio 服务要的密钥由插件在启动服务或发请求时给，不进 bot 的环境变量，bot 的 shell 读不到（NanoClaw 的 vault、Rakazo 和 OpenBot 的后端注入是同一做法）。

## 不过访问档的执行路径（T-0533 后仍未全接）

默认访问档现在由 harness 套在每个对话和生成的步骤上（ADR 0025 D9），dev 的任务 worker 也因此拿到默认档。T-0533 给 shell 的 `command` 和 `check` 接上了对外写检查，给 dev 的 integrate push 也接上了；下面这些还没有接上，留待做：

- `packages/shell/src/index.ts` 的 `shell/probe`；
- `packages/dev/src/git.ts`、`packages/dev/src/editor.ts`，以及 prepare 跑的命令；
- `packages/bot/src/mcp-client.ts` 启动 MCP 服务；
- harness 自己的辅助进程（列模型、安装）。

## 待决问题（未定）

1. 壳的形态（`radian sandbox -- <命令>` 还是独立小程序），继承 `operad.md` 待决 2。
2. 默认访问档放哪：随 operad 安装的只读文件加用户层覆盖，还是写进 `~/.operad/config.json`。
3. 访问档里 MCP 工具那一项的字段形状；读和写怎么判定（MCP 工具自己的只读标注能不能信）。

## 验收

一个对话里让 bot 读 `~/.ssh/id_ed25519`，被拒且对话里能看到原因；让它 `git push --force`，被拒；让它 `git push`，手机上出现一个询问，答 `allow_once` 后执行；`bash -c "rm -rf ~"` 被拒；同一访问档在 radian 和 Claude Code 两种 harness 上行为一致，不一致的项在描述文件里写明；默认访问档有一份测试，列表每加一项测试跟着加。
