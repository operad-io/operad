# operad-bot-mcp：bot 上的 MCP 服务和浏览器

- 状态：decided（方向；已做的决定移入 ADR，本文件留未做的部分；标「建议」的几条是讨论里提出、owner 没有逐条确认的，开 task 前再问一次）
- 涉及 ADR：0031、0030、0025
- 涉及：`operad-bot.md`；`operad-sandbox.md`（3、8、9、10 留在 backlog；4、6、7 见 ADR 0025 D3、D5、D6）；`operad-conversation.md`（ADR 0028 D4）；`operad-contract.md`（ADR 0009 D1、0010 D2）；`operad-harness.md`（3 见 ADR 0022 D3，4 留在 backlog）
- 来源：`research/2026-11-11-grok-bot.md`「技能和 MCP」；2026-11-11 和 owner 的讨论；`chrome-devtools-mcp` 和 `@playwright/mcp` 的 README 与文档（2026-11-11 读）

## 背景

ADR 0030 D4、D5 和 `docs/backlog/operad-sandbox.md` 的 MCP 工具与密钥两条定了四件事：bot 加 MCP 服务要先问；挂哪些服务写在 bot 的设置里；访问档管 MCP 工具，不认识的当写、写的先问；密钥在边界注入。这一项补上其余的：别家市场里的 MCP 服务怎么拿来用，登记一个服务时人看到什么，以及浏览器怎么接。

MCP 是标准协议，没有"别家的格式"要兼容。各家目录（官方 MCP Registry、Smithery、Cursor 和 Claude 的插件市场）给出的最后都是两种形式之一：一个 HTTPS 地址加 token 或 OAuth，或者一条命令加参数。和技能不同的是，MCP 服务是常驻的代码或一个能看到数据的远程服务，风险多几样：包被替换、工具描述夹带指令、返回内容夹带指令、token 外泄。

别家在这里的教训：Grok Bot 的 bot 能自己加 MCP 服务，基本不设卡，自定义服务的 OAuth 常失败，一个没响应的连接器拖垮所有 MCP 的发现；云端浏览器的机房 IP 被 X 拦在登录之外；一个只该读推文的 bot 发了帖。

## 决定（已定，还没做）

### MCP 服务

1. **登记的第三种输入是一个 HTTPS 地址。** 命令加参数和粘贴 `mcpServers` JSON 两种已做（ADR 0031 D1）；远程服务还不支持。
5. **远程服务先只做 token**（建议）。token 存在插件的 `secrets` 里，按 `docs/backlog/operad-sandbox.md` 的密钥边界一条在请求时带上。OAuth 放到后面：它要 operad 自己走授权流程，Grok Bot 上最常坏的就是这一步。
6. **聚合服务不特殊对待。** Composio、Pipedream 一类就是一个远程 MCP 服务，能登记。用它等于把那些登录态交给它，确认页照实写，用不用由人定。（依赖远程服务。）
7. **第一版只在 claude 上挂第三方 MCP 服务**（建议）。claude 和 radian 原生接受 MCP 服务，pi 只有 `customTools`（ADR 0028 D4）。pi 要挂得由 operad 转接，见待决 1。今天的实现挂在 claude 和 radian 上，pi 不挂并在 bot 页说明。

### 浏览器

9. **浏览器是挂在 bot 上的一个 MCP 服务，不是 operad 的功能。** 用 `chrome-devtools-mcp`（Chrome 团队的，用 Puppeteer 驱动系统里真正的 Chrome），照 ADR 0031 D1 到 D4 登记。`@playwright/mcp` 是备选：它能导入 cookie（`--storage-state`），以后搬到没有屏幕的机器上用得着。
10. **`operad-bot.md`「不做」一条（语音、Canvas、屏幕动作等）排除的是看截图点像素那一种。** 按页面结构读、按元素点击和输入的自动化浏览器是允许的；截图加坐标点击、操作桌面仍然不做。
11. **平时无头。** bot 的浏览器带 `--headless` 运行。
12. **每个 bot 一个自己的浏览器身份。** 浏览器的用户数据目录在 bot 自己的目录下（`--userDataDir`），登录态存在那里。默认访问档本来就禁止碰用户日常浏览器的目录（`docs/backlog/operad-sandbox.md` 的默认访问档一条），不改；不接管用户日常的浏览器。
13. **登录由人亲手做。** bot 上有一个登录动作，指定站点：用同一个目录开一个有界面的窗口，人自己登录、过两步验证，关掉窗口后无头继续用这个登录态。同一个目录同时只能有一个浏览器在用，登录期间这个 bot 的浏览器暂停。模型不经手密码。
14. **登录失效是待处理项。** bot 被踢回登录页或遇到验证码时不自己尝试解：步骤停下，待处理里出现"某站点需要重新登录"，人做一次决定 13 的登录。
15. **有的站点不让被自动化控制的浏览器登录。** `chrome-devtools-mcp` 的文档写明这一点，绕法是人先正常开一个用 bot 目录的 Chrome 登录，再让服务接上去（`--autoConnect` 或 `--browserUrl`）。远程调试端口开着时本机任何程序都能控制这个浏览器，所以只在登录那一会儿开，用完关。
16. **许可按站点，不按每次点击。** 第一次去一个新站点要问；答了"总是允许"的站点内，导航、点击、输入不再逐次问。`--allowedUrlPattern` 把浏览器限制在允许的站点里。`docs/backlog/operad-sandbox.md` 的 MCP 工具一条里的“写的先问”在浏览器上按这条落地。
17. **不是人当场发起的运行只读**（`docs/backlog/operad-sandbox.md` 的后台运行一条）：定时和事件发起的运行可以看页面，不能提交表单；要提交就成为待处理项。
18. **只把用得上的工具给 bot**（ADR 0030 D5）：导航、输入、快照这几组。`chrome-devtools-mcp` 的性能、内存、扩展、执行脚本一类工具不列；执行脚本用它的开关关掉。
19. **X 默认只读**（建议）。发帖、回复、点赞每次都问，没有"总是允许"。用系统里真正的 Chrome，不用自动化工具自带的精简版浏览器。X 的条款不允许未经许可的自动化访问，用登录态去读有被限流或封号的可能；这个风险写在登录动作的说明里，由人决定用哪个账号。
20. **跑在用户自己的机器上。** 用的是家里的 IP，不用云端托管的浏览器。

## 待决问题（未定）

1. pi 的 bot 怎么挂第三方 MCP 服务：operad 做一层转接（MCP 客户端加 `customTools`），还是给 pi 走"一个命令行浏览器工具加一个技能"的路线。后者所有 harness 都能用、更省 token，但许可只能按命令管，比按站点粗。
2. 远程服务的 OAuth 由谁走：operad 的一个基础插件，还是交给 harness 自己（那样 token 在 harness 手里，不合 `docs/backlog/operad-sandbox.md` 的密钥边界一条）。
3. 登录态浏览器要不要作为 `digest` 的 X 来源（`operad-bot.md` 第 4 条、待决 1）：不花钱，但有决定 19 说的风险，时间线内容只能当资料读。
4. operad 搬到没有屏幕的机器上以后怎么登录：在有屏幕的机器上登录后拷目录，还是从日常浏览器导出单个站点的 cookie 导入。
5. "新站点"按什么算（域名、还是带子域名的来源），以及页面里跳到别的站点时怎么问才不烦。
6. 登录动作放在 bot 上还是放在某个站点的待处理项上（词已定：`Log in again`、`I logged in`，`operad-bot.md` 第 11 条；iOS 设计稿两处都有：bot 页的站点行上是 `Log in again`，chat 里和待处理里登录失效的那一项上是 `I logged in`）。

## 验收

在 claude 的 bot chat 里说"加上这个 MCP 服务"并给一条命令：待处理里出现一项，列出命令、版本和工具清单，确认后 bot 能调它的读工具，调写工具时先问。把这个服务的一个工具描述改掉再启动：服务停用，待处理里出现差异。给 bot 登记浏览器：它无头地打开一个没去过的站点前先问；对 X 做一次登录动作，窗口里亲手登录，关窗后 bot 无头读到登录后才能看的页面；让它发一条帖，每次都问；把登录态清掉，bot 不尝试自己登录，待处理里出现"需要重新登录"。一个定时 flow 里让它提交表单：不提交，成为待处理项。整个过程 bot 的环境变量和 transcript 里没有出现任何 token 或密码。
