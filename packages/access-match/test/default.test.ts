import { expect, test } from "bun:test";
import { defaultAccess, defaultDenies, match, readProfile, withAccessLevel, withDefaultAccess, type AccessProfile } from "../src/index.ts";

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

test("a chat at full runs a command the matcher cannot follow, where edits still asks", () => {
  const full = withAccessLevel({}, "full");
  const edits = withAccessLevel({}, "edits");
  const unreadable = [
    "python3 - <<'PY'\nprint(1)\nPY",
    "echo $(git rev-parse HEAD)",
    "cd $DIR && cat notes",
    'bash -c "echo hi"',
  ];
  for (const command of unreadable) {
    const call = { tool: "bash", input: { command }, cwd: CWD } as const;
    expect(match(full, call, { home: HOME })).toEqual({ allow: true });
    expect(match(edits, call, { home: HOME })).toMatchObject({ allow: false, ask: true });
  }
  // The profile's own ask rules still ask, and a plain deny still refuses.
  expect(match(full, { tool: "bash", input: { command: "git push origin main" }, cwd: CWD }, { home: HOME })).toMatchObject({
    allow: false,
    ask: true,
  });
  for (const call of [
    { tool: "bash", input: { command: "sudo ls" }, cwd: CWD },
    { tool: "bash", input: { command: "cat ~/.ssh/id_ed25519" }, cwd: CWD },
    { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd: CWD },
  ] as const) {
    const verdict = match(full, call, { home: HOME });
    expect(verdict.allow).toBe(false);
    expect(verdict.ask).toBeUndefined();
  }
});

test("a chat at full runs inline code a profile without askCommands would otherwise refuse", () => {
  const full: AccessProfile = { level: "full", denyCommands: ["mkfs"] };
  for (const command of ['bash -c "echo hi"', "echo $(whoami)"]) {
    expect(match(full, { tool: "bash", input: { command }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  }
  const denied = match(full, { tool: "bash", input: { command: "mkfs /tmp/x" }, cwd: CWD }, { home: HOME });
  expect(denied.allow).toBe(false);
  expect(denied.ask).toBeUndefined();
});

test("a chat at full still refuses a deny its inline code plainly shows", () => {
  const full: AccessProfile = { level: "full", denyCommands: ["sudo"], denyPaths: ["/etc/secret"] };
  for (const command of [
    "bash -c 'sudo ls'",
    "bash -c 'cat /etc/secret/key'",
    "echo $(sudo ls)",
    "echo $(cat /etc/secret/key)",
  ]) {
    const verdict = match(full, { tool: "bash", input: { command }, cwd: CWD }, { home: HOME });
    expect(verdict.allow).toBe(false);
    expect(verdict.ask).toBeUndefined();
  }
  expect(match(full, { tool: "bash", input: { command: "bash -c 'echo hi'" }, cwd: CWD }, { home: HOME })).toEqual({
    allow: true,
  });
});

test("a generated step with no profile gets the default asks", () => {
  const profile = withDefaultAccess(undefined);
  for (const command of ["git push origin main", 'bash -c "echo hi"']) {
    expect(match(profile, { tool: "bash", input: { command }, cwd: CWD }, { home: HOME })).toMatchObject({
      allow: false,
      ask: true,
    });
  }
});

test("defaultDenies is exactly the default's deny lists", () => {
  expect(defaultDenies()).toEqual({ denyPaths: DENY_PATHS, denyCommands: DENY_COMMANDS });
});

test("a task worker keeps the default's denies, not its asks", () => {
  const profile = withDefaultAccess({ defaultAsks: false });
  expect(profile).toMatchObject({ defaultAsks: false, denyPaths: DENY_PATHS, denyCommands: DENY_COMMANDS });
  expect(profile.askCommands).toBeUndefined();
  expect(profile.askPaths).toBeUndefined();

  // The default's ask commands and paths are not asked about.
  expect(match(profile, { tool: "bash", input: { command: "git push origin main" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  expect(match(profile, { tool: "write", input: { path: "~/.zshrc" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  // A scripted edit does not ask, whichever form it takes.
  expect(match(profile, { tool: "bash", input: { command: "python3 - <<'PY'\nprint(1)\nPY" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  expect(match(profile, { tool: "bash", input: { command: 'bash -c "echo hi"' }, cwd: CWD }, { home: HOME }).ask).toBeUndefined();
  // The default's denies still refuse.
  for (const call of [
    { tool: "bash", input: { command: "sudo ls" }, cwd: CWD },
    { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd: CWD },
  ] as const) {
    const verdict = match(profile, call, { home: HOME });
    expect(verdict.allow).toBe(false);
    expect(verdict.ask).toBeUndefined();
  }
});

test("a flow profile still adds its own asks when the default's asks are left out", () => {
  const profile = withDefaultAccess({ defaultAsks: false, askCommands: ["make"], askPaths: ["/scratch"] });
  expect(profile.askCommands).toEqual(["make"]);
  expect(profile.askPaths).toEqual(["/scratch"]);
  expect(match(profile, { tool: "bash", input: { command: "make" }, cwd: CWD }, { home: HOME })).toMatchObject({ allow: false, ask: true });
  expect(match(profile, { tool: "bash", input: { command: "git push origin main" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
});

test("readProfile reads defaultAsks and refuses a malformed one", () => {
  expect(readProfile({ defaultAsks: false })).toEqual({ ok: true, profile: { defaultAsks: false } });
  expect(readProfile({ defaultAsks: "no" })).toEqual({ ok: false, message: "defaultAsks must be true or false" });
});

test("a task worker is never asked or refused for what the matcher cannot follow", () => {
  const worker = withDefaultAccess({ defaultAsks: false });
  const chat = withDefaultAccess({});
  // A chat stops on each of these; a worker runs them.
  const chatStops = [
    "cd /elsewhere && cp a /tmp/b && trap 'mv /tmp/b a' EXIT && perl -0pi -e 's/x/y/' a && bun test x",
    'bash -c "echo hi"',
    "echo $(git rev-parse HEAD)",
    "cd $DIR && cat notes",
  ];
  for (const command of [...chatStops, "python3 - <<'PY'\nprint(1)\nPY"]) {
    const call = { tool: "bash", input: { command }, cwd: CWD } as const;
    expect(match(worker, call, { home: HOME })).toEqual({ allow: true });
    if (chatStops.includes(command)) expect(match(chat, call, { home: HOME }).allow).toBe(false);
  }
  // A plain match of a default deny still refuses a worker.
  for (const call of [
    { tool: "bash", input: { command: "sudo ls" }, cwd: CWD },
    { tool: "bash", input: { command: "cat ~/.ssh/id_ed25519" }, cwd: CWD },
  ] as const) {
    const verdict = match(worker, call, { home: HOME });
    expect(verdict.allow).toBe(false);
    expect(verdict.ask).toBeUndefined();
  }
});
