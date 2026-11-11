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
  expect(bash(PATHS, "cat $HOME/.ssh/id_ed25519").allow).toBe(false);
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
    profile: { denyPaths: ["a"], askCommands: ["x"] },
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

// -- askCommands -------------------------------------------------------------

const ASKING: AccessProfile = { askCommands: ["git push", "rm -r", "brew install"] };

function asked(verdict: ReturnType<typeof match>): { reason: string; rule: string; value: string } {
  if (verdict.allow || verdict.ask !== true) throw new Error("expected an ask");
  expect(verdict.kind).toBe("command");
  return { reason: verdict.reason, rule: verdict.rule, value: verdict.value };
}

test("a command that matches askCommands asks, with the whole command as the value", () => {
  expect(asked(bash(ASKING, "git push origin main"))).toEqual({
    reason: 'part "git push origin main" matches askCommands rule "git push"',
    rule: "git push",
    value: "git push origin main",
  });
  expect(asked(bash(ASKING, "make && brew install jq")).rule).toBe("brew install");
  expect(asked(bash(ASKING, "env A=1 rm -rf build")).rule).toBe("rm -r");
});

test("a command that matches no askCommands rule is allowed", () => {
  expect(bash(ASKING, "git status && ls")).toEqual({ allow: true });
  expect(bash({ askCommands: [] }, "git push")).toEqual({ allow: true });
});

test("deny wins over ask, and ask wins over allow", () => {
  const both: AccessProfile = { denyCommands: ["git push --force*"], askCommands: ["git push"] };
  // Only the ask rule matches: ask.
  expect(asked(bash(both, "git push origin")).rule).toBe("git push");
  // Both match: the deny is the verdict and nobody is asked.
  const denied = bash(both, "git push --force origin");
  expect(denied.allow).toBe(false);
  expect(denied.ask).toBeUndefined();
  expect(refusal(denied)).toContain('denyCommands rule "git push --force*"');
  // A deny in another part of the command wins over an ask in this one.
  expect(bash({ denyCommands: ["sudo"], askCommands: ["git push"] }, "git push && sudo ls").ask).toBeUndefined();
  // A denied path wins over an ask.
  const path = bash({ denyPaths: ["~/.ssh"], askCommands: ["git push"] }, "git push ~/.ssh/id");
  expect(path.allow).toBe(false);
  expect(path.ask).toBeUndefined();
  expect(refusal(path)).toContain("denyPaths");
  // Ask over allow.
  expect(asked(bash({ ...COMMANDS, ...ASKING }, "git push")).rule).toBe("git push");
  expect(bash({ ...COMMANDS, ...ASKING }, "git status")).toEqual({ allow: true });
});

test("inline code asks while askCommands is set and is allowed without it", () => {
  expect(asked(bash(ASKING, "bash -c 'git push'")).rule).toBe("inline code");
  expect(asked(bash(ASKING, "echo $(whoami)")).rule).toBe("inline code");
  expect(bash({ askCommands: [] }, "bash -c 'git push'")).toEqual({ allow: true });
});

test("an ask verdict is a refusal to a caller that does not know ask", () => {
  expect(bash(ASKING, "git push").allow).toBe(false);
});

test("readProfile reads askCommands and refuses a malformed one", () => {
  expect(readProfile({ askCommands: ["git push"] })).toEqual({ ok: true, profile: { askCommands: ["git push"] } });
  expect(readProfile({ askCommands: "git push" })).toEqual({ ok: false, message: "askCommands must be an array of strings" });
});

test("a one-time grant covers an asked command exactly", () => {
  const profile: AccessProfile = { ...ASKING, grants: [{ waitId: "w9", kind: "command", value: "git push origin main" }] };
  const call = { tool: "bash", input: { command: "git push origin main" }, cwd: CWD };
  expect(match(profile, call, { home: HOME }).allow).toBe(false);
  expect(findGrant(profile, call)?.waitId).toBe("w9");
  expect(findGrant(profile, { ...call, input: { command: "git push origin other" } })).toBeUndefined();
});

// -- askPaths ----------------------------------------------------------------

const PROFILES: AccessProfile = { askPaths: ["~/.zshrc", "~/.*profile"] };

function write(profile: AccessProfile, path: string, tool = "write"): ReturnType<typeof match> {
  return match(profile, { tool, input: { path }, cwd: CWD }, { home: HOME });
}

test("a write or edit to an askPaths path asks with the path and the tool", () => {
  for (const [path, rule] of [["~/.zshrc", "~/.zshrc"], ["/home/u/.bash_profile", "~/.*profile"], ["~/.zprofile", "~/.*profile"]] as const) {
    const verdict = write(PROFILES, path, "edit");
    if (verdict.allow || verdict.ask !== true) throw new Error("expected an ask");
    expect(verdict).toMatchObject({ kind: "path", value: path, tool: "edit", rule });
  }
  expect(write(PROFILES, "~/.zshrc").ask).toBe(true);
});

test("other paths and read tools are allowed", () => {
  expect(write(PROFILES, "~/.zshrc.bak2/../notes")).toEqual({ allow: true });
  expect(write(PROFILES, "/home/u/src/a.ts")).toEqual({ allow: true });
  expect(write(PROFILES, "~/.zshrc", "read")).toEqual({ allow: true });
  expect(write(PROFILES, "~/x/.profile")).toEqual({ allow: true });
});

test("a bash redirect to an askPaths path asks with the whole command; a read does not", () => {
  const verdict = bash(PROFILES, "echo 'export A=1' >> ~/.zshrc");
  if (verdict.allow || verdict.ask !== true) throw new Error("expected an ask");
  expect(verdict).toMatchObject({ kind: "command", value: "echo 'export A=1' >> ~/.zshrc", rule: "~/.zshrc" });
  expect(bash(PROFILES, "echo a >~/.profile").ask).toBe(true);
  expect(bash(PROFILES, "cat ~/.zshrc")).toEqual({ allow: true });
  expect(bash(PROFILES, "echo a > /tmp/x 2>&1")).toEqual({ allow: true });
});

test("deny wins over an askPaths ask", () => {
  const verdict = write({ ...PROFILES, denyPaths: ["~/.zshrc"] }, "~/.zshrc");
  expect(verdict.allow).toBe(false);
  expect(verdict.ask).toBeUndefined();
  expect(bash({ ...PROFILES, denyPaths: ["~/.zshrc"] }, "echo a >> ~/.zshrc").ask).toBeUndefined();
});

test("a path grant for the tool covers the asked write, and only that", () => {
  const profile: AccessProfile = { ...PROFILES, grants: [{ waitId: "w5", kind: "path", value: "~/.zshrc", tool: "write" }] };
  const call = { tool: "write", input: { path: "~/.zshrc" }, cwd: CWD };
  expect(findGrant(profile, call, { home: HOME })?.waitId).toBe("w5");
  expect(findGrant(profile, { ...call, tool: "edit" }, { home: HOME })).toBeUndefined();
});

test("readProfile reads askPaths", () => {
  expect(readProfile({ askPaths: ["~/.zshrc"] })).toEqual({ ok: true, profile: { askPaths: ["~/.zshrc"] } });
  expect(readProfile({ askPaths: 1 }).ok).toBe(false);
});

// -- readOnly ----------------------------------------------------------------

test("a read-only working directory asks about a write under it, and only a write", () => {
  const profile: AccessProfile = { readOnly: true };
  const write = match(profile, { tool: "write", input: { path: "src/a.ts" }, cwd: CWD }, { home: HOME });
  expect(write).toMatchObject({ allow: false, ask: true, kind: "path", value: "src/a.ts", tool: "write" });
  const edit = match(profile, { tool: "edit", input: { path: `${CWD}/b.ts` }, cwd: CWD }, { home: HOME });
  expect(edit).toMatchObject({ allow: false, ask: true, tool: "edit" });
  expect(match(profile, { tool: "read", input: { path: "src/a.ts" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  expect(match(profile, { tool: "write", input: { path: "/tmp/scratch" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
  expect(match({}, { tool: "write", input: { path: "src/a.ts" }, cwd: CWD }, { home: HOME })).toEqual({ allow: true });
});

test("a read-only working directory asks about a bash redirect into it, and a deny still wins", () => {
  expect(bash({ readOnly: true }, "echo hi > notes.txt")).toMatchObject({ allow: false, ask: true, kind: "command" });
  expect(bash({ readOnly: true }, "ls -la")).toEqual({ allow: true });
  const denied = match(
    { readOnly: true, denyPaths: ["src"] },
    { tool: "write", input: { path: "src/a.ts" }, cwd: CWD },
    { home: HOME },
  );
  expect(denied).toMatchObject({ allow: false });
  expect(denied.ask).toBeUndefined();
});

test("readOnly is read from a profile, and only a boolean is accepted", () => {
  expect(readProfile({ readOnly: true })).toEqual({ ok: true, profile: { readOnly: true } });
  expect(readProfile({ readOnly: "yes" })).toEqual({ ok: false, message: "readOnly must be true or false" });
});

// -- the read-only allowlist -------------------------------------------------

import { isReadOnlyCommand } from "../src/index.ts";

test("commands that only read are on the read-only allowlist", () => {
  for (const command of [
    "git status", "git log --oneline -5", "git diff HEAD~1", "git show abc", "git blame a.ts", "git branch --list", "ls -la src",
    "cat a.ts | head -5 | wc -l", "grep -rn foo src", "rg foo", "find . -name '*.ts'", "sed -n 1,5p a.ts", "sed -n 3p a.ts",
    "bun test packages/x", "bunx tsc --noEmit", "git status && git log | head", "pwd",
  ]) expect([command, isReadOnlyCommand(command)]).toEqual([command, true]);
});

test("everything else is not read-only: redirects, tee, sed -i, cp, mv, git writes, a pipeline whose last stage writes", () => {
  for (const command of [
    "echo x > a.ts", "echo x >> a.ts", "echo x &> a.ts", "cat a 2> b", "cat a >| b", "ls | tee out", "cat a.ts | tee b.ts", "sed -i s/a/b/ a.ts",
    "sed -n 'w out' a.ts", "sed s/a/b/ a.ts", "cp a b", "mv a b", "rm a", "touch a", "git checkout main", "git commit -am x", "git add .", "git push",
    "git branch newbranch", "git -c core.fsmonitor=/tmp/x status", "git diff --output=out", "find . -delete", "find . -exec rm {} ;", "find . -fprint out",
    "rg --pre ./x foo", "tree -o out", "bunx tsc -b", "bunx tsc", "bun run build", "bun install", "ls $(touch a)", "ls `touch a`", "FOO=1 ls", "bash -c 'ls'",
    "cat a; rm b", "cat a && touch b", "cat a & touch b", "python3 x.py", "node -e 1", "xargs rm", "dd if=a of=b",
  ]) expect([command, isReadOnlyCommand(command)]).toEqual([command, false]);
});

test("a read-only directory asks about a command that is not on the allowlist, and lets a reading one run", () => {
  expect(bash({ readOnly: true }, "git status | head")).toEqual({ allow: true });
  expect(bash({ readOnly: true }, "sed -i s/a/b/ a.ts")).toMatchObject({ allow: false, ask: true, kind: "command", rule: "readOnly" });
  expect(bash({ readOnly: true }, "echo hi &> a.ts")).toMatchObject({ allow: false, ask: true, kind: "command" });
  expect(bash({ readOnly: true, denyCommands: ["git status"] }, "git status").ask).toBeUndefined();
  expect(bash({}, "sed -i s/a/b/ a.ts")).toEqual({ allow: true });
});

test("denyPaths follows ~, $HOME and ${HOME} in a bash command, quoted or not", () => {
  for (const command of [
    "cat ~/.ssh/id_rsa",
    'cat "$HOME/.ssh/id_rsa"',
    "cat ${HOME}/.ssh/id_rsa",
    "cat $HOME/.ssh/id_rsa",
    'cd "$HOME" && cat .ssh/id_rsa',
    "cd ~ && cat .ssh/id_rsa",
    "cd ${HOME}/.ssh; cat id_rsa",
  ]) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, rule: "~/.ssh" });
  }
});

test("a relative path after cd is matched against the cd target, not the call's cwd", () => {
  const repo: AccessProfile = { denyPaths: ["~/Code/repo"] };
  expect(bash(repo, 'cd "$HOME/Code/repo" && printf x > src/file')).toMatchObject({ allow: false, rule: "~/Code/repo" });
  expect(bash(repo, "cd /tmp && printf x > src/file")).toEqual({ allow: true });
  expect(bash({ denyPaths: ["/work/project/secret"] }, "cd /tmp && cat secret")).toEqual({ allow: true });
});

test("a path or cd target with an expansion the matcher cannot resolve asks", () => {
  for (const command of ["cat $OTHER/x", "cat ${OTHER}/x", "cat $(pwd)/x", "cat `pwd`/x", "cd $OTHER && ls", "cat ~other/x"]) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, ask: true, kind: "command", value: command, rule: "inline code" });
  }
  // a glob in the last component stays inside the denied directory
  expect(bash(PATHS, "cat ~/.ssh/id_*")).toMatchObject({ allow: false, rule: "~/.ssh" });
  expect(bash({ askPaths: ["~/.zshrc"] }, "echo x > $OTHER/f")).toMatchObject({ allow: false, ask: true, rule: "inline code" });
});

test("a deny wins over an ask for an unresolved expansion", () => {
  expect(bash(PATHS, "cat $OTHER/x ~/.ssh/id_rsa")).toMatchObject({ allow: false, rule: "~/.ssh" });
  expect(bash(PATHS, "cd $OTHER && cat ~/.ssh/id_rsa").ask).toBeUndefined();
});

test("a plain command with no expansion is still allowed under denyPaths", () => {
  expect(bash(PATHS, "cat src/a.ts && cd docs && ls ./b")).toEqual({ allow: true });
  expect(bash(PATHS, 'echo "$HOME is home" | cat')).toEqual({ allow: true });
});

test("positional parameters ask; combined cd options are not the target", () => {
  for (const command of ["cat /home/u/$1/.ssh/id", "cd $1 && cat .ssh/id", "cat /home/u/$@/x"]) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, ask: true, rule: "inline code" });
  }
  for (const command of ['cd -LP "$HOME" && cat .ssh/id_rsa', 'cd -P -L ~ && cat .ssh/id_rsa', 'cd -L -- ~ && cat .ssh/id_rsa']) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, rule: "~/.ssh" });
  }
});

test("the directory is unknown after anything that can change it but is not modelled: later relative paths ask", () => {
  const unknown = [
    '{ cd "$HOME"; cat .ssh/id_rsa; }',
    '(cd "$HOME"); cat .ssh/id_rsa',
    'if true; then cd "$HOME"; fi; cat .ssh/id_rsa',
    'for d in a; do cd "$HOME"; done; cat .ssh/id_rsa',
    'while false; do :; done; cat .ssh/id_rsa',
    'case x in x) cd "$HOME";; esac; cat .ssh/id_rsa',
    'f() { cd "$HOME"; }; f; cat .ssh/id_rsa',
    'eval cd "$HOME"; cat .ssh/id_rsa',
    'source ./x.sh; cat .ssh/id_rsa',
    '. ./x.sh; cat .ssh/id_rsa',
    'exec true; cat .ssh/id_rsa',
    'builtin cd "$HOME" && cat .ssh/id_rsa',
    'command cd "$HOME" && cat .ssh/id_rsa',
    'env cd "$HOME" && cat .ssh/id_rsa',
    'pushd "$HOME" && cat .ssh/id_rsa',
    'pushd "$HOME" && pushd /tmp && pushd +1 && cat .ssh/id_rsa',
    'popd && cat .ssh/id_rsa',
    "cd - && cat .ssh/id_rsa",
    "cd && cat .ssh/id_rsa",
    'CDPATH=/home/u cd .ssh; cat id_rsa',
    'cd "$HOME" | cat; cat .ssh/id_rsa',
  ];
  for (const command of unknown) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, ask: true, rule: "inline code" });
  }
  // a modelled cd in a chain still moves the directory, and a deny wins over the ask
  expect(bash(PATHS, 'true || cd "$HOME"; cat .ssh/id_rsa')).toMatchObject({ allow: false, rule: "~/.ssh" });
  expect(bash(PATHS, '{ cd /tmp; }; cat ~/.ssh/id_rsa')).toMatchObject({ allow: false, rule: "~/.ssh" });
});

test("an unknown directory covers the command name; pushd -n keeps the directory; $'…' words are read", () => {
  expect(bash(PATHS, 'pushd "$HOME" && pushd /tmp && pushd +1 && .ssh/id_rsa')).toMatchObject({ allow: false, ask: true, rule: "inline code" });
  expect(bash({ denyPaths: [".git/config"] }, "pushd -n /tmp && cat .git/config").allow).toBe(false);
  expect(bash(PATHS, "cat $'/home/u/.ssh/id_rsa'")).toMatchObject({ allow: false, rule: "~/.ssh" });
  expect(bash(PATHS, "cat $'/home/u/\\x2essh/id_rsa'")).toMatchObject({ allow: false, ask: true, rule: "inline code" });
});

test("a glob is judged by its literal prefix: refused when it can reach a denied path, asked when unsure", () => {
  for (const command of [
    "cat ~/.ss*/id_rsa", "cat ~/.ssh/*", "cat ~/*/id_rsa", "cat ~/.s[s]h/x", "cat /home/u/.ss?/x",
    "cat /home/u/[[:alpha:]]ssh/id", "cat /home/u/[[:punct:]]ssh/id_rsa", "cat /home/u/[^[:alpha:]]ssh/id", "cat /home/u/[]x.]ssh/id",
    "cat /home/u/{.ssh,tmp}/id", "cat /home/u/{a,b}/id", "cat /home/u/@(.ssh|tmp)/id", "cat /home/u/!(tmp)/id", "cat /home/u/+(.ssh)/id", "cat ~/**/id",
  ]) {
    expect(bash(PATHS, command)).toMatchObject({ allow: false, rule: "~/.ssh" });
  }
  // a cd target with a glob asks (or is refused when the word itself reaches a denied path)
  expect(bash({ denyPaths: ["/etc/secret"] }, "cd /tmp/* && cat file")).toMatchObject({ allow: false, ask: true });
  expect(bash(PATHS, "cd ~/.ss* && cat id_rsa").allow).toBe(false);
  expect(bash({ denyPaths: ["/tmp/secret"] }, "cd /tmp/?ecret && cat file")).toMatchObject({ allow: false, rule: "/tmp/secret" });
  // a glob followed by .. cannot be judged by its prefix
  expect(bash(PATHS, "cat /tmp/x*/../../home/u/.ssh/id")).toMatchObject({ allow: false, ask: true });
  expect(bash(PATHS, "ls src/*.ts")).toEqual({ allow: true });
  expect(bash(PATHS, "cat /tmp/{a,b}/x")).toEqual({ allow: true });
  expect(bash(PATHS, "cat /tmp/[[:digit:]]x/id")).toEqual({ allow: true });
});
