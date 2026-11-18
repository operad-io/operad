# ADR 0014: The Display Interface and Content

Status: accepted

## Decisions

### D1: The functions of an object type

- `row(object)` → `{ id, title, state, note?, parent? }` is one row in a list. `parent` is the id of the upper-level object (ADR 0015). It must be a pure function and fast: it reads only stored object data and runs no git and starts no process. `note` is a short text at the end of the row (cost, elapsed time). A row may also carry `data`, an object of JSON the plugin defines for its clients (a bot's scheduled prompts, the scheduled prompt that opened a chat); the kernel checks only that it is an object and passes it through unchanged in list, get and pending rows.
- `context(ctx, object)` → `{ used, window?, model? }` is optional: numbers a detail page shows beside the row, such as how full an agent's context is. It may read facts and may be slow; the kernel passes it through and reads no meaning of its own into it.
- `sections(object)` → `[{ id, title, live? }]` says which sections a detail page has; it is only a table of contents. `live` means the content is still growing (a worker's log).
- `load(ctx, object, sectionId, { cursor })` → `{ markdown, next? }` is the content of one section. It is called only when a user opens it, it may be slow, and when it is long it is paged.

### D2: Content is Markdown only

The content is CommonMark with GFM tables and fenced code blocks: a diff is ```` ```diff ````, a table is a GFM table, a figure is ```` ```mermaid ````. Each client needs just one renderer. The command line converts to coloured text in a terminal, and `--raw` gives the original. A diff per file is expressed by making each file one section; no new content type is added.

### D3: What the kernel does

- On a list it adds to each row two marks it knows itself, **waiting** (for a person) and **running**. The two marks override the row's `mark` (ADR 0016): a waiting row is always drawn as waiting, and a running row whose plugin gave no `mark` is drawn as running.
- It adds a **history** section at the end of a detail page automatically.
- `load` has a timeout and a size limit; when it truncates, it says how to see the whole content (`operad show <id> --section <section> --full`).
- When an object changes, it pushes "this id changed", and a client fetches `row` again and the open `live` section.

### D4: The client API

The API, shared by the three clients: `list <type>`, `get <id>` (row, the table of contents of sections, the usable actions), `section <id> <section> [cursor]`, `events` (change push), `act <plugin:action> <id> [note]`, and `settings` and `set` (ADR 0017). The command line calls it directly on the local machine, and the TUI and iOS use the same interface. The result of a section can carry `pages: [{ label, cursor }]` (the table of contents of a long section; the cursor of the first page is omitted); the client API and HTTP pass it through unchanged.

### D5: A plugin does not touch colour, layout or navigation

A plugin gives semantics (the `mark` of ADR 0016), not colours or icon names. The main button is the first action and the rest are in `⋯`; an action that needs confirmation is shown in red at confirmation. Navigation is pending, running, and browsing by level (ADR 0015). A plugin writes English only, and the client translates the rest of the words on the interface. There are no batch actions.
