// Sets a follow-up in a chat on an on-disk store, prints "<root> <chat> <due>", and waits to be killed.
import { rig } from "./support.ts";

const r = await rig({}, ["claude", "pi"], undefined, [], { sqlite: true });
const chat = await r.open("default");
const line = await r.command("bot", "follow-up", [chat, "--at", "+2h", "--do", "Check the build."]);
process.stdout.write(`${r.root} ${chat} ${String(line)}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
