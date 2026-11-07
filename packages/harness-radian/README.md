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

`concurrency` is counted across every run in the operad home, including the
runs `dev` starts through this step. A step is limited under the key
`harness-radian:<provider>/<model>`, built from the `--provider` and `--model`
flags in its `args` param (the model alone when there is no `--provider`); a
step without `--model` is not limited. A step over the limit waits in line,
first come first served, and `operad running` shows it as
`queued (<key>, <n> ahead)`. A change takes effect with the next step that
starts; steps already going keep their place.
