# ADR 0036: How Tests Are Kept Fast and Few

Status: accepted

## Background

A full run of the test suite is paid by every check and by every merge. Most of its time goes to a small share of cases that start real processes, build real git repositories, open ports or hold memory. Tests are kept light by testing what a simulation can test with a simulation, and the heavy ones are kept together so that they can be scheduled apart.

## Decisions

### D1: A simulation is used where it is enough

A behaviour that an in-process call, a fake runner or an injected clock can test is tested that way, without starting a new process. A real process is kept for what a simulation cannot test: a crash and a kill (the test kills a real child), process groups and signals, the restart and reload of `serve`, and a few smoke cases showing the command-line entry is connected.
### D2: Heavy cases live in `test/heavy/` of their package

A case that starts a real process, builds a real git repository, opens a port or holds much memory is in the `test/heavy/` directory of its package, apart from the light cases. The light cases run together at high concurrency; the heavy ones run as their own step with their own concurrency, and do not compete with other work. The check of a task runs only the heavy cases of the packages the change touches; the full set runs before a merge. Heavy cases in one file may share one preparation (one template repository, one `serve`).

### D3: No regression case for a whole incident

A test does not replay a whole incident as one scenario. The behaviours it showed are covered by small cases.

### D4: A helper is defined once

A test helper that more than one package needs (a temporary root, waiting for a file, a manual clock, a free port, and the like) is defined once in the testing package of the engine, and a test fails when the same helper is defined again outside it. A package's own `setup` holds only what is particular to that package.

### D5: The slowest cases are listed, never enforced

The log of a check lists the ten slowest cases for a person to read. No duration limit fails a check.
