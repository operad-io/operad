---
name: setup-git
description: Set up git here. The first task in a folder that has no git, or on a machine that has none: install git if needed, then propose the first commit.
---

I want a task in the folder {target} and operad has told me that git is missing or not set
up there. Your job is to get git ready so the task can start. Reply in the language I write
to you in. Use these words with me: "Set up git here" (在这里设置 git); do not use the words
repository, worktree, branch or remote unless I use them first.

Rules that hold throughout:

- Git is needed only to create a task. Chatting in a folder and changing its files need
  none. You only get here because I asked for a task: never raise git before that.
- operad does not bundle git. When it must be installed, it is installed with the
  system's own tool.
- Every command you run goes through an approval I see in Pending, one command at a time,
  with a line saying what it does. Never run one around that, never chain several, and
  never use sudo or an administrator prompt unless the command below needs it.
- You write nothing into {target} yourself: no `git init`, no `.gitignore`, no commit.
  Approving the proposal does all of it.

1. Find out what is missing. Run `git --version`. If it prints a version, go to step 3. If
   it fails with "command not found" or the system offers to install developer tools, git
   is not installed: go to step 2. Do not run `git` inside {target} to find out.

2. Install git, with the command for this system, each as an approved pending item. Tell me
   in one sentence what it does first; it may open a system window or ask for my password.
   - macOS: `xcode-select --install` (Apple's command line tools; a window opens and I click
     Install). When it ends, run `git --version` again.
   - Windows: `winget install Git.Git`. Then I may have to close and reopen the app so it
     finds git; check with `git --version`.
   - Linux: the package manager of the distribution, found with `cat /etc/os-release`:
     `sudo apt-get install -y git` (Debian, Ubuntu), `sudo dnf install -y git` (Fedora,
     RHEL), `sudo pacman -S --noconfirm git` (Arch), `sudo zypper install -y git`
     (openSUSE), `sudo apk add git` (Alpine).
   If the tool is missing or fails, say what it printed and what I can do (download git
   from https://git-scm.com/downloads), and stop. Do not try other ways.

3. Look at the folder, without changing anything. List what is in {target} (`ls`), and note
   what must not go into a first commit: dependency folders (`node_modules`, `.venv`,
   `target`, `vendor`), build output (`dist`, `build`, `.next`), secrets (`.env*`, `*.pem`,
   `*.key`, `id_rsa*`), system files. If the folder already has a `.gitignore`, keep every
   line of it.

4. Name and email. A commit needs a name and an email. Ask me, in one sentence, for the
   name and email to put on the commits; offer the computer account's name as the default.
   If you do not know them, propose without `identity`: the proposal prefills them from the
   computer account and shows them in its review. When git already has an identity on this
   machine the proposal says so and uses it; do not ask again.

5. Propose it. Call the operad `command` tool with plugin `bot`, verb `setup-git`,
   arguments `{bot}` and `{target}`, and as input a JSON object: `{}` for the defaults, or
   with only what you change:

   {
     "gitignore": "<the whole .gitignore text, your folder's own lines kept>",
     "identity": { "name": "<name>", "email": "<email>" }
   }

   It makes a pending item titled "Set up git here" that shows the `.gitignore`, the list of
   files the first commit would hold and the name and email. Nothing is written into the
   folder or started until I approve it. With no input the command prints these steps again,
   so always send at least `{}`. If it refuses, say what it names in plain words and fix it
   (a `.gitignore` that lets a secret in, a folder that is my home folder or the top of a
   disk, a folder inside another project: then tell me that project's folder).

6. Report. Say what the pending item holds: how many files, anything you left out and why,
   the name and email. If it says there are more than 5000 files, tell me to look at the
   `.gitignore` before I approve. After I approve, the task I asked for can be created.
