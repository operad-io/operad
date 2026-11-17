import { expect, test } from "bun:test";
import { defaultAccess, match, withAccessLevel, withDefaultAccess } from "../src/index.ts";

const HOME = "/home/u";
const CWD = "/work/project";

/** The default list, written out here so a new entry must add its row. */
const DENY_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gh",
  "~/.radian",
  "~/Library/Keychains",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Firefox",
  "~/Library/Safari",
  ".git/config",
  ".git/hooks",
];

const DENY_COMMANDS = [
  "sudo",
  "su",
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "dd",
  "diskutil",
  "shutdown",
  "reboot",
  "launchctl",
  "crontab -r",
  "git push --force*",
  "git push --delete",
  "curl … | sh",
  "wget … | sh",
  "pkill",
  "killall",
];

const ASK_COMMANDS = ["git push", "brew install", "npm install -g", "pip install", "osascript", "open"];
const ASK_PATHS = ["~/.zshrc", "~/.*profile"];
const OUTWARD_COMMANDS = [
  "git push",
  "gh pr create",
  "gh pr comment",
  "gh issue create",
  "gh issue comment",
  "gh release create",
  "curl",
  "wget",
  "mail",
  "mailx",
  "sendmail",
];
const OUTWARD_ALLOW = ["owner"];

test("the built-in default is exactly the list every chat and step starts from", () => {
  expect(defaultAccess()).toEqual({
    denyPaths: DENY_PATHS,
    denyCommands: DENY_COMMANDS,
    askCommands: ASK_COMMANDS,
    askPaths: ASK_PATHS,
    outwardCommands: OUTWARD_COMMANDS,
    outwardAllow: OUTWARD_ALLOW,
  });
});

test("every default deny path refuses a read and a write under it", () => {
  for (const path of DENY_PATHS) {
    const at = path.startsWith("/") ? path : path.startsWith("~") ? path : `${CWD}/${path}`;
    const read = match(defaultAccess(), { tool: "read", input: { path: `${at}/secret` }, cwd: CWD }, { home: HOME });
    expect(read.allow).toBe(false);
    expect(read.ask).toBeUndefined();
    const write = match(defaultAccess(), { tool: "write", input: { path: `${at}/secret` }, cwd: CWD }, { home: HOME });
    expect(write.allow).toBe(false);
    expect(write.ask).toBeUndefined();
  }
});

test("every default deny command refuses a bash call that runs it", () => {
  for (const command of DENY_COMMANDS) {
    const sample = command.replace(" …", " x").replace("*", "");
    const verdict = match(defaultAccess(), { tool: "bash", input: { command: sample }, cwd: CWD }, { home: HOME });
    expect(verdict.allow).toBe(false);
    expect(verdict.ask).toBeUndefined();
  }
});

test("every default ask command and ask path asks a person", () => {
  for (const command of ASK_COMMANDS) {
    const verdict = match(defaultAccess(), { tool: "bash", input: { command }, cwd: CWD }, { home: HOME });
    expect(verdict).toMatchObject({ allow: false, ask: true });
  }
  for (const path of ASK_PATHS) {
    const at = path.replace(".*", ".z");
    const verdict = match(defaultAccess(), { tool: "write", input: { path: at }, cwd: CWD }, { home: HOME });
    expect(verdict).toMatchObject({ allow: false, ask: true });
  }
});

test("a profile can add to the default but never remove its deny or ask rules", () => {
  const tightened = withDefaultAccess({
    denyPaths: ["/private"],
    denyCommands: ["rm"],
    askCommands: ["make"],
    askPaths: ["/scratch"],
    outwardCommands: ["deploy"],
    outwardAllow: ["telegram:123"],
    readOnly: true,
  });
  expect(tightened.denyPaths).toEqual([...DENY_PATHS, "/private"]);
  expect(tightened.denyCommands).toEqual([...DENY_COMMANDS, "rm"]);
  expect(tightened.askCommands).toEqual([...ASK_COMMANDS, "make"]);
  expect(tightened.askPaths).toEqual([...ASK_PATHS, "/scratch"]);
  expect(tightened.outwardCommands).toEqual([...OUTWARD_COMMANDS, "deploy"]);
  expect(tightened.outwardAllow).toEqual([...OUTWARD_ALLOW, "telegram:123"]);
  expect(tightened.readOnly).toBe(true);
});

test("every level, full included, keeps the default's deny and ask rules", () => {
  for (const level of ["plan", "ask", "edits", "full"] as const) {
    const profile = withAccessLevel({}, level);
    const ssh = match(profile, { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd: CWD }, { home: HOME });
    expect(ssh.allow).toBe(false);
    expect(ssh.ask).toBeUndefined();
    const sudo = match(profile, { tool: "bash", input: { command: "sudo ls" }, cwd: CWD }, { home: HOME });
    expect(sudo.allow).toBe(false);
    expect(sudo.ask).toBeUndefined();
    const push = match(profile, { tool: "bash", input: { command: "git push origin main" }, cwd: CWD }, { home: HOME });
    expect(push).toMatchObject({ allow: false, ask: true });
  }
});
