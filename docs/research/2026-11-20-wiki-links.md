# 同类产品怎么把知识关联起来：双链、反向链接和别的做法（2026-11-20）

为 memory 插件的知识库（wiki）和 operad-desktop 的知识库浏览做的调研。问题是：同类产品的 wiki 或知识库支不支持双链，不支持的话靠什么把相关的知识关联起来。

事实和判断分开写：前五节是事实，最后一节是判断，都还不是决定。标 **厂商** 的读过厂商的文档或源码，标 **未核** 的只见过搜索摘要或第三方出处。基准数字大多是厂商自报，只能看方向。一部分网页是通过会做摘要的抓取工具读的，引用原话前要对照原文。

本文里"正向链接"指笔记正文里写的 `[[目标]]` 或 Markdown 链接，"反向链接"指"哪些页面链到这一页"。

## 一览

| 做法 | 代表 | 正向链接谁写 | 反向链接 | 检索时用不用链接 |
|---|---|---|---|---|
| 双链，代码算反向链接 | OpenClaw memory-wiki、Basic Memory、GBrain、nashsu/llm_wiki、Obsidian | 模型或人 | 代码算，存在派生索引里 | 部分用：加分或从命中点扩一两跳 |
| 双链，全靠模型维护 | Hermes 的 llm-wiki skill、Letta、Karpathy 的 gist | 模型 | 没有；模型整理时查孤儿和断链 | 模型自己顺着链接读 |
| 只有索引页和目录层级 | NanoClaw、Claude Code、Codex、Cline、Devin Knowledge、Cursor 规则 | 模型或人 | 没有 | 先读索引再下钻 |
| 模型抽取的知识图谱 | Graphiti/Zep、Cognee、GraphRAG、LightRAG | 模型自动抽实体和关系 | 图里能查，人基本只能看 | 从命中点走 n 跳 |
| 向量相似度 | Reor、Smart Connections、Mem | 没人写 | 不适用 | "相关笔记"推荐 |

所有做了反向链接的产品，反向链接都是代码从正向链接算出来的派生索引。没有一家让模型把反向链接写进目标文件。

## agent 类产品

都是 **厂商**，另标的除外。

- **OpenClaw memory-wiki**（`extensions/memory-wiki`）：
  - 两种链接都解析：`[[目标|标签]]` 和相对 Markdown 链接。生成的链接默认是相对 Markdown，`obsidian` 渲染模式下是 `[[路径|标题]]`。
  - 反向链接由代码在编译时生成。每页有一个由标记包住的 `## Related` 块，分三段：来源、被谁引用（入链，加上把这页当来源的页面）、相关页面（共享同一个 `sourceId`）。
  - 每段最多 12 条；入链超过 24 个的枢纽页不列反向链接。抽链接前先去掉这个块，所以它不会引用自己。开关是 `render.createBacklinks`，默认开。
  - 别的关联：固定目录 `entities/ concepts/ syntheses/ sources/ reports/`，根目录和每个目录各有一份生成的 `index.md`；frontmatter 有 `sourceIds`、`claims[]`（带证据的路径和行号）、`aliases`、带类型的 `relationships`（目标、种类、权重、置信度）。
  - 检查：断链、重复 id、缺来源、声明缺证据、矛盾、过期页面。没找到孤儿检查。
  - 检索：关系字段作为可搜文本进索引。没找到沿链接扩展结果的代码。
- **OpenClaw memory-core**：`MEMORY.md`、每日笔记、`DREAMS.md`，靠向量加关键词搜索关联。文档没提链接语法和反向链接。
- **Hermes Agent 内置记忆**：`MEMORY.md` 和 `USER.md` 是用 `§` 分开的扁平条目，没有链接。会话靠 FTS5 搜索。
- **Hermes 的 `llm-wiki` 可选 skill**：
  - 要求用 `[[wikilinks]]`，每页至少 2 个出链。
  - 不生成反向链接，只让模型"检查已有页面是否链回来"，也就是手工互链。看图只能靠 Obsidian。
  - `index.md` 一页一行（链接加摘要），`log.md` 只追加；frontmatter 有 `type, tags, sources, confidence, contested, contradictions`。
  - 检查由模型临时写脚本做：孤儿、断链、索引是否齐全、矛盾、来源漂移。
- **NanoClaw**：
  - 相对 Markdown 链接，没有 wikilink，没有反向链接。
  - 每个目录一份 `index.md`，模型在增删移动记忆时更新最近的那份。frontmatter 只有 `type` 必填。
  - 检索是模型用 `rg` 和 `find` 搜，然后顺着 Markdown 链接读。没有数据库和向量库。
- **Claude Code 记忆和 Claude API 的 memory 工具**：
  - Claude Code 的文档没有规定链接语法：`MEMORY.md` 是索引，一条记忆一行，主题文件按需读。实际的索引行是相对 Markdown 链接（**未核**，只在本机的 `MEMORY.md` 里见到）。
  - API 的 memory 工具没有链接、索引、标签和搜索，只有文件操作。
  - 都没有反向链接。
- **Codex CLI 记忆**：
  - 笔记之间没有链接。引用的是文件路径和 rollout（线程）id。
  - 来源是单向的：`MEMORY.md` 指向 `rollout_summaries/` 和 `skills/`。回复末尾的引用块记下用了 `MEMORY.md` 的哪几行和哪些 rollout。
  - 检索路径写在提示里：先关键词搜 `MEMORY.md`，再打开它指向的一两份摘要。
- **Letta（context repositories，Letta Code）**：
  - `[[路径]]`，写的是完整路径而不是笔记标题。
  - 不算反向链接。整理的子 agent 负责维护：文件删了或移了，检查有没有 `[[路径]]` 还指着旧位置。
  - 靠文件树和每个文件的 `description` 导航；`system/` 是常驻加载的那层。
  - 检查由模型做：断链、缺索引条目、从核心记忆走不到的外部记忆。

## 模型维护的 wiki 和第二大脑

都是 **厂商**（读的是仓库的文档和源码），另标的除外。

- **Karpathy 的 LLM wiki（gist）**：
  - 没规定链接语法，全文没有 `[[ ]]` 也没有"backlink"这个词，只说页面要互相链接和交叉引用。
  - 链接由模型维护，一次导入可能改 10 到 15 页。
  - 没有代码也没有索引算反向链接。看链接的办法是人在 Obsidian 的图视图里找枢纽和孤儿。
  - 检查是一轮模型过一遍：没有入链的孤儿页、提到了却没有自己页面的概念、缺的交叉引用，以及矛盾和过期。
  - 检索是先读 `index.md` 再下钻，他说在约 100 份来源、几百页的规模上够用，再大建议用 qmd 搜索。
- **nashsu/llm_wiki**（按 gist 做的实现，只读了 README）：
  - 用 `[[wikilink]]`，代码算出一张图，相关度有四个信号：直接链接、共享同一原始来源、Adamic-Adar、同一页面类型。
  - 检索是先搜，再从排在前面的结果按衰减扩两跳。删页时去掉指向它的断链。
  - 给的基准只针对向量检索，没有针对图的。
- **Basic Memory**：
  - 链接可以带类型，写成列表项 `- 关系名 [[目标]]`。不带类型的 `- [[目标]]`、正文里的 wikilink、普通 Markdown 路径链接都记成 `links_to`。
  - 文件是唯一的真相。代码把关系投影到 SQLite 的 `relation` 表：`from_id`、可空的 `to_id`、`to_name`、`relation_type`、`context`。
  - 反向链接是算出来的，从不写进目标文件；遍历的 SQL 两个方向都走。
  - 目标不存在时允许：行里留着 `to_name`，`to_id` 为空，目标被索引后自动接上。删掉目标只把 `to_id` 置空，不删边。
  - 检索：给一个路径或 `memory://` 地址，按深度 1 到 5 递归遍历。没找到按链接给排序加分，也没找到图有帮助的证据。
- **GBrain**：
  - 页面格式：frontmatter，然后是 agent 可以重写的"compiled truth"，再是只追加的带日期时间线。
  - 链接是 Markdown 链接或 `[[目录/slug|名字]]`，由代码抽取，不调模型。关系类型（`works_at`、`invested_in`、`founded` 等）从句子里启发式地猜，猜不出就是 `mentions`。也可以在 `## Links` 表里显式写带类型和有效期的边。
  - 反向链接在数据库里算，有 `get_backlinks`、`get_links`、`traverse_graph`、`find_orphans` 这几个工具。
  - 目标不存在时记进 `wanted_links`，页面出现后建边；有一个命令列出被引用最多的缺页。
  - 检索用到图：入链数给分数乘 `1 + 0.05·ln(1 + 入链数)`，10 个入链约 1.12 倍；关系类问题沿带类型的边走。
  - 证据（厂商自报）：在它自己的 145 道关系类问题上，打开关系检索后 R@5 从 0.6626 到 0.7241。文档撤回了更早的"+31.4 分"说法。
- **Obsidian**（作为参照）：
  - 语法：`[[笔记]]`、`[[笔记#标题]]`、`[[笔记#^块id]]`、`[[笔记|文字]]`；Markdown 链接等价。链接不带类型。
  - 反向链接由应用算。"已链接的提及"是真链接，"未链接的提及"是正文里出现了笔记名但没加链接的地方。
  - 重命名时应用自动改写链接。
  - 命令行有 `backlinks`、`links`、`unresolved`、`orphans`（没有入链）、`deadends`（没有出链）、`aliases`，但需要 Obsidian 应用在运行。
  - 歧义名字的解析规则在读过的页面里没找到；`obsidian-skills` 说按文件名解析，单写 `[[别名]]` 解析不了。
- **Logseq 和 Tana**：
  - Logseq 的单位是块：`((块 id))` 引用一个块并内联显示内容，每个块显示被引用次数。页面链接仍是 `[[ ]]`。
  - Tana 用 supertag 把节点变成带字段模板的类型化对象，靠类型化字段关联而不是自由链接。引用是同一个节点的镜像，有引用计数和"未链接的提及"。
- **只做搜索或相似度的**：qmd 只有 BM25、向量和模型重排，源码里没有 wikilink 和反向链接的处理。Reor 和 Smart Connections 用向量相似度自动列出相关笔记。Khoj 的仓库里搜不到 backlink 和 wikilink（否定结果，证据弱）。
- **Anthropic 的两篇文章**：
  - "The components of agent memory"：wiki 是 Claude 写和维护的一组页面，链接给了 Claude 一张地图；整理时发现 9 个指向不存在页面的链接并改了指向；常驻的那层靠把细节往下挪、留下链接来保持小。
  - 同一篇的数字：只用 wiki 13% 到 48%，只用搜索 53%，两者一起 54% 到 61%，每题省约 2 万 token；跨文档的问题 wiki 87% 对搜索 73%。
  - "Building always-on agents"：记忆是一个文件目录，每次运行只加载索引。没提笔记之间的链接。

## 图谱类记忆框架

都是 **厂商**（文档或论文）。

- **Zep / Graphiti**：单位是情节（原始输入）、实体节点和事实边（主谓宾三元组）。模型抽边，每条边四个时间戳；新事实和旧的矛盾时，把旧边标为失效，不删。检索是余弦相似度、BM25 和从命中点或最近情节出发的广度优先搜索，再重排。Graphiti 自己没有界面，改关系只能走 API 或 MCP。
- **mem0 图记忆**：现在的文档描述的是平台自带的图。从每条记忆里抽实体，边不带类型：两个实体出现在同一条记忆里就算相关。查询里的实体连着的记忆得到排序加分，和向量、BM25 的分数合成一个分。旧设计用外部图数据库和带类型的关系，文档说那个返回字段已不再填。
- **Cognee**：数据点变成图节点，关系库、向量库、图三个存储一起用，本体是 RDF/XML 文件。默认的检索同时搜文本块、摘要和实体的邻域。有本地的图可视化界面，没找到能不能在界面里改。
- **GraphRAG 和 LightRAG**：GraphRAG 由模型抽实体、关系和声明，用 Leiden 聚类成分层的社区并自底向上写摘要；全局问题用社区摘要，局部问题扩到实体的邻居。LightRAG 按文本块抽实体关系图，和向量并存，支持增量更新，明确不用社区报告。
- **独立证据**：
  - arXiv 2607.16848（作者里有自己的系统）：Graphiti 原生得 8.04/10，但每次查询返回约 255 万字符。把上下文限制在约 3 万字符后，只用图的 Graphiti 得 5.27，Cognee 5.28，简单检索 7.25，简单检索加 BM25 7.30。语料是论文，不是对话。
  - Letta 的文章（厂商，有利益相关）：只有文件系统工具的 agent 在 LoCoMo 上 74.0%，高于 Mem0 自报的最好图版本 68.5%。

## 编码 agent 和团队知识库

都是 **厂商**，另标的除外。

- **Devin Knowledge**：单位是一条带触发描述的提示，"相关时才取"。放在嵌套的文件夹里，可以钉到某个或全部仓库。条目之间没有链接。文档标注该功能已弃用，改用 Skills。
- **Devin Wiki / DeepWiki**：页面由生成器规划，或按 `.devin/wiki.json` 里列的生成（最多 30 页）。页面靠 `parent` 组成层级，带指向源码的链接和架构图。不能直接改页面，只能改 JSON 后重新生成。
- **Copilot Memory**：单位是带代码引用的仓库事实。用前对着当前分支核对引用，默认 90 天过期。记忆之间没有关系。人只能看和删，不能直接建和改。
- **Cursor 和 Windsurf 的规则**：规则文件按四种方式挂上：总是、按路径匹配、由 agent 按描述匹配、手动。`@文件` 只是引用，agent 需要时才读。Windsurf 的记忆是自动生成、相关时取（**未核**，文档页已重定向）。
- **Cline Memory Bank**：六个文件，固定的层级（`projectbrief` 往下到 `activeContext` 和 `progress`）。关系只是约定，加上一条"每次任务开始都读全部文件"的指令，文件之间没有链接。
- **Factory**：嵌套的 `AGENTS.md`，向上找到 git 根。建议"链接到真相的来源"，但没有导入机制。
- **Notion**：`@` 或 `[[` 提及会自动建反向链接，显示在页面标题下面。数据库之间的关系带类型，可以双向。AI 用的是反向链接还是向量，文档没说。
- **Confluence + Rovo**：Teamwork Graph 里是带类型的对象，关系有四种：连接器设定的、用户行为产生的、从模式或机器学习推断的、把前几种归组的。Rovo 怎么用它排序是 **未核**。
- **Glean**：连接器建出内容、人和活动的知识图谱，用来给搜索做个性化。排序机制和用户能不能改都没写。
- **笔记工具**：Reflect 是显式的 `[[ ]]` 加反向链接列表，另有基于向量的"相似笔记"。Capacities 明说"反向链接是你自己建的显式链接"，未链接的提及单独列为建议。Mem 以 AI 为主，自动列出相关笔记，`@` 可以建链接，没找到反向链接。Heptabase 没查。

## 各家收敛和分歧的地方

- **收敛**：
  - 反向链接是代码算的派生索引，不写进目标文件。
  - 指向不存在页面的链接保留，页面出现后接上；被引用最多的缺页顺便成了待办清单（Basic Memory、GBrain、Obsidian）。
  - 链接默认不带类型。类型是叠在普通 wikilink 上的可选层：Basic Memory 的列表项前缀，GBrain 的启发式猜测或表。
  - 先读一页索引，加上一轮查孤儿、断链和缺页的检查，是最常见的低成本做法。
- **分歧**：
  - 链接谁维护：代码（OpenClaw、Basic Memory、GBrain）对模型（Hermes llm-wiki、Letta、Karpathy）。
  - 检索用不用图：GBrain 和 nashsu/llm_wiki 用来加分或扩展，OpenClaw 只把关系当文本索引，其余交给模型自己顺着读。
  - 关系人能不能改：写在文件里的链接能看能改能 diff；抽取的图基本只能看，改要走 API。
- **证据**：链接有帮助的数字只有三处，都说明它是搜索的补充而不是替代：GBrain 的关系类问题（自报）、Anthropic 的搜索加 wiki、arXiv 2607.16848 里只用图检索输给简单检索加 BM25。

## 对 operad 的含义

这一节是判断，不是决定。

现状（2026-11-20）：memory 插件只认标准 Markdown 链接。`packages/memory/src/commit.ts` 把不可信笔记从索引里摘掉时只匹配 `](...)`；没有 `[[ ]]` 解析、反向链接和断链检查，搜索和整理也不看链接。用户把 `memory.wikiDir` 指到 Obsidian 库时，库里的 `[[ ]]` 对 operad 只是普通文字。

1. **走"双链，代码算反向链接"这一路**。知识库本来就要让人和 Obsidian 直接改，写在文件里的链接人能看能改，git 里能 diff。
2. **解析两种链接**：`[[ ]]`（含显示文字和 `#标题`）和相对 Markdown 链接。建全文索引时顺带写进 `search.sqlite` 的一张链接表；它和全文索引一样是缓存，删了能重建。不需要模型参与。
3. **反向链接只存在索引里，不写回文件**。写回会和用户在 Obsidian 里的编辑冲突，同行也没有这么做的。OpenClaw 的生成块是唯一接近的做法，它靠标记包住并在抽链接前去掉。
4. **给 bot 一个查询入口，并在整理时查链接**：读一篇笔记时能拿到谁链到它；整理步骤报断链、孤儿和被引用最多的缺页。指向不存在页面的链接保留，不当成错误。
5. **检索加分放到最后**。入链数加权或从命中点扩一跳，等有了自己的测试集再定；现有证据只支持小幅增益。
6. **不做模型抽取的知识图谱**。贵，人改不了，对照实验里没赢过搜索。
7. **带类型的关系以后再说**。要做的话按 Basic Memory 的列表项写法，它兼容普通双链，不带类型的仍然有效。
8. **"未链接的提及"是一个便宜的建议层**（Obsidian、Capacities、Tana），可以放在整理步骤里：正文出现了某页的标题却没加链接。mem0 的实体共现加分是同一个思路。

已经定了的（owner，2026-11-20）：

- 桌面应用里的知识库浏览复用现有文件页，根目录换成知识库目录（operad-desktop T-0198）。
- 文件页支持 `[[双链]]` 和相对链接的渲染和跳转（operad-desktop T-0199）。这一版不做反向链接、frontmatter `aliases` 的解析和后退。
- 索引里用 `[[ ]]` 指向不可信笔记时会不会漏摘，先写测试确认再修（operad T-0595）。

要 owner 定的：

- **要不要做上面列出的链接表、bot 的查询入口和整理时查链接**。
- **"反向链接 / backlinks"这个词**。它是新的用户可见词，出现在命令输出或用户文档里之前要批准，或者换成一句描述。
- **桌面应用以后要不要显示反向链接**。它依赖上面说的链接表；只在本机读文件的话也可以由壳扫一遍目录。

## 出处

- OpenClaw：`github.com/openclaw/openclaw` 的 `docs/plugins/memory-wiki.md`、`docs/concepts/memory.md`、`extensions/memory-wiki/src/{related-pages,markdown-links,compile,lint,markdown,query-scoring}.ts`
- Hermes Agent：`github.com/NousResearch/hermes-agent` 的 `optional-skills/research/llm-wiki/SKILL.md`、`website/docs/user-guide/features/memory.md`
- NanoClaw：`github.com/nanocoai/nanoclaw` 的 `docs/memory.md`、`container/agent-runner/src/memory/templates/{index.md,system/definition.md}`
- Claude：`code.claude.com/docs/en/memory`、`platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool`
- Codex：`github.com/openai/codex` 的 `codex-rs/memories/README.md`、`codex-rs/ext/memories/templates/memories/read_path.md`
- Letta：`letta.com/blog/context-repositories`、`letta.com/blog/benchmarking-ai-agent-memory`；`github.com/letta-ai/letta-code` 的 `src/agent/prompts/letta.md`、`src/agent/subagents/builtin/{reflection,init}.md`、`src/skills/builtin/context-doctor/references/auditing-memory.md`
- Karpathy 的 gist 和实现：`gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`；`github.com/nashsu/llm_wiki`、`github.com/AgriciDaniel/claude-obsidian`（都只读了 README）
- Basic Memory：`github.com/basicmachines-co/basic-memory` 的 README、`docs/{NOTE-FORMAT,MARKDOWN_RELATIONS,DOMAIN_MODEL,DOCTOR}.md`、`src/basic_memory/models/knowledge.py`、`services/context_service.py`、`mcp/tools/{context,move}.py`
- GBrain：`github.com/garrytan/gbrain` 的 README、`docs/architecture/RETRIEVAL.md`、`docs/guides/{page-anatomy,memory-boundaries,line-grammar}.md`、`docs/TOOL_CATALOG.md`、`src/core/search/hybrid.ts`、`src/core/{links-fence,wanted-links}.ts`
- Obsidian：`github.com/obsidianmd/obsidian-help` 的 `Obsidian CLI.md`、`Internal links.md`、`Aliases.md`、`Backlinks.md`、`Properties.md`；`github.com/kepano/obsidian-skills` 的 `obsidian-cli/SKILL.md`、`obsidian-markdown/SKILL.md`
- Logseq、Tana：`github.com/logseq/docs`；`outliner.tana.inc/learn/features/{supertags,nodes-and-references}`
- 搜索和相似度：`github.com/tobi/qmd`、`github.com/khoj-ai/khoj`、`github.com/reorproject/reor`、`github.com/brianpetro/obsidian-smart-connections`
- Anthropic：`anthropic.com/research/components-of-agent-memory`、`claude.com/resources/articles/building-always-on-agents`
- 图谱框架：arXiv 2501.13956（Zep）、`github.com/getzep/graphiti`；`docs.mem0.ai/open-source/features/graph-memory`；`github.com/topoteretes/cognee`、`docs.cognee.ai/core-concepts/{overview,main-operations/recall}`；`microsoft.github.io/graphrag/`；arXiv 2410.05779、`github.com/HKUDS/LightRAG`；arXiv 2607.16848
- 编码 agent：`docs.devin.ai/product-guides/knowledge`、`docs.devin.ai/work-with-devin/deepwiki`；`docs.github.com/en/copilot/concepts/agents/copilot-memory`、`docs.github.com/en/copilot/concepts/context/spaces`；`cursor.com/docs/context/rules`；`docs.devin.ai/desktop/cascade/memories`；`docs.cline.bot/prompting/cline-memory-bank`；`docs.factory.com/cli/configuration/agents-md`
- 团队知识库和笔记工具：`notion.com/help/{create-links-and-backlinks,relations-and-rollups,enterprise-search}`；`developer.atlassian.com/platform/teamwork-graph/`、`.../relationships/`；`docs.glean.com/security/knowledge-graph`；`help.mem.ai/features/editor.md`；`reflect.academy/linking-your-notes`；`docs.capacities.io/reference/backlinks`
- 只见过搜索摘要的（**未核**）：`help.mem.ai/features/collections`、`reflect.app/changelog`、Atlassian 社区的"How Teamwork Graph Powers Rovo"、原 `docs.windsurf.com/windsurf/cascade/memories` 的记忆说明、Roam、Tana 的本地 MCP 服务
