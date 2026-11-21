import { describe, expect, test } from "bun:test";
import {
  checkEnvironment,
  checkHostOf,
  checkHostWarning,
  usesRemoteCheck,
} from "../src/check-host.ts";
import { validateDevSettings } from "../src/settings.ts";

const REMOTE = "if [ -f scripts/remote-check.sh ]; then bash scripts/remote-check.sh 'bash scripts/check-changed.sh'; fi";
const LOCAL = "bash scripts/verify.sh";

function repositorySettings(commands: readonly unknown[], extra: Readonly<Record<string, unknown>> = {}) {
  return validateDevSettings({ gate: { commands }, ...extra });
}

describe("the test host and slots from the home's settings", () => {
  test("a setting becomes the command's environment when serve's environment names neither", () => {
    expect(checkEnvironment({ testHost: "hai@192.0.2.1", testSlots: 2 }, {})).toEqual({
      OPERAD_CHECK_HOST: "hai@192.0.2.1",
      OPERAD_CHECK_SLOTS: "2",
    });
    expect(checkHostOf({ testHost: "hai@192.0.2.1" }, {})).toBe("hai@192.0.2.1");
  });

  test("an explicit variable in serve's own environment wins, including an empty host", () => {
    expect(
      checkEnvironment(
        { testHost: "setting@host", testSlots: 2 },
        { OPERAD_CHECK_HOST: "env@host", OPERAD_CHECK_SLOTS: "3" },
      ),
    ).toEqual({});
    expect(
      checkEnvironment(
        { testHost: "setting@host", testSlots: 2 },
        { OPERAD_CHECK_HOST: "" },
      ),
    ).toEqual({ OPERAD_CHECK_SLOTS: "2" });
    expect(checkHostOf({ testHost: "setting@host" }, { OPERAD_CHECK_HOST: "" })).toBeUndefined();
  });

  test("neither the setting nor the variable sets nothing", () => {
    expect(checkEnvironment({}, {})).toEqual({});
    expect(checkHostOf({}, {})).toBeUndefined();
  });
});

describe("a check command that uses scripts/remote-check.sh without a test host", () => {
  test("says one line naming the script and how to set the host", () => {
    const warning = checkHostWarning("operad", repositorySettings([REMOTE]), {}, {});
    expect(warning).toContain("remote-check.sh");
    expect(warning).toContain("no test host is set");
    expect(warning).toContain("they run here");
    expect(warning).toContain("dev.testHost or OPERAD_CHECK_HOST");
  });

  test("is not said when the setting or serve's own variable names a host", () => {
    expect(
      checkHostWarning("operad", repositorySettings([REMOTE]), { testHost: "hai@host" }, {}),
    ).toBeUndefined();
    expect(
      checkHostWarning("operad", repositorySettings([REMOTE]), {}, { OPERAD_CHECK_HOST: "hai@host" }),
    ).toBeUndefined();
  });

  test("is not said when no check command uses the script", () => {
    expect(checkHostWarning("operad", repositorySettings([LOCAL]), {}, {})).toBeUndefined();
  });

  test("counts an integration command, a flow's test stage and a rerun of failed tests", () => {
    expect(
      usesRemoteCheck(
        validateDevSettings({
          gate: { commands: [LOCAL] },
          integration: { keyCommands: [REMOTE] },
        }),
      ),
    ).toBe(true);
    expect(
      usesRemoteCheck(
        validateDevSettings({
          flows: { custom: { stages: [{ stage: "test", commands: [REMOTE] }] } },
        }),
      ),
    ).toBe(true);
    expect(
      usesRemoteCheck(
        validateDevSettings({
          gate: {
            commands: [
              {
                run: LOCAL,
                failed: { match: "^\\(fail\\) (.+?) \\[", rerun: `${REMOTE} -t {pattern}` },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });
});
