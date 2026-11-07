# @operad-io/harness-radian

The `harness-radian` plugin: one `agent` step that runs `radian exec` in a
directory and reads its closing result, and the `harness-radian:prompt` flow
that runs one prompt.

## Settings

The `harness-radian` section of `config.json`.

| setting | type | default | meaning |
|---|---|---|---|
| `command` | string | `radian` | the radian executable to run |
| `wallTimeSecs` | number | `300` | the longest one run may take |
| `stallSecs` | number | `600` | how long a run may print nothing |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once, such as `{ "opencode-go/deepseek-v4.1-flash": 2 }`; a model not listed has no limit |

How `concurrency` limits runs, what the key is and how a queued step shows
are in [the manual](../../docs/manual.md#limiting-runs-of-one-model).
