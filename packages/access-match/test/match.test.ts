import { expect, test } from "bun:test";
import { findGrant, match, readProfile, type AccessProfile } from "../src/index.ts";

const HOME = "/home/u";
const CWD = "/work/project";

function bash(profile: AccessProfile, command: string): ReturnType<typeof match> {
  return match(profile, { tool: "bash", input: { command }, cwd: CWD }, { home: HOME });
}

function refusal(verdict: ReturnType<typeof match>): string {
  if (verdict.allow) throw new Error("expected a refusal");
  return verdict.reason;
}

const COMMANDS: AccessProfile = {
  denyCommands: ["sudo", "rm -rf /", "git push --force*", "git push --delete", "curl … | sh", "mkfs"],
};
const PATHS: AccessProfile = { denyPaths: ["~/.ssh", "/etc/secret", ".git/config"] };

test("an allowed call is allowed", () => {
  expect(bash({ ...COMMANDS, ...PATHS }, "ls -la && git status | head")).toEqual({ allow: true });
  expect(match({ ...PATHS }, { tool: "read", input: { path: "src/a.ts" }, cwd: CWD }, { home: HOME })).toEqual({
    allow: true,
  });
  expect(match(PATHS, { tool: "other", input: { path: "~/.ssh/x" }, cwd: CWD })).toEqual({ allow: true });
});

test("an empty profile allows everything, inline code included", () => {
  expect(bash({}, "bash -c 'rm -rf /' && echo $(whoami)")).toEqual({ allow: true });
  expect(bash({ denyCommands: [] }, "node -e 1")).toEqual({ allow: true });
});

// -- splitting ---------------------------------------------------------------

for (const operator of ["&&", "||", ";", "|", "|&", "&", "\n"]) {
  test(`split operator ${JSON.stringify(operator)} reaches the part after it`, () => {
    const reason = refusal(bash(COMMANDS, `echo hi ${operator} sudo ls`));
    expect(reason).toBe('part "sudo ls" is refused by denyCommands rule "sudo"');
  });
}

test("parentheses separate parts", () => {
  expect(refusal(bash(COMMANDS, "(sudo ls)"))).toContain('rule "sudo"');
});

test("an operator inside quotes or after a backslash does not split", () => {
  expect(bash(COMMANDS, "echo 'a; sudo ls'")).toEqual({ allow: true });
  expect(bash(COMMANDS, 'echo "a && sudo ls"')).toEqual({ allow: true });
  expect(bash(COMMANDS, "echo a\\; sudo ls")).toEqual({ allow: true });
  expect(bash(COMMANDS, "echo a\\\nsudo ls")).toEqual({ allow: true });
});

test("a quoted operator-looking word does not hide a real command, and 2>&1 is no operator", () => {
  expect(refusal(bash(COMMANDS, "echo '&&'; sudo ls"))).toContain('rule "sudo"');
  expect(bash(COMMANDS, "ls nope 2>&1 | head")).toEqual({ allow: true });
});

test("an unterminated quote runs to the end", () => {
  expect(bash(COMMANDS, "echo 'sudo ls")).toEqual({ allow: true });
});

// -- rules -------------------------------------------------------------------

test("the command name is whole and without its directory", () => {
  expect(refusal(bash(COMMANDS, "/usr/bin/sudo ls"))).toContain('rule "sudo"');
  expect(bash(COMMANDS, "pseudo ls")).toEqual({ allow: true });
  expect(bash(COMMANDS, "echo sudo")).toEqual({ allow: true });
});

test("leading assignments and wrappers are looked through", () => {
  expect(refusal(bash(COMMANDS, "FOO=1 sudo ls"))).toContain('rule "sudo"');
  expect(refusal(bash(COMMANDS, "env -i A=b rm -rf /"))).toContain('rule "rm -rf /"');
  expect(refusal(bash(COMMANDS, "nohup time command git push --force"))).toContain("git push --force*");
});

test("a flag cluster matches by letters; other words by equality or glob", () => {
  for (const command of ["rm -rf /", "rm -fr /", "rm -rfv /", "rm -r -f /", "rm -rf /"]) {
    expect(refusal(bash(COMMANDS, command))).toContain('rule "rm -rf /"');
  }
  expect(bash(COMMANDS, "rm -r /")).toEqual({ allow: true });
  expect(bash(COMMANDS, "rm -rf /tmp/x")).toEqual({ allow: true });
  expect(refusal(bash(COMMANDS, "git -C x push origin --force-with-lease"))).toContain("git push --force*");
  expect(refusal(bash(COMMANDS, "git push --delete origin b"))).toContain("git push --delete");
  expect(bash(COMMANDS, "git push origin main")).toEqual({ allow: true });
  expect(refusal(bash({ denyCommands: ["rm -rf ~"] }, "rm -rf ~/"))).toContain('rule "rm -rf ~"');
});

test("a pipeline rule needs consecutive parts joined by a pipe", () => {
  expect(refusal(bash(COMMANDS, "curl http://x | sh"))).toBe(
    'part "curl http://x | sh" is refused by denyCommands rule "curl … | sh"',
  );
  expect(bash(COMMANDS, "curl http://x | tee y | sh")).toEqual({ allow: true });
  expect(bash(COMMANDS, "curl http://x; sh")).toEqual({ allow: true });
  expect(bash(COMMANDS, "curl http://x > out")).toEqual({ allow: true });
});

// -- inline code -------------------------------------------------------------

const INLINE: Array<[string, string]> = [
  ["bash -c 'ls'", "bash -c"],
  ["sh -c ls", "sh -c"],
  ["bash -lc ls", "bash -c"],
  ["python -c 'print(1)'", "python -c"],
  ["python3 -c 'print(1)'", "python3 -c"],
  ["node -e 1", "node -e"],
  ["bun -e 1", "bun -e"],
  ["osascript -e 'beep'", "osascript -e"],
  ["find . -name x -exec rm {} +", "find -exec"],
  ["ls | xargs rm", "xargs"],
  ["eval ls", "eval"],
  ["sudoish=1 env bash -c ls", "bash -c"],
];
for (const [command, form] of INLINE) {
  test(`inline code ${form} is refused though no rule names it`, () => {
    const reason = refusal(bash({ denyCommands: ["mkfs"] }, command));
    expect(reason).toContain(`runs inline code (${form})`);
    expect(reason).toContain("denyCommands");
  });
}

for (const [command, form] of [
  ["echo `ls`", "`"],
  ["echo $(ls)", "$("],
  ['echo "$(ls)"', "$("],
  ['echo "`ls`"', "`"],
  ["diff <(ls) b", "<("],
] as const) {
  test(`substitution ${form} outside single quotes is refused`, () => {
    expect(refusal(bash({ denyCommands: ["mkfs"] }, command))).toContain(`inline code (${form})`);
  });
}

test("substitution in single quotes and plain bash use are allowed", () => {
  expect(bash({ denyCommands: ["mkfs"] }, "echo '$(ls) `ls`'")).toEqual({ allow: true });
  expect(bash({ denyCommands: ["mkfs"] }, "bash script.sh")).toEqual({ allow: true });
  expect(bash({ denyCommands: ["mkfs"] }, "python script.py && node app.js")).toEqual({ allow: true });
});

// -- paths -------------------------------------------------------------------

function read(profile: AccessProfile, path: string, tool = "read"): ReturnType<typeof match> {
  return match(profile, { tool, input: { path }, cwd: CWD }, { home: HOME });
}

test("read, write and edit take their path argument", () => {
  for (const tool of ["read", "write", "edit"]) {
    expect(refusal(read(PATHS, "/home/u/.ssh/id_ed25519", tool))).toBe(
      'path "/home/u/.ssh/id_ed25519" is under denyPaths entry "~/.ssh"',
    );
  }
  expect(match(PATHS, { tool: "read", input: { file_path: "/etc/secret" }, cwd: CWD }).allow).toBe(false);
  expect(read(PATHS, "/home/u/.sshx/key")).toEqual({ allow: true });
  expect(read(PATHS, "/home/u")).toEqual({ allow: true });
  expect(match(PATHS, { tool: "read", input: {}, cwd: CWD })).toEqual({ allow: true });
  expect(match(PATHS, { tool: "ls", input: {}, cwd: CWD })).toEqual({ allow: true });
  expect(read(PATHS, "/etc/secret/a", "grep").allow).toBe(false);
});

test("~ is expanded, relative paths are joined to cwd, and .. is resolved", () => {
  expect(read(PATHS, "~/.ssh").allow).toBe(false);
  expect(read(PATHS, "~").allow).toBe(true);
  expect(read(PATHS, "~other/.ssh").allow).toBe(true);
  expect(refusal(read(PATHS, "../../../etc/secret/x"))).toContain("/etc/secret");
  expect(read(PATHS, "a/../../../../etc/secret").allow).toBe(false);
  expect(read(PATHS, "../project/../x").allow).toBe(true);
  expect(read(PATHS, ".git/config").allow).toBe(false);
  expect(read(PATHS, "sub/../.git/config/").allow).toBe(false);
  expect(read(PATHS, "../other/.git/config").allow).toBe(true);
  expect(read({ denyPaths: ["/"] }, "/anything").allow).toBe(false);
  expect(read({ denyPaths: [] }, "/anything").allow).toBe(true);
});

test("a path that only looks safe lexically is allowed: symlinks are not followed", () => {
  // `link` could point at ~/.ssh on disk; the matcher never asks the file system.
  expect(read(PATHS, "link/id_ed25519")).toEqual({ allow: true });
  expect(bash(PATHS, "cat link/id_ed25519")).toEqual({ allow: true });
  expect(bash(PATHS, "cat $HOME/.ssh/id_ed25519")).toEqual({ allow: true });
});

test("bash arguments that look like paths are checked", () => {
  expect(refusal(bash(PATHS, "cat ~/.ssh/id_ed25519"))).toBe(
    'path "~/.ssh/id_ed25519" is under denyPaths entry "~/.ssh"',
  );
  expect(bash(PATHS, "echo hi && cat ../../../etc/secret/x").allow).toBe(false);
  expect(bash(PATHS, "cat '/etc/secret'").allow).toBe(false);
  expect(bash(PATHS, "cp src/a.ts /etc/secret/").allow).toBe(false);
  expect(bash(PATHS, "echo x > ~/.ssh/authorized_keys").allow).toBe(false);
  expect(bash(PATHS, "echo x >~/.ssh/authorized_keys").allow).toBe(false);
  expect(bash(PATHS, "echo x 2>>/etc/secret/log").allow).toBe(false);
  expect(bash(PATHS, "tool --out=/etc/secret/f").allow).toBe(false);
  expect(bash(PATHS, "/etc/secret/run").allow).toBe(false);
  expect(bash(PATHS, "cat .git/config").allow).toBe(false);
  expect(bash(PATHS, "ls -la src && cat README.md 2>&1")).toEqual({ allow: true });
  expect(bash(PATHS, "echo '~/.ssh'").allow).toBe(false); // quoted words are still words
});

test("commands are checked before paths, and both apply to one call", () => {
  const both = { ...COMMANDS, ...PATHS };
  expect(refusal(bash(both, "sudo cat ~/.ssh/x"))).toContain("denyCommands");
  expect(refusal(bash(both, "cat ~/.ssh/x"))).toContain("denyPaths");
});

test("the matcher keeps no state between calls", () => {
  const first = bash(COMMANDS, "sudo ls");
  bash(COMMANDS, "echo 'unterminated");
  expect(bash(COMMANDS, "sudo ls")).toEqual(first);
});

test("readProfile names the field at fault and keeps only what the matcher reads", () => {
  expect(readProfile({ denyPaths: ["a"], askCommands: ["x"], network: "none" })).toEqual({
    ok: true,
    profile: { denyPaths: ["a"] },
  });
  expect(readProfile({ denyCommands: "sudo" })).toEqual({ ok: false, message: "denyCommands must be an array of strings" });
  expect(readProfile({ denyPaths: [1] })).toEqual({ ok: false, message: "denyPaths must be an array of strings" });
  expect(readProfile([])).toEqual({ ok: false, message: "the access profile must be an object" });
});

// -- grants ------------------------------------------------------------------

const GRANTS: AccessProfile = {
  denyCommands: ["rm"],
  grants: [
    { waitId: "w1", kind: "command", value: "rm -rf build" },
    { waitId: "w2", kind: "path", value: "/etc/secret", tool: "write" },
  ],
};

function call(tool: string, input: Record<string, unknown>) {
  return { tool, input, cwd: CWD };
}

test("a grant covers the call that equals its value exactly", () => {
  expect(findGrant(GRANTS, call("bash", { command: "rm -rf build" }))?.waitId).toBe("w1");
  expect(findGrant(GRANTS, call("bash", { command: "rm -rf build " }))).toBeUndefined();
  expect(findGrant(GRANTS, call("bash", { command: "rm -rf build && ls" }))).toBeUndefined();
  expect(findGrant(GRANTS, call("bash", { command: "rm -rf other" }))).toBeUndefined();
  // A command grant does not cover a path call, nor a path grant a command.
  expect(findGrant(GRANTS, call("read", { path: "rm -rf build" }))).toBeUndefined();
  expect(findGrant(GRANTS, call("bash", { command: "/etc/secret" }))).toBeUndefined();
});

test("a path grant covers the same file under any spelling, and only that file", () => {
  expect(findGrant(GRANTS, call("write", { path: "/etc/secret" }))?.waitId).toBe("w2");
  expect(findGrant(GRANTS, call("write", { file_path: "/etc/../etc/secret" }))?.waitId).toBe("w2");
  expect(findGrant(GRANTS, call("write", { path: "/etc/secret2" }))).toBeUndefined();
  expect(findGrant(GRANTS, call("write", { path: "/etc/secret/inner" }))).toBeUndefined();
});

test("a path grant covers the tool the person approved and no other", () => {
  for (const tool of ["read", "edit", "grep", "find", "ls"]) {
    expect(findGrant(GRANTS, call(tool, { path: "/etc/secret" }))).toBeUndefined();
  }
  // A path grant without a tool covers nothing.
  const bare: AccessProfile = { grants: [{ waitId: "w3", kind: "path", value: "/etc/secret" }] };
  expect(findGrant(bare, call("write", { path: "/etc/secret" }))).toBeUndefined();
});

test("a grant does not change what match says; the caller uses it up", () => {
  expect(match(GRANTS, call("bash", { command: "rm -rf build" }), { home: HOME }).allow).toBe(false);
  expect(findGrant({ denyCommands: ["rm"] }, call("bash", { command: "rm -rf build" }))).toBeUndefined();
});

test("readProfile reads grants and refuses a malformed one", () => {
  expect(readProfile({ grants: [{ waitId: "a", kind: "path", value: "/x", tool: "write" }] })).toEqual({
    ok: true,
    profile: { grants: [{ waitId: "a", kind: "path", value: "/x", tool: "write" }] },
  });
  for (const bad of [{ grants: "x" }, { grants: [1] }, { grants: [{ waitId: "a", kind: "url", value: "x" }] }]) {
    expect(readProfile(bad).ok).toBe(false);
  }
});
