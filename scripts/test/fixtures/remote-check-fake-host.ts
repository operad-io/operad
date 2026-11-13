/**
 * A fake ssh host for the remote-check tests. It runs the remote script in a
 * session of its own, as sshd does, and forwards a dropped connection as a
 * SIGHUP to that session. The script under test then has to end the command
 * it started, which no longer shares the local check's process group.
 */
import { spawn } from "node:child_process";

const [host, command] = process.argv.slice(2);
const home = process.env.FAKE_HOST_HOME;
if (host === undefined || command === undefined || home === undefined) {
  console.error("remote-check-fake-host: usage: <host> <command> (FAKE_HOST_HOME required)");
  process.exit(2);
}

const child = spawn("bash", ["-c", command], {
  cwd: home,
  env: { ...process.env, HOME: home },
  detached: true,
  stdio: "inherit",
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  if (child.pid !== undefined) {
    try {
      // sshd sends the HUP to the session's shell, not to every process the
      // command started: ending those is the remote script's job.
      process.kill(child.pid, "SIGHUP");
    } catch {
      // The remote script already ended.
    }
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
child.on("error", (error) => {
  console.error(`remote-check-fake-host: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128));
});
