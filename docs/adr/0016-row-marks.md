# ADR 0016: Row Marks, Badges, Ordering and the Progress Bar

Status: accepted

## Background

Clients draw a row from a semantic mark that the kernel fixes, and plugins choose only the semantics. The icon table follows the component sheet of the iOS design, which agrees with the table the earlier orchestration used.

## Decisions

### D1: A row carries a semantic `mark`

`row(object)` can carry a `mark`, and its value can only be one of this set the kernel fixes (in brackets: the iOS SF Symbol and the colour role):

- `todo` (circle, grey)
- `blocked` (circle.dashed, grey)
- `retry_wait` (clock, grey)
- `paused` (pause.circle, grey)
- `proposed` (plus.circle, waiting colour)
- `starting` (circle.dotted, running colour)
- `running` (circle.lefthalf.filled, running colour, breathing)
- `reconciling` (arrow.triangle.2.circlepath, running colour)
- `checking` (magnifyingglass, running colour)
- `rework_pending` (arrow.uturn.backward.circle, waiting colour)
- `waiting` (circle.fill, waiting colour)
- `integrating` (arrow.triangle.merge, running colour)
- `ready_to_merge` (checkmark.circle, success colour)
- `done` (checkmark.circle.fill, success colour)
- `failed` (xmark.circle.fill, error colour)
- `cancelled` (nosign, grey)
- `broken` (exclamationmark.triangle.fill, error colour)

Any other value is an error when the plugin loads. A plugin chooses only the semantics, and gives no colour and no icon name. The TUI uses one character per mark.

### D2: The kernel's two marks take precedence

When `waiting` is true, the row uses its `mark` if it is one of `waiting`, `proposed`, `rework_pending`, `ready_to_merge`, and otherwise draws `waiting`. When `waiting` is false, a `mark` is used if there is one; otherwise, if `running` is true, `running` is drawn; with none of these it is a plain row. A row whose `row` errors is still drawn as an error.

### D3: How `dev` maps its states

- Task: proposed → `proposed`. Ready → `todo` (`blocked` when it waits for a preceding task or a task in the same area, `retry_wait` when the model is unavailable and a retry time is set). Running, by the current step: worktree → `starting`; work and rework → `running`; verify and review → `checking`; integrate → `integrating`. A task that has already started and is queued for a worker or a check slot (running, review and waiting all count) → `retry_wait`, which tells it apart from the `blocked` of a task that has not started and waits for a preceding task. Waiting, by the reason it waits: verify and review both passed and it waits to merge → `ready_to_merge`; asking whether to rework → `rework_pending`; otherwise → `waiting`. Merged → `done`. Cancelled → `cancelled`. Auto rework used up and given up → `failed`.
- Plan: draft → `proposed`. Confirmed → `waiting` when some task waits for a person (proposed, or waiting and asking a person), because D2 lets waiting take precedence; otherwise `running` when some task is running; otherwise `todo`. Every proposed task is one pending item (a standing item of `dev`, with `dev:confirm` and `dev:cancel`); its row is drawn with `waiting` true and mark `proposed`, and it disappears after confirm or cancel. Paused → `paused`. Finished → `done`. Cancelled → `cancelled`.

### D4: `badge`

`row` can also carry a `badge`: a short text shown as it is, which a client puts after the state (the `#2` of `done.merged · #2`). A `dev` task fills `#<which attempt>`, and `#0` when it has not started.

### D5: `after`

`row` can also carry `after`: the ids of the sibling objects, under the same parent, that this object waits for. When a client draws the next-layer list, it arranges the rows into a tree by it: a row hangs under the first of its `after` siblings, indented with `└─`, and the other siblings in `after` are written at the end of the row as `also after <id>`. An `after` that points to an object not in the list is ignored for that entry; when there is a cycle, the rows are laid flat in their original order. A `dev` task fills its `after`.

### D6: The progress bar of an object page

An object page draws a segmented bar below the row and above the next-layer list. The bar fills the whole line, and by "done / total" only the children that are done are filled with the done colour; the rest are left empty. It is not coloured by each child's `mark`. The line below the bar is the title line of the next-layer list: on the left the type name of the next layer, on the right "done / total", digits only, with no state word after. The done count, the total and the cells on the bar count only the children the current filter of the next-layer list shows; children the filter hides are not counted in these two numbers and get no cell, and the number hidden is given by the API as before. After a change of filter, the bar and the numbers change with the list. A cancelled child is counted in neither done nor total, but is still drawn on the bar as a dark red cell after all the others, and in the next-layer list a cancelled child also comes last. The "merged/tasks" in a `dev` plan row does not count cancelled tasks either. An object with no next layer draws none. A client computes this from the next-layer list of ADR 0015, and a plugin does not need to give anything more.
