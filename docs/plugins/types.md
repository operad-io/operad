---
description: Every type of @operad-io/engine, /platform and /testing that a plugin uses, with the page that explains it.
---

# Types

The types a plugin imports, by the page that explains them. The values these entry points export are in [Exports](exports.md); a test (`scripts/test/plugin-docs.test.ts`) checks both lists against the pages.

| Type | What it is | Page |
|---|---|---|
| `ActionArgSchema` | One property of an action's arguments. It is the JSON Schema subset the kernel validates: `type`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `items`, `properties`, `required`,... | [actions](actions.md) |
| `ActionArgType` | The value types an action argument may have. | [actions](actions.md) |
| `ActionArgsSchema` | The arguments of an action: a JSON Schema object. | [actions](actions.md) |
| `ActionContext` | The context an action receives. `runId` is set when it answers a person wait. | [actions](actions.md) |
| `ActionEnv` | What an action's checks may read: the object store, never write. | [actions](actions.md) |
| `ActionEvent` | An event an action sends: the person's client is the source. | [actions](actions.md) |
| `ActionOutcome` | What an action returns when it created an object: the line of text a person reads, and `opens`, the object as `type:id`. Returning only text still works. The kernel, the client API and HTTP pass... | [actions](actions.md) |
| `ActionRun` | An action that ran, with the value its plugin returned. | [actions](actions.md) |
| `ActionRunOptions` | Options for running an action through the registry. | [actions](actions.md) |
| `ActionTypeDefinition` | An action a plugin offers on an object type. | [actions](actions.md) |
| `Answer` | The answer a plugin action gives to the person wait it is answering. | [actions](actions.md) |
| `CommandContext` | The context a command verb receives. | [actions](actions.md) |
| `CommandDefinition` | A CLI verb a plugin declares. | [actions](actions.md) |
| `CommandRun` | A command that ran, with the value its plugin returned. | [actions](actions.md) |
| `CommandRunOptions` | Options for running a command through the registry. | [actions](actions.md) |
| `PendingActionView` | One action the pending view offers for a waiting run. | [actions](actions.md) |
| `ResolvedCommand` | Where a command resolved: always `<plugin> <verb>`, optionally `<verb>`. | [actions](actions.md) |
| `AskAnswer` | The answer `ctx.ask` returns. | [asking](asking.md) |
| `AskOutcome` | What the host reports back for one question a step asked. | [asking](asking.md) |
| `AskRequest` | What a step asks a person with `ctx.ask`. | [asking](asking.md) |
| `AskWaitingData` | The data of a step that ended `waiting` because an ask timed out. | [asking](asking.md) |
| `StepAsker` | Where a step's questions go. `request.graceSecs` already holds the narrower of the call and the step's `askGraceSecs`; the host narrows it by its own setting. | [asking](asking.md) |
| `ActionInfo` | One action a client may offer, with what it needs from the person. | [define-plugin](define-plugin.md) |
| `Actor` | Who a person input came from. `via` is a client such as `cli` or `ios`. | [define-plugin](define-plugin.md) |
| `ConfiguredPlugin` | One configured plugin and the definition it resolved to, if any. | [define-plugin](define-plugin.md) |
| `ConfiguredPlugins` | What reading the plugins list produced, before the registry validates them. | [define-plugin](define-plugin.md) |
| `KeyBinding` | Where a key binding came from. | [define-plugin](define-plugin.md) |
| `LoadPluginRegistryOptions` | Options for loading the registry from the operad home. | [define-plugin](define-plugin.md) |
| `PluginBaseContext` | Fields every plugin hook receives. | [define-plugin](define-plugin.md) |
| `PluginCheck` | The result of one plugin's optional `check`. | [define-plugin](define-plugin.md) |
| `PluginDefinition` | A plugin definition ready for the registry. | [define-plugin](define-plugin.md) |
| `PluginKind` | The plugin kinds the kernel recognises. These names are internal: user text never names a kind. | [define-plugin](define-plugin.md) |
| `PluginRefusal` | A plugin the registry left out, and the line that says why. | [define-plugin](define-plugin.md) |
| `PluginRegistryOptions` | Options for building a registry from plugin definitions. | [define-plugin](define-plugin.md) |
| `PluginRequires` | A plugin's declared dependencies: plugins and the plugin API version. | [define-plugin](define-plugin.md) |
| `PluginShape` | The shape `definePlugin` accepts. The version is added by the helper. | [define-plugin](define-plugin.md) |
| `CronField` | A five-field cron expression, evaluated in the machine's local time zone. | [events](events.md) |
| `CronSchedule` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `EventFilePaths` | The paths an event's summary and data files use inside the store. | [events](events.md) |
| `KernelOptions` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `LoadTriggerRulesOptions` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `PendingStart` | A start whose run metadata may not be written yet. It is written before the run exists, so a process that dies between `startRun` and the run's own start files loses nothing: whoever finds the... | [events](events.md) |
| `RefusedStart` | An event routed to a flow that cannot start yet, and why. | [events](events.md) |
| `RunLookup` | What a plugin may ask the kernel about runs while it ticks. `serve` supplies it; a registry used on its own leaves it undefined. | [events](events.md) |
| `SourceContext` | The context a source plugin's `start` receives. | [events](events.md) |
| `SourceEvent` | An event a source plugin sends; the kernel adds nothing but validation. | [events](events.md) |
| `SourceHandle` | A running source plugin. | [events](events.md) |
| `SourcedTriggerRule` | One rule and where it came from: `user`, or the plugin that shipped it. | [events](events.md) |
| `StartRequest` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `StartResult` | What starting one run did. | [events](events.md) |
| `StartRunRequest` | Asks the kernel to start a run of one of the plugin's flows. | [events](events.md) |
| `StepEvent` | An event a step sends; the kernel adds the source, run scope and hops. | [events](events.md) |
| `StoredTriggerEvent` | One stored event, kept even when no rule matches. | [events](events.md) |
| `TickContext` | The context the kernel loop passes to a plugin's `onTick`. | [events](events.md) |
| `TickStartRequest` | What `ctx.start` accepts on a tick: a flow name, or a full request. | [events](events.md) |
| `TriggerCandidate` | A candidate the pending view offers to start or dismiss. | [events](events.md) |
| `TriggerEvent` | What a source, the CLI or a step sends. | [events](events.md) |
| `TriggerMode` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `TriggerResult` | What handling one event did. | [events](events.md) |
| `TriggerRule` | One routing rule from `triggers.json`. | [events](events.md) |
| `TriggerStoreOptions` | A type of the plugin API; its fields are described on the page. | [events](events.md) |
| `TriggerView` | What a step sees as `ctx.trigger`; read-only, and file paths only. | [events](events.md) |
| `CheckStep` | The steps `defineFlow` accepts are checked here, after their literals are inferred, so a wrong result name in `next` is a compile error. A missing edge is not: runtime validation reports it with... | [flows](flows.md) |
| `CheckSteps` | A type of the plugin API; its fields are described on the page. | [flows](flows.md) |
| `EndStatus` | How a flow ends. | [flows](flows.md) |
| `EndStep` | Finishes the flow. | [flows](flows.md) |
| `FlowDefinition` | A flow definition: structure is data, step logic lives elsewhere. | [flows](flows.md) |
| `PluginStep` | Calls a step type declared by a plugin. | [flows](flows.md) |
| `Replay` | How a step behaves when a run resumes after a crash. | [flows](flows.md) |
| `Step` | A type of the plugin API; its fields are described on the page. | [flows](flows.md) |
| `StepBase` | Fields every step has. | [flows](flows.md) |
| `StepKind` | The internal names of the four basic steps. Users see only "step". | [flows](flows.md) |
| `StepShape` | The shape a step must have before validation. `params` and `next` stay `unknown` here so that `defineFlow` keeps the literal result keys a caller wrote; validation and the conditional step check... | [flows](flows.md) |
| `StepType` | One step type a plugin declares. | [flows](flows.md) |
| `StepTypeRegistry` | The step types validation may see. A single declaration or a list of them. | [flows](flows.md) |
| `WaitPersonStep` | Asks a person; the turn ends and the process holds nothing while waiting. | [flows](flows.md) |
| `WaitStep` | Waits for a time or for a plugin step's exit to change. | [flows](flows.md) |
| `AgentResultData` | What every harness `agent` step records as its facts. | [harness](harness.md) |
| `AgentResultName` | The result names a harness `agent` step declares: a subset of `EndResult`. | [harness](harness.md) |
| `AgentStepParams` | The params every harness `agent` step accepts. | [harness](harness.md) |
| `CostQuality` | A type of the plugin API; its fields are described on the page. | [harness](harness.md) |
| `EndResult` | A type of the plugin API; its fields are described on the page. | [harness](harness.md) |
| `HarnessEfforts` | The efforts a harness plugin declares: those a chat may pick, the one used when none is set, and the step argument that sets it (`--effort` when absent). | [harness](harness.md) |
| `HarnessModels` | The models a harness plugin declares: those a chat may pick, and the one used when none is set. | [harness](harness.md) |
| `PromptFlowParams` | The fixed params of every `<harness>:prompt` flow. | [harness](harness.md) |
| `Usage` | What one run used. `costMicros: null` is an unknown cost; a free run is 0. `costQuality` is null exactly when the cost is unknown. | [harness](harness.md) |
| `UsageCheck` | A type of the plugin API; its fields are described on the page. | [harness](harness.md) |
| `UsageTokens` | The token counts of a run. Counts a harness does not know are 0. | [harness](harness.md) |
| `PendingEntry` | An entry in the pending view: a waiting run, its object and its actions. | [pending](pending.md) |
| `StandingContext` | The context a plugin's `standing` hook receives. | [pending](pending.md) |
| `StandingItem` | One thing a plugin asks a person to know about; it waits on no run. | [pending](pending.md) |
| `WaitingRun` | A run waiting for a person. The kernel supplies these to the pending view. | [pending](pending.md) |
| `Clock` | The timers a line run reads. A test injects its own to control timeouts. | [platform](platform.md) |
| `Ended` | How the line's own shell ended. | [platform](platform.md) |
| `Exit` | A type of the plugin API; its fields are described on the page. | [platform](platform.md) |
| `FollowOptions` | Whether an open subscription follows changes another writer makes. A command that answers once and exits passes false: it has nothing to follow. | [platform](platform.md) |
| `GroupStopOptions` | What the stop of one sentinel-led group reads while it runs. | [platform](platform.md) |
| `ImmediateWriter` | The two calls `writeImmediate` makes; a `Database` has both. | [platform](platform.md) |
| `LineOutcome` | A type of the plugin API; its fields are described on the page. | [platform](platform.md) |
| `LineRunOptions` | A type of the plugin API; its fields are described on the page. | [platform](platform.md) |
| `LockFileOptions` | What a waiter may inject: the clock, how it waits, and where a log goes. | [platform](platform.md) |
| `MachineLoad` | The 1-minute load average and the number of cores. | [platform](platform.md) |
| `MarkedProcess` | A live process that carries a marker. | [platform](platform.md) |
| `ProcessLister` | Lists the user's live processes that carry a marker. | [platform](platform.md) |
| `ProcessRow` | One live process of the user, from the process table. | [platform](platform.md) |
| `ProcessTable` | Reads the user's process table. | [platform](platform.md) |
| `ReapOptions` | A type of the plugin API; its fields are described on the page. | [platform](platform.md) |
| `Reaped` | The part of a stopped process the logs show. | [platform](platform.md) |
| `Startup` | The first line the sentinel writes: it is ready, or the shell is gone. | [platform](platform.md) |
| `StepMarker` | Who a step is: the run it belongs to, its name, and the home it runs in. | [platform](platform.md) |
| `SubscriptionWatch` | The watch, the fallback timer and its period one subscription uses. | [platform](platform.md) |
| `SubscriptionWatchOptions` | What an owner lets a test replace: the period, the timer and the watch. | [platform](platform.md) |
| `WorkerReports` | The two things a worker run reports to the step that asked for it. | [platform](platform.md) |
| `AccessProfile` | An access profile: opaque JSON the kernel hands to steps. Its shape belongs to `operad-sandbox.md`, not to the kernel. | [settings](settings.md) |
| `KeyBindings` | A key binding a plugin brings as its default. | [settings](settings.md) |
| `ProjectSettingsDeclaration` | The project settings a plugin declares. | [settings](settings.md) |
| `ProjectSettingsFile` | One settings file under a repository's `.operad/`, with its schema. | [settings](settings.md) |
| `SettingsRepository` | A repository a plugin has registered. | [settings](settings.md) |
| `Fact` | A fact as it is stored and read. | [steps](steps.md) |
| `JsonValue` | A value that JSON can represent without losing anything. | [steps](steps.md) |
| `MaybePromise` | A synchronous value, or a promise of one. Plugin hooks may use either. | [steps](steps.md) |
| `PluginStepResult` | What a step returns. `result` must be one of the step type's results. | [steps](steps.md) |
| `RunControl` | What a plugin may ask the kernel to do with a run it owns. | [steps](steps.md) |
| `StepContext` | The context a step run receives. | [steps](steps.md) |
| `StepLimitDefinition` | Where a step type's concurrency is limited. `key` names what is shared (a model, an account); `undefined` means this call is not limited. `concurrent` is how many calls under one key may run at... | [steps](steps.md) |
| `StepLimitRequest` | A held place under a limit key; `release` gives it back. | [steps](steps.md) |
| `StepLimiter` | Hands out places under limit keys to steps a step starts with `runStep`. | [steps](steps.md) |
| `StepLineReceiver` | Takes one log line of a step as it is written. | [steps](steps.md) |
| `StepRunOptions` | Options for running a step through the registry. | [steps](steps.md) |
| `StepTypeDefinition` | A step type a plugin declares. The use name is `<plugin>/<name>`. | [steps](steps.md) |
| `FactInput` | A fact a plugin appends for itself, outside the objects it owns. | [storage](storage.md) |
| `FactWriter` | Appends facts that are not an object change, such as a step's output path. | [storage](storage.md) |
| `FactsOptions` | Options for reading one object's facts. | [storage](storage.md) |
| `FactsPage` | One page of an object's facts in sequence order, and where to continue. | [storage](storage.md) |
| `ListOptions` | Options for reading one page of objects. `where` holds equality filters on fields the object type declared in `index`; `cursor` continues a page. | [storage](storage.md) |
| `ListPage` | One page of objects, ordered by id, and where to continue. | [storage](storage.md) |
| `MemoryPluginStoreOptions` | Options for the in-process plugin store: nothing it keeps survives the process. | [storage](storage.md) |
| `ObjectStore` | The object side of the store. A plugin reads and writes objects here and never touches the storage backend. | [storage](storage.md) |
| `OpenPluginStoreOptions` | A type of the plugin API; its fields are described on the page. | [storage](storage.md) |
| `PluginFact` | One fact a plugin sees. Facts hold data and paths, never process output. The name stays apart from the storage backend's `Fact`, which is run-scoped. | [storage](storage.md) |
| `PluginLogger` | Writes text to a file under the store and returns its path. | [storage](storage.md) |
| `PluginStore` | The store a plugin sees: objects plus its own facts. | [storage](storage.md) |
| `PluginStoreBackend` | A type of the plugin API; its fields are described on the page. | [storage](storage.md) |
| `PluginStoreLocation` | How a worker reopens the store its run uses. | [storage](storage.md) |
| `SecretStore` | A plugin's secrets, scoped to that plugin and stored outside the log. | [storage](storage.md) |
| `SqlitePluginStoreOptions` | A type of the plugin API; its fields are described on the page. | [storage](storage.md) |
| `StoreFactInput` | A fact as a store takes it: the cause is always known by then. | [storage](storage.md) |
| `EmitOptions` | A type of the plugin API; its fields are described on the page. | [testing](testing.md) |
| `EmitResult` | A type of the plugin API; its fields are described on the page. | [testing](testing.md) |
| `FakeClock` | A clock the test moves. Timers fire only when `advance` passes them. | [testing](testing.md) |
| `FlowEnd` | A type of the plugin API; its fields are described on the page. | [testing](testing.md) |
| `FlowRun` | One run, as it stood when `runFlow`, `answer` or `resume` returned. | [testing](testing.md) |
| `FlowRunStatus` | A type of the plugin API; its fields are described on the page. | [testing](testing.md) |
| `FlowWait` | What a run is waiting for a person to answer. | [testing](testing.md) |
| `PluginUnderTest` | The plugin a test runs: the path or package name of its module (steps then run in a worker, as under `serve`), or its definition, which can only run with `inProcess: true`. | [testing](testing.md) |
| `RunFlowOptions` | A type of the plugin API; its fields are described on the page. | [testing](testing.md) |
| `TestWorld` | One log, store, kernel and clock that several calls share, so a repeated event key is a repeat and a run that ends can start the next one. | [testing](testing.md) |
| `WorldOptions` | What a world is made of. | [testing](testing.md) |
| `ObjectData` | The data of an object: JSON-shaped and owned by the plugin that declares it. | [views](views.md) |
| `ObjectFilterDefinition` | A named subset of a type's rows, by state. A row matches when its `state` is in `states`. The kernel adds an implicit `all` filter; a plugin may not declare that name. | [views](views.md) |
| `ObjectRef` | Names an object without carrying its state. | [views](views.md) |
| `ObjectResolveContext` | What an object type's `resolve` receives. `cwd` is where the person is. | [views](views.md) |
| `ObjectRow` | One line of a list: what the plugin shows for an object. | [views](views.md) |
| `ObjectTypeDefinition` | An object type a plugin owns, such as `task`. | [views](views.md) |
| `ObjectViews` | How one object type appears to every client. | [views](views.md) |
| `RowMark` | One of the values in `ROW_MARKS`. | [views](views.md) |
| `RunObject` | An object as a run sees it. | [views](views.md) |
| `SectionContent` | The Markdown of one section, and where to continue when it is paged. | [views](views.md) |
| `SectionPage` | One page of a long section, as the section API takes it. | [views](views.md) |
| `SectionReadOptions` | Where a section read starts; the plugin owns the meaning of the values. | [views](views.md) |
| `StoredObject` | An object after it was stored, with the fact that produced this version. | [views](views.md) |
| `TypeFilter` | One filter as a client sees it; `all` has no states. | [views](views.md) |
| `TypeFilters` | A type's filters in display order and the name of its default. | [views](views.md) |
| `ViewContext` | The context a `load` call receives. | [views](views.md) |
| `ViewSection` | One section a detail page offers. `live` means its content still grows. | [views](views.md) |
