---------------------------- MODULE MC ----------------------------
EXTENDS Pool

\* Two repositories share two capped harnesses. r1: claude (falls back to pi)
\* and pi. r2: claude, pi (two at once, above the home total) and codex, none
\* of which has a fallback.
MCHarnesses == {"claude", "pi", "codex"}
MCCapped == {"claude", "pi"}
MCCap == [h \in MCCapped |-> 1]
MCWorkers == {"r1claude", "r1pi", "r2claude", "r2pi", "r2codex"}
MCRepos == {"r1", "r2"}
MCWRepo == [w \in MCWorkers |->
  IF w \in {"r1claude", "r1pi"} THEN "r1" ELSE "r2"]
MCWHarness == [w \in MCWorkers |->
  CASE w \in {"r1claude", "r2claude"} -> "claude"
    [] w \in {"r1pi", "r2pi"} -> "pi"
    [] OTHER -> "codex"]
MCWCount == [w \in MCWorkers |-> IF w = "r2pi" THEN 2 ELSE 1]
MCWFallback == [w \in MCWorkers |-> IF w = "r1claude" THEN "r1pi" ELSE "none"]
MCWRank == [w \in MCWorkers |->
  CASE w = "r1claude" -> 1 [] w = "r1pi" -> 2
    [] w = "r2claude" -> 1 [] w = "r2pi" -> 2 [] OTHER -> 3]
MCTasks == {"t1", "t2", "t3"}
MCTRepo == [t \in MCTasks |-> IF t \in {"t1", "t2"} THEN "r1" ELSE "r2"]
=======================================================================
