# Mutation records — `mcp`

Rows whose mutation broke code in `packages/mcp/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0026-M22 | packages/mcp/src/server.ts | `tools/list` served the table without its last tool | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M23 | packages/mcp/src/server.ts | a view refusal dropped `isError: true` | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M24 | packages/mcp/src/arguments.ts | skipped the required-field check before reading a view | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M25 | packages/mcp/src/server.ts | sent the server's log lines to stdout instead of stderr | `writes only JSON-RPC to stdout when a view logs a failure` |
| T-0026-M26 | packages/mcp/src/format.ts | made the section text block differ from its Markdown | `initializes, lists the table and reads every tool on fixture objects` |
| T-0027-M1 | packages/mcp/src/policy.ts | `actionMayRun` returned true for every action, ignoring `mcp.actions` | `splits show actions into the lead's and the owner's` |
| T-0027-M2 | packages/mcp/src/policy.ts | `actionMayRun` ignored `mcp.confirmActions`, so a confirm action ran once listed | `splits show actions into the lead's and the owner's` |
| T-0027-M3 | packages/mcp/src/policy.ts | `splitActions` kept every available action and named no owner action | `splits show actions into the lead's and the owner's` |
| T-0027-M4 | packages/mcp/src/tools.ts | `command` replaced its `input` with an empty string instead of passing it to the verb | `command runs plugin verbs with input and refuses a kernel verb` |
| T-0027-M7 | packages/mcp/src/tools.ts | `act` recorded the actor as cli/lead instead of mcp/lead | `act runs a lead rework with the mcp lead actor and refuses merge by default` |
| T-0027-M8 | packages/mcp/src/tools.ts | `command` still refused a verb whose name is a kernel verb after the named plugin declared it | `command runs a plugin verb whose name is also a kernel verb` |
| T-0027-M9 | packages/mcp/src/policy.ts | `splitPendingActions` kept every pending action and filtered none | `pending lists only the actions the lead may run` |
| T-0027-M10 | packages/mcp/src/tools.ts | `command` checked only the verb for a kernel name and let a plugin namespace that is a kernel verb run | `command refuses a plugin whose name is also a kernel verb` |
| T-0028-M1 | packages/mcp/src/server.ts | `initialize` never declared the channel capability, even with the flag | `reports a phase change with its meta and stays silent for the rest` |
| T-0028-M2 | packages/mcp/src/channel.ts | the starting rows were not kept, so objects present at start became `new` transitions | `reports a phase change with its meta and stays silent for the rest` |
| T-0028-M3 | packages/mcp/src/channel.ts | `sameRow` compared only `state`, so a change to the waiting flag was dropped | `reports a phase change with its meta and stays silent for the rest` (timed out) |
| T-0028-M4 | packages/mcp/src/channel.ts | `--types` did not filter the change listener | `--types limits the channel to the named object types` |
| T-0028-M5 | packages/mcp/src/channel.ts | the notification content left out the row's note | `reports a phase change with its meta and stays silent for the rest` |
| T-0028-M6 | packages/mcp/src/channel.ts | the waiting meta value was always `"false"` | `reports a phase change with its meta and stays silent for the rest` |
| T-0028-M7 | packages/mcp/src/channel.ts | the run log subscription did not enqueue the changed object, so a wait or running flip alone was never seen | `a run log change with no object write reports the wait and the running flag`, `reports a phase change with its meta and stays silent for the rest`, `a flipped running flag is reported without an object write` |
| T-0028-M8 | packages/mcp/src/channel.ts | hold was ignored, so notifications were sent before `notifications/initialized` (also T-0028-M12) | `nothing is written before notifications/initialized arrives` |
| T-0028-M9 | packages/mcp/src/channel.ts | a type whose seed failed reported each existing object as `new` | `a seed that fails makes the first sighting of each object a baseline` |
| T-0028-M10 | packages/mcp/src/channel.ts | an unknown `--types` entry was accepted | `a type with no views is refused with its name`, `--types names an unknown type, and a missing value, as a usage error` |
| T-0028-M11 | packages/mcp/src/channel.ts | a not-found object stayed in `last`, so a new object with its id was not new | `an object that is not found is forgotten, so it comes back as new` |
| T-0057-M1 | packages/mcp/src/channel.ts | a waiting flag turning on alone was not sent (state change only) (also T-0057-M4) | `a running flag flip alone sends nothing, and a wait turning on sends with the step`, `a wait turning on again with the state and flags of the last block sent sends nothing` |
| T-0057-M2 | packages/mcp/src/channel.ts | the row equal to the last block sent was sent again | `a wait turning on again with the state and flags of the last block sent sends nothing` |
| T-0057-M3 | packages/mcp/src/channel.ts | the `step` meta was never added | `a running flag flip alone sends nothing, and a wait turning on sends with the step` |
| T-0057-M5 | packages/mcp/src/channel.ts | the sent rows were not loaded at start, so a restart forgot the last block | `a restarted channel does not send the row the last block reported again` |
| T-0057-M6 | packages/mcp/src/channel.ts | the step came from the first active run of the object, not the one with the latest fact | `the step is the one of the run with the latest fact when two flows are active on one object` |
| T-0057-M7 | packages/mcp/src/channel.ts | runs with equal times were ordered by iteration order, not by start, last seq and run id | `the step of two active runs with equal times is chosen the same way every time` |
| T-0069-M1 | packages/mcp/src/format.ts | `show` left the mark out of its Markdown | `operad mcp > initializes, lists the table and reads every tool on fixture objects` |
| T-0069-M2 | packages/mcp/src/format.ts | `list` table left the mark and badge columns out | `operad mcp > initializes, lists the table and reads every tool on fixture objects` |

## T-0068 — the running tool returns object and title

| id | file | mutation | failing test |
|---|---|---|---|
| T-0068-M1 | packages/mcp/src/tools.ts | the running tool did not pass the views, so no title was found | `operad mcp > initializes, lists the table and reads every tool on fixture objects` |

## T-0064 — the channel sends waits, ends and loops

| id | file | mutation | failing test |
|---|---|---|---|
| T-0064-M1 | packages/mcp/src/channel.ts | an end was never recognised from the row's final flag | `the channel's sources > what the default sends > a start and a check starting send nothing; a wait opening and an end send with their reason`, `the channel's sources > what the default sends > a plan-like object reaching its final state sends with reason ended` |
| T-0064-M2 | packages/mcp/src/channel.ts | the loop block was sent again on each later arrival | `the channel's sources > what the default sends > three returns to one state without a wait send one loop block, not three` |
| T-0064-M3 | packages/mcp/src/channel.ts | a wait did not start the loop count again | `the channel's sources > what the default sends > a wait between the returns starts the count again` |
| T-0064-M4 | packages/mcp/src/channel.ts | the default notify list was `changes` instead of waiting, ended and loop | `the channel's sources > what the default sends > a start and a check starting send nothing; a wait opening and an end send with their reason` |
| T-0064-M5 | packages/mcp/src/channel.ts | an unknown notify entry was accepted | `the channel's sources > what the default sends > an unknown notify entry is refused with its name` |
| T-0064-M6 | packages/mcp/src/channel.ts | the looped flag was not saved with the sent row, so a restart sent the loop block again | `a restarted channel does not send a loop block again for the same stretch` |
| T-0064-M7 | packages/mcp/src/channel.ts | the pending item's prompt was never used as the wait's reason | `a wait carries the reason of its pending item when the row has no note` |
| T-0052-M12 | packages/mcp/src/tools.ts | the `list` tool did not pass `parent` on | `operad mcp hierarchy > list takes root and parent, with or without a type` |

## T-0158 — a wait the plugin answers itself is not announced

| id | file | mutation | failing test |
|---|---|---|---|
| T-0158-M1 | packages/mcp/src/channel.ts | a pending item marked `auto` was announced as a wait like any other | `a wait the plugin answers itself > is not announced, and its end is`, `the pending view and the plugin's automatic answer > an auto wait sends no block and its merge sends ended; a refused answer is announced` |
| T-0158-M2 | packages/mcp/src/channel.ts | a skipped wait was not looked at again on a later change, so a withdrawn answer was never announced | `a wait the plugin answers itself > is announced when the automatic answer is withdrawn` |

## T-0177

| id | file | mutation | failing test |
|---|---|---|---|
| T-0177-M4 | packages/mcp/src/channel.ts | the `announce: false` check removed, so a person's proposed task was announced | `a proposed task > is pending and drawn waiting; one block for what the plugin opened, none for a person's` |
| T-0175-M3 | packages/mcp/src/server.ts | the instructions kept saying owner decisions are not offered when the owner allowed actions | `operad mcp > instructions follow the configured allow lists` |

## T-0210 — follow-ups from the flow-stops reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0210-M9 | packages/mcp/src/server.ts | the instructions named an action that asks for confirmation and is not in `confirmActions` | `operad mcp > instructions do not promise an action that asks for confirmation and is not confirmed` |
| T-0210-M14 | packages/mcp/src/channel.ts | a block sent for a waiting object for another reason did not read the wait's pending prompt | `the channel's sources > what the default sends > a block for a state change of a waiting object still carries the wait's prompt` |
| T-0188-M16 | packages/mcp/src/server.ts | an unknown tool threw instead of giving an error result | `the tools opened in a harness's own process > an unknown tool and a bad argument are error results, not throws` |
