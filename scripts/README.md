# Scripts

## Benchmarking `serve`

`bench-serve.ts` runs one fixed load scenario against a serve built from any
checkout, then prints one JSON object with the measurements.

```sh
bun scripts/bench-serve.ts --repo . --label current --repeat 3 \
  --duration 20000 --store-from ~/.operad/store --out /tmp/serve-current.json
```

It never opens the real home. It makes a temp home and starts the serve of
`--repo` there. Without `--store-from` the home is synthetic: a small plugin
adds three jobs whose step logs grow every 50 ms, one chat whose live reply is
pushed every 50 ms, and two runs waiting for a person. With `--store-from DIR`
it copies `log.sqlite` and `plugins.sqlite` from that store dir with SQLite's
`VACUUM INTO`, so the measured home has the same lasting facts and objects as
the source. Active runs in the copy are ended before serve starts; the source
is never written.

The scenario keeps the same shape for the measured time:

- three growing run objects, whose growth the kernel announces at its 250 ms
  window;
- one streaming chat-like reply with its 50 ms tails;
- two person waits, so pending has work;
- a terminal-like client and a desktop-like client following `/v1/events` and
  reading pending, running, object lists and open live sections;
- an independent probe reading `/v1/pending` and `/v1/running` every second.

The measurements are:

| Field | Meaning |
|---|---|
| `cpuSeconds` | serve process CPU time over the measured time (child runs excluded) |
| `cpuPercentMedian`, `cpuPercentPeak` | serve CPU from samples every 250 ms, excluding the first baseline interval |
| `rssPeakBytes` | peak serve RSS |
| `eventLatencyP50`, `eventLatencyP95` | `tail` event's plugin timestamp to the client reading it |
| `pendingP50`, `pendingP95`, `runningP50`, `runningP95` | HTTP response time for those requests |
| `eventsPerSecond` | change, tail and reset events over the measured time |
| `logReadsPerSecond` | requests for an object's `log` section over the measured time |
| `requests` | request counts by endpoint |

`logReadsPerSecond` counts the log section requests the clients made, not reads
inside serve: the script changes no product code, so there is no counter in the
log backend. The request counts and event rates show the rest of the work the
clients made.

`--repeat N` runs the whole scenario N times, each in a new temp home, and
reports the median of each per-run metric plus its own summary. Every run prints
the machine load before and after; record that beside the numbers.

To profile the measured window, add `--profile-dir DIR`:

```sh
bun scripts/bench-serve.ts --repo . --label current --duration 20000 \
  --store-from ~/.operad/store --profile-dir /tmp/serve-profile
```

Serve then runs under `bun --cpu-prof`; after it exits the script prints the top
five source frames by self time, as `file:line function`. The profile is cut to
the measured time, not startup or cleanup.

To compare a change, run the same script twice against worktrees of the two
commits, with the same `--duration`, `--repeat` and `--store-from`:

```sh
git worktree add --detach /tmp/operad-before <old-commit>
git worktree add --detach /tmp/operad-after <new-commit>
(cd /tmp/operad-before && bun install --frozen-lockfile)
(cd /tmp/operad-after && bun install --frozen-lockfile)
bun scripts/bench-serve.ts --repo /tmp/operad-before --label before \
  --repeat 3 --duration 20000 --store-from ~/.operad/store --out /tmp/before.json
bun scripts/bench-serve.ts --repo /tmp/operad-after --label after \
  --repeat 3 --duration 20000 --store-from ~/.operad/store --out /tmp/after.json
```

`--keep` leaves the temp home; otherwise it is removed after serve stops.
