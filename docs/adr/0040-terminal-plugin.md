# ADR 0040: The Terminal Plugin

Status: accepted

## Background

A person wants to run a command where the work is: a dev server in a task's worktree, a shell in a project's main folder, an agent's own screen. It must outlive the window that shows it, because closing a client is not a reason to stop a server. It also hands whoever reaches it a shell on the machine, so it is held tighter than the rest of the HTTP surface.

## Decisions

### D1: Terminals are a plugin, `terminal`

The kernel has no terminal (ADR 0002): it runs no command. The `terminal` plugin owns them, and a home that does not enable it has none. It is optional: `operad plugin enable terminal` adds it, and a new home does not load it, because no plugin that hands out a shell or brings a third-party dependency is on without a person choosing it. The user word is **Terminal** (终端).

### D2: A terminal is a command in a folder on a pseudo terminal, kept by serve

A terminal has a command line, a folder, a size and an id. The command line is any command, run in the person's login shell as `$SHELL -ilc <command>`; an empty command line opens the login shell itself. Agents are presets and nothing more: for each loaded harness plugin named `claude`, `codex` or `pi`, serve offers that name as a command line to fill in.

The folder is a registered repository's folder or one of its git worktrees, so a task's worktree is a folder a terminal can start in. The plugin learns the repositories from what loaded plugins register (their project settings, ADR 0017), and names no plugin.

`operad serve` owns the process. No other process starts one.

### D3: A terminal's life

A terminal is running or ended. It keeps running when every client disconnects. It ends when its command ends, when a person closes it, when its folder is removed (D7), or when serve stops. An ended terminal stays in the list with its exit code (128 plus the signal number for a signal), the signal and, when something other than the command or the person ended it, the reason in plain words, until a person closes it. Closing stops the whole process tree, as hanging up a real terminal does and then by force, and takes the terminal off the list.

Terminals live in serve's memory. A restart of serve, including one serve makes by itself to load changed code, ends every terminal; the new serve lists none.

### D4: Output over the event stream, input over POST

A running plugin may serve routes under `/v1/<plugin name>` and send events on `/v1/events` (ADR 0029 D4). A client reads the list and starts, writes to, resizes and closes terminals under `/v1/terminal`. Output travels on the existing server-sent event stream, for the terminals the stream names in its query; there is no WebSocket. Input and size changes are HTTP POSTs.

### D5: This machine only

Starting, input, resize, close, every change to a group, and reading a terminal's screen and output are refused unless the request comes over loopback from the machine serve runs on, through no proxy: the peer address is a loopback address, the request names a loopback host, and it carries no forwarding header. The token is still required. Output is held to the same rule as input because a screen shows secrets.

The list of terminals and groups, and the events that say the list changed, may be read from any address serve listens on: they let another device see what runs without reaching into it. The list includes each command line and folder.

### D6: Replay from a headless terminal

serve keeps one `@xterm/headless` terminal per session, fed the same output as the clients, with `@xterm/addon-serialize`. A client that connects or reconnects first receives the serialized screen and scrollback, then the live output that follows it, with nothing twice and nothing missing. Scrollback is capped at 5000 lines. Output is passed on only up to the last whole escape sequence and whole character, so a screen never ends halfway through one.

While no client is reading a terminal's screen, the headless terminal answers the questions a program asks its terminal (such as the cursor position); while a client is reading, the client answers.

These two packages are runtime dependencies of the `terminal` plugin's package alone. The engine has none.

### D7: A removed folder stops its terminals first

The platform module keeps a list in the home of the process trees working in a folder. A plugin that keeps a process in a folder records it there; whatever is about to remove a folder releases it, which stops those trees by force without waiting for them. `dev` releases a task's worktree and its checking worktree before a cleanup command that names a worktree. Neither plugin knows the other, and a release never fails or delays the removal.

A folder removed by anything else, such as a person's own command, is noticed by the `terminal` plugin, which then stops the terminals started in it. Either way the ended terminal says its folder was removed.

### D8: Groups

A person can keep named groups of terminals, from any folders. A terminal is in at most one group, or none, and may join one when it starts. Groups are plugin objects in the store, so they survive a restart of serve; which terminals are in them does not, as the terminals do not. A group stays when its terminals end, and deleting a group stops nothing.

### D9: Flow steps do not use terminals

A flow step reaches an agent through its harness (ADR 0022, 0023, 0024), where access is enforced and the record is kept. Only a terminal a person opens runs a command this way, and nothing a terminal prints is a fact.

## Not decided here

A terminal carries no access profile (ADR 0025): it has the rights of the user serve runs as.
