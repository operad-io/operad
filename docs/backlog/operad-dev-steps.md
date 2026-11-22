# operad-dev-steps：dev 从单线程一步一步走到并行

- 状态：方向 owner 已定（2026-11-22）；下面的形状和细节是草稿，owner 没有逐条确认；没有切任务
- 涉及 ADR：0028 D3（仓库对话在主 clone 只读）、0020 D3 和 D4（dev 在开头加 worktree、结尾加 integrate；改动只经 integrate 到 main）、0020 D9（`commit`）、0021（并发）、0025（访问档）。只读了 0020 和 0028 的正文，其余是估计，开工前核对
- 涉及：`operad-first-run.md`（`Setup Dev`）；`operad-setup-guides.md`（每一步由 bot 提议）；`operad-desktop.md` 待决 4（owner 2026-11-22 已定：没有 remote 的仓库可以加，合并不推送）；`operad-dev-flows.md`
- 来源：owner 2026-11-22 的讨论

## 背景

dev 今天的基本形态是多 agent 加 git worktree：每个任务一个 worktree 和分支，检查、评审之后合进 main 并推送。简单的项目只想要单线程：一个 agent，在自己的目录里改，不想先学 worktree、分支、合并。

## owner 已定（2026-11-22）

1. **仓库对话可以就地工作**：对话直接在主 clone 里写，不开 worktree。要做。
2. **用户一步一步往上走，每一步是一次设置**，起点是第 1 步：
   1. 对话就地工作。
   2. 需要 flow 时：任务在主 clone 里走 flow（就地的 flow）。
   3. 再进一步：任务各有 worktree，一次一个。
   4. 提高并发：今天的工作方式。
3. **"在哪里工作"这个设置的两个值是：主 clone 里的新分支，或 worktree**（owner 2026-11-22）。就地的任务不直接改当前分支：dev 在主 clone 里为任务开一个新分支，任务在那个分支上工作；worktree 照今天的做法。对话在第 1 步是否也开分支，没有定（待决 7）。
4. **用词**（owner 2026-11-22，待决 1 已定）：设置 `workIn`，写在 `.operad/dev.json`，标题 Work in / 工作位置；值 `branch`（A branch in this folder / 本目录的新分支）和 `worktree`（A separate worktree / 独立的 worktree）。四步不单独起名。

## 提议的形状（草稿）

### 两个设置，不是四种模式

四步可以只用仓库的两个设置表达：

| 步 | 在哪里工作 | 并发 | 用户做的事 |
|---|---|---|---|
| 1 | 主 clone | 1 | 只用对话 |
| 2 | 主 clone | 1 | 开始建任务 |
| 3 | worktree | 1 | 改"在哪里工作" |
| 4 | worktree | 2 以上 | 提高并发（已有的 `concurrency`） |

- 新设置只有一个：在哪里工作（主 clone 或 worktree）。名字是新的用户词，等 owner 定（待决 1）。
- 第 1 步和第 2 步的设置相同，区别只是用户有没有开始用任务；所以从 1 到 2 不用改设置，只要 flow 能在主 clone 里跑。
- 约束：在主 clone 工作时并发只能是 1；把并发设成 2 以上而还在主 clone 时拒绝，并说先改哪一个设置。
- 检查命令在四步里是同一份 `dev.json`，往上走不用重新配置。

### 第 1 步：对话就地工作

- 仓库设成在主 clone 工作时，仓库对话的访问档（plan、ask、edits、full）直接作用在主 clone，不再出现 worktree 的提问，提到 edits 或 full 也不开 worktree。
- 设成 worktree 时和今天一样（ADR 0028 D3 原文）。
- 要改 ADR 0028 D3：只读是"在 worktree 工作的仓库"的规则，不是所有仓库的规则。

### 第 2 步：就地的 flow

硬规则换一种说法而不是取消：**改动只有在 flow 的检查通过之后才提交**。在 worktree 里它是"只经 integrate 到 main"；在主 clone 里它是"工作区先变，通过之后 dev 才提交"。要改 ADR 0020 D3、D4 的措辞。

要解决的问题：

1. **开头**：不建 worktree。工作区不干净时怎么办（待决 2）。
2. **分支和提交**（按已定第 3 条）：开头 dev 在主 clone 里从 main 开任务分支并切过去；worker 不自己提交，dev 在任务分支上提交，沿用 `commit: true` 的做法（ADR 0020 D9）；检查（和评审、人的决定）通过后合进 main 并切回 main。合并沿用 integrate，只是不在 worktree 里。没有 remote 或设置不推送时不推送。
3. **检查在哪跑**：今天检查对着提交、在单独的 gate worktree 里跑。就地时在主 clone 里对着工作区跑。
4. **评审**：今天评审的报告写在 gate worktree 的 `.operad/review/` 下。就地时不能把报告留在用户的目录里，要定写到哪。
5. **返工**：回到 code 阶段，在同一个工作区里继续改。
6. **reject 和 cancel**：切回 main，任务分支留着或删掉（待决 3）。改动都在任务分支的提交里，main 不受影响，不再需要在工作区里撤改动。
7. **崩溃后继续**：worktree 可以丢掉重来，主 clone 不行。从记录知道停在哪个阶段，工作区是什么样就从什么样继续。
8. **`changed the main checkout` 的检查**：今天 worker 改了主 clone 会被记成 major finding。就地时改主 clone 是正常的，这条检查对就地的任务不适用。
9. **人同时在改**：防不了，也分不清是谁改的；说明写清楚：就地意味着和 agent 共用一个工作区。

### 一个主 clone 只有一个在写的

- 就地时，仓库对话的一次有写权限的回复和任务的 code 阶段互斥。任务在跑时对话怎么办（只读地答，还是排队）要定（待决 4）。
- 一次一个任务已经由并发 1 保证。

### 往上走和往回走

- 主 clone 改成 worktree：要求没有就地的任务在跑。之后对话回到今天的规则。
- worktree 改回主 clone：要求没有任务在跑、没有留着的 worktree。
- 每一步由 bot 提议、出待处理项、人批准后落盘，和 `Setup Dev` 同一套（`operad-setup-guides.md`）。什么时候提议要定，候选：用户要评审或要"检查过再提交"时提议建任务；用户想在 agent 工作时自己也用这个目录时提议 worktree；任务排队时提议提高并发。
- `Setup Dev` 给新仓库的起点是第 1 步。已有的仓库不变，等于第 3 或第 4 步。

## 等 owner 决定

1. ~~用词~~：已定，见「owner 已定」第 4 条。
2. **就地的任务开始时工作区不干净**：拒绝并说明，还是问人，还是照常开始。建议拒绝并说明，这样 reject 能回到一个明确的起点。
3. **就地的任务被 reject 或 cancel 时任务分支怎么办**：删掉，还是留着可以找回。建议留着，和 worktree 的任务一致。
4. **就地的任务在跑时对话怎么办**。
5. **就地时要不要保留评审阶段**，还是第 2 步的默认 flow 只有 code 和 test，评审留到第 3 步。
6. **新仓库的起点**：所有新仓库都从第 1 步开始，还是 `Setup Dev` 里让人选。

7. **对话就地工作时是否也开新分支**：已定第 3 条说的是"在哪里工作"这个设置；第 1 步的对话是在当前分支上直接改，还是也在一个新分支上改。

## 没有核实的

- 没有读 dev 的代码；上面的"今天"来自 ADR 0020、0028 和 `docs/user/dev.md`、`docs/user/chats-and-bots.md`。
- gate worktree、评审报告的位置、`changed the main checkout` 的检查在代码里各依赖 worktree 多深，没有查；第 2 步的工作量取决于它。
- ADR 0028 D2 把 radian 排除在仓库对话之外，理由是它不能在调用开始前拦住；主 clone 可写之后这个理由还成不成立，没有想清楚。
- pool 插件在第 1 步是否还需要开。

## 验收

- 新仓库走完 `Setup Dev` 之后：在对话里让 agent 改一个文件，改动出现在主 clone 的工作区里，全程没有 worktree 的提问。
- 同一个仓库建一个任务：code 和 test 在主 clone 里跑，test 不过时没有新的提交，过了之后当前分支上多一个提交。
- reject 一个就地的任务：工作区回到任务开始时的样子，用户原有的文件没有丢。
- 改成 worktree 之后行为和今天一样（现有测试全过）；还在主 clone 时把并发设成 2 被拒绝并说明原因。
- 从第 1 步走到第 4 步，`dev.json` 里的检查命令没有改过。
