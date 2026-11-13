# ADR 0018: Opening Created Objects, Creating Actions, and Objects Under Settings

Status: accepted

## Decisions

### D1: An action that creates an object opens it

Besides the one line of text for a person, the result of an action can also name the object it created (`opens: <type:id>`); the plugin decides whether to say it. The kernel, the client API and HTTP pass it through unchanged. iOS and the TUI open the page of that object when they receive it, and the command line still prints only the line. Actions that create a chat, such as `dev:chat` and `bot:chat`, all say it.

### D2: An action that creates a type of object belongs to the entry of that type

An action can declare the type it creates (`creates: <type>`). A client collects such actions into the creation entry of that type (the "new" of the chat tab in iOS and the TUI), and the main button and the `⋯` of the parent object's page do not list them. The command line can still call them directly. The main button, which is the first action, is the first action that does not carry `creates`.

### D3: A plugin may have no tab; its objects hang under settings

A plugin can declare that its top-level objects belong to settings (as `bot` does: a bot's page is really that bot's settings). Then it takes no place in the bottom tab bar and the TUI top bar; the settings page of iOS gains a section that lists these objects by type name (`bot` is listed as Bots), and opening one gives the object page. The objects can still be opened elsewhere (the group title in the chat tab, pending, running).
