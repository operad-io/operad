import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { attachmentDir, type StepContext } from "@operad-io/engine";
import {
  allMessages,
  chatViews,
  imagesOf,
  messageMarkdown,
  promptFor,
  withAttachmentReads,
  type Message,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** Writes a file where the engine stores a chat's attachments. */
function stored(r: Rig, chat: string, name: string, body: string): string {
  const dir = join(attachmentDir(join(r.root, "home"), "chat", chat), "up-1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

async function send(r: Rig, chat: string, args: Record<string, unknown>) {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", args, {
    object: { type: "chat", id: chat, data: object.data },
    actor: { via: "ios", id: "me" },
  });
}

describe("chat:send with attachments", () => {
  test("the message fact records each path with its name, type and size", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const photo = stored(r, chat, "photo.png", "12345");
    const doc = stored(r, chat, "notes.pdf", "abc");
    await send(r, chat, { note: "look", attachments: [photo, doc] });
    const message = allMessages(r.store, chat)[0];
    expect(message?.attachments).toEqual([
      { path: photo, name: "photo.png", type: "image/png", size: 5 },
      { path: doc, name: "notes.pdf", type: "application/pdf", size: 3 },
    ]);
  });

  test("a message may be only a file, but never nothing", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await send(r, chat, { attachments: [stored(r, chat, "a.txt", "a")] });
    expect(allMessages(r.store, chat)).toHaveLength(1);
    await expect(send(r, chat, {})).rejects.toThrow("needs text or an attachment");
  });

  test("an empty note beside an attachment is an attachment-only message; an empty note alone is refused", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await send(r, chat, { note: "", attachments: [stored(r, chat, "a.txt", "a")] });
    expect(allMessages(r.store, chat)).toHaveLength(1);
    await expect(send(r, chat, { note: "" })).rejects.toThrow("needs text or an attachment");
  });

  test("the transcript shows an image as an image and another file as a link, each with its name", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const photo = stored(r, chat, "my photo.png", "12345");
    const doc = stored(r, chat, "notes.pdf", "abc");
    await send(r, chat, { note: "look", attachments: [photo, doc] });
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    const shown = await chatViews.load(
      { store: r.store, settings: {}, plugin: "chat", home: join(r.root, "home") } as never,
      object,
      "transcript",
      {},
    );
    expect(shown.markdown).toContain(`![my photo.png](/v1/attachments/chat/${chat}/up-1/my%20photo.png)`);
    expect(shown.markdown).toContain(`Attachment: [notes.pdf](/v1/attachments/chat/${chat}/up-1/notes.pdf)`);
    const message = allMessages(r.store, chat)[0];
    if (message === undefined) throw new Error("no message");
    expect(messageMarkdown(message)).toContain("look");
  });
});

describe("an upload's own type", () => {
  test("a file with no extension keeps the type its upload gave, so it is an image to the agent", async () => {
    const r = await rig(() => reply("seen"), undefined, "claude");
    const chat = await r.chat();
    const photo = stored(r, chat, "camera", "12345");
    writeFileSync(join(dirname(photo), ".meta.json"), JSON.stringify({ name: "camera", type: "image/png", size: 5 }));
    await send(r, chat, { note: "look", attachments: [photo] });
    expect(allMessages(r.store, chat)[0]?.attachments[0]?.type).toBe("image/png");
    await r.round(chat);
    expect(r.calls[0]?.params.images).toEqual([{ path: photo, mediaType: "image/png" }]);
  });
});

describe("chat/reply with attachments", () => {
  test("an image reaches the claude harness as image input, and as a path in the prompt", async () => {
    const r = await rig(() => reply("seen"), undefined, "claude");
    const chat = await r.chat();
    const photo = stored(r, chat, "photo.png", "12345");
    const doc = stored(r, chat, "notes.pdf", "abc");
    await send(r, chat, { note: "look", attachments: [photo, doc] });
    await r.round(chat);
    const params = r.calls[0]?.params;
    expect(params?.images).toEqual([{ path: photo, mediaType: "image/png" }]);
    const prompt = String(params?.prompt);
    expect(prompt).toStartWith("look\n\nAttached files:");
    expect(prompt).toContain(`- ${photo} (photo.png, image/png, 5 B; also given to you as an image)`);
    expect(prompt).toContain(`- ${doc} (notes.pdf, application/pdf, 3 B)`);
  });

  test("a harness that takes no images gets the image as a path only", async () => {
    const r = await rig(() => reply("seen"), undefined, "radian");
    const chat = await r.chat();
    const photo = stored(r, chat, "photo.png", "12345");
    await send(r, chat, { note: "look", attachments: [photo] });
    await r.round(chat);
    expect(r.calls[0]?.params.images).toBeUndefined();
    expect(String(r.calls[0]?.params.prompt)).toContain(`- ${photo} (photo.png, image/png, 5 B)`);
  });

  test("a path outside the chat's attachment directory is never given as an image", async () => {
    const r = await rig(() => reply("x"), undefined, "claude");
    const chat = await r.chat();
    const elsewhere = join(r.root, "secret.png");
    writeFileSync(elsewhere, "x");
    await r.say(chat, "look", [{ path: elsewhere, name: "secret.png", type: "image/png", size: 1 }]);
    await r.round(chat);
    expect(r.calls[0]?.params.images).toBeUndefined();
    const directory = attachmentDir(join(r.root, "home"), "chat", chat);
    const message = allMessages(r.store, chat)[0] as Message;
    expect(imagesOf([message], "claude", directory)).toEqual([]);
  });

  test("the access profile gains read access to the chat's attachment directory and nothing more", async () => {
    const r = await rig(
      (ctx: StepContext) => {
        seen.push(ctx.access);
        return reply("x");
      },
      undefined,
      "claude",
    );
    const seen: unknown[] = [];
    const home = join(r.root, "home");
    const denied = [join(home, "attachments"), join(home, "store")];
    const chat = await r.chat({ access: { denyPaths: denied } });
    const mine = attachmentDir(home, "chat", chat);
    await send(r, chat, { note: "look", attachments: [stored(r, chat, "a.txt", "a")] });
    await r.round(chat);
    const profile = seen[0] as Record<string, unknown>;
    expect(profile.readPaths).toEqual([mine]);
    expect(profile.denyPaths).toEqual(denied);
  });

  test("a chat with no attachments keeps its profile as it is", async () => {
    const seen: unknown[] = [];
    const r = await rig((ctx: StepContext) => {
      seen.push(ctx.access);
      return reply("x");
    }, undefined, "claude");
    const chat = await r.chat({ access: { denyPaths: ["/x"] } });
    await r.say(chat, "plain");
    await r.round(chat);
    expect(seen[0]).toEqual({ denyPaths: ["/x"] });
    expect(withAttachmentReads({}, "/d")).toEqual({ readPaths: ["/d"] });
    expect(promptFor([])).toBe("");
  });
});
