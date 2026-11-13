# ADR 0015: Hierarchy

Status: accepted

## Decisions

### D1: A plugin says the hierarchy with `parent`; a client walks down layer by layer

The first layer is the plugin: every type in `/v1/types` carries the plugin it belongs to, and a client groups by plugin.

### D2: The top-level objects of a plugin

Opening a plugin lists its top-level objects: the objects of its types that have no `parent`. An object whose `parent` is not an object of this plugin (such as a chat under another plugin's repository) is also listed at the top level, grouped by `parent`; the group name is the parent id the server gives (for example `repo:operad`), and inside a group the newer comes first.

### D3: An object page lists its next layer

Between the row and the sections, an object page lists its next layer: the objects whose `parent` equals this id. Each row is like a row in a list (the waiting and running marks, can be opened), and so on further down.

### D4: The API

`list` accepts `parent=<id>` (the next layer) and `root` (the top level). A type's declared filter and the default filter also apply to the next-layer list of an opened object: the list shows only the children the current filter shows, the number of hidden ones is still given, and by the `mark` of the hidden rows three counts are given: `done`, `cancelled` and `other`. When `f` changes the filter of the left column, the next layer of the opened object changes too; the progress bar of an object page counts only the children this list shows.

### D5: The hierarchy of `dev` is repository → plan → task

`dev` has a `repo` object type (the repositories registered by `operad dev repo add`), a plan's `parent` is its repository, and a task's `parent` is its plan.

### D6: A client still does not know plugins

The hierarchy and the names all come from `/v1`. The command line's `operad list <type>` stays flat.

### D7: The TUI

The top bar is pending, running, and one tab per plugin (`dev`), not one tab per type. A plugin tab's left column lists its top-level objects; objects whose `parent` belongs to another plugin are also at the top level, grouped by parent id. When the top-level objects all have a next layer, the left column lists the next layer instead, grouped by top-level object, and the group name is the row of that top-level object (the left column of `dev` is plans grouped by repository). The right column is the page of the selected object: row, progress bar, the next-layer list (each row with mark, id, state, badge, note; Enter opens the page of that object), and then the sections. The next layer is already drawn by the client as a list, so a plugin does not give another section that lists the next layer (`dev` has no Tasks section on a plan). An object not in the left column (such as a task) is opened only from the page of its upper layer, from pending, or from running.
