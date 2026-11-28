# ADR 0029: `operad serve` and the Clients

Status: accepted

## Background

The phone is the main place a person talks to a bot, so the display interface has to reach it over the network without a second backend, and without the app learning any plugin.

## Decisions

### D1: `operad serve` exposes the display interface as HTTP

`operad serve` exposes the client API (`list`, `get`, `section`, `events`, `act`) as HTTP. It listens only on the local machine, the local network or a Tailscale address (never a wildcard), requires a token, and uses SSE for `events`. A live section's changing part travels on the same SSE stream as a `tail` event, so a client can render a running reply as it is written; a client that does not know the event keeps reading the section after a change event.

### D2: The app has one backend and knows no plugin

The iOS app is the operad app and connects only to `operad serve`: it keeps no second backend and no transition between two. It knows no plugin: the plans and tasks of `dev`, and the chats of `chat`, are shown and operated through the generic object interface of the display interface.

### D3: Uploads, attachments and file arguments travel over HTTP

`POST /v1/uploads` takes one file's bytes as the body, with its name in a query and its type in the header, and answers `{ ref, name, type, size }`; a file over 20 MB is refused. An action argument the schema declares with `format: "file"` takes such a `ref`, and the kernel moves the upload once into the target object's attachment directory under the home, `attachments/<type>/<id>/`; the action receives the stored path. A ref works once, and an upload no action took within an hour is removed.

`GET /v1/attachments/<type>/<id>/<ref>/<name>` serves a stored file behind the bearer token, with the type its upload gave. An object type's views may declare `file(ctx, object, path)`, which the kernel asks before it serves a request for that type: `path` is the decoded part after the type and id, and the hook returns true only for a file the object's records name. A type without the hook keeps the kernel's attachment-directory bounds, so a plugin that does not declare it is unchanged. A path a client chose is never trusted: the route refuses a path outside the attachment directories, a link whose target is outside them, and, for a type with the hook, any file its records do not name.

### D4: A running plugin may serve its own routes and events

A plugin that `operad serve` started may answer requests under `/v1/<plugin name>` and send events on the `/v1/events` stream to the streams that name it in their query, each event's name starting with the plugin's. The same token guards them, and serve tells the plugin whether a request came over loopback from this machine through no proxy. A built-in endpoint is never answered by a plugin. When serve cannot load the trigger rules it starts only the plugins that declare they send no events, so their routes are still answered.

serve answers HTTP before its plugins run, and a client does not reconnect for that. A stream that names a plugin which is not running yet is answered at once with the other events, and the plugin's part joins it when the plugin starts; when the plugin stops, the part leaves the stream, and the next start joins it again. Just before a part joins an open stream, the stream gets a `reset`, so a client reads again what it asked for too early. The stream is not held until the plugins have started, because that would keep every other event from the client for as long as the slowest plugin takes. A plugin that refuses a part it joins late has no status left to answer with, so the stream ends, and the client's next stream gets the refusal. A stream that outlives its process is not carried over: a reload closes it, and the stream the client opens to the new process joins in the same way.

A request under `/v1/<plugin name>` for a plugin that is about to start is answered `503` with the error kind `unavailable` and a `Retry-After` header, never `404`. A plugin is about to start from the moment serve answers until its start has ended, and while serve is installing the package it needs after its own start (ADR 0012 D4), up to the reload that follows. A plugin that is off, failed to start, is not started because the trigger rules could not be loaded, or whose install failed is not about to start, and its routes are `404`.
