---------------------------- MODULE Pool ----------------------------
(***************************************************************************)
(* How dev hands tasks to workers (ADR 0021), as the code does it:         *)
(*   packages/pool/src/index.ts   acquire, attempt, the fallback           *)
(*   packages/pool/src/places.ts  claim: first candidate with room in both *)
(*                                counts, taken atomically                 *)
(*   packages/dev/src/steps.ts    the work step: poolParams, rework asks   *)
(*                                for the previous worker, retry wait      *)
(* A task holds a place only while its worker runs. Every way a run ends   *)
(* (done, failed, model error, cancel, rework) releases it in `finally`.   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Harnesses,   \* harness plugin names
  Capped,      \* the harnesses the home layer lists (the others have no total)
  Cap,         \* [Capped -> Nat \ {0}]: home total of each listed harness (D2)
  Workers,     \* worker names; one name belongs to one repository
  WRepo,       \* [Workers -> Repos]
  WHarness,    \* [Workers -> Harnesses]
  WCount,      \* [Workers -> Nat \ {0}]: the repository share (D3)
  WFallback,   \* [Workers -> Workers \cup {None}]
  WRank,       \* [Workers -> Nat]: position in the pool's listed order (D5)
  Repos,
  Tasks,
  TRepo,       \* [Tasks -> Repos]: the default pool is every worker of the repository
  None,
  MaxAttempts, \* attempts a task may start in total (first, reworks)
  MaxWaits     \* retry waits of the work step (MAX_WORK_WAITS)

ASSUME /\ Capped \subseteq Harnesses
       /\ \A h \in Capped : Cap[h] \in Nat \ {0}
       /\ \A w \in Workers : WCount[w] \in Nat \ {0}
       /\ \A v, w \in Workers : (v # w /\ WRepo[v] = WRepo[w]) => WRank[v] # WRank[w]
       \* Load-time checks of D8: a fallback is a worker of the same repository,
       \* not itself, and the chain is one step.
       /\ \A w \in Workers : WFallback[w] # None =>
            /\ WFallback[w] \in Workers
            /\ WFallback[w] # w
            /\ WRepo[WFallback[w]] = WRepo[w]
            /\ WFallback[WFallback[w]] = None

VARIABLES
  phase,     \* [Tasks -> phases]
  holds,     \* [Tasks -> Workers \cup {None}]: the worker whose places the task holds
  used,      \* [Workers -> Nat]: the book's count key of each worker
  homeUsed,  \* [Harnesses -> Nat]: the book's key of each harness
  want,      \* [Tasks -> Workers \cup {None}]: the one worker the step asks for
  last,      \* [Tasks -> Workers \cup {None}]: the worker the latest attempt recorded
  isFb,      \* [Tasks -> BOOLEAN]: the current pool/agent call is on its fallback
  attempts,  \* [Tasks -> Nat]
  waits      \* [Tasks -> Nat]: retry waits used

vars == <<phase, holds, used, homeUsed, want, last, isFb, attempts, waits>>

Phases == {"new", "waiting", "running", "retry", "review", "person", "merged", "cancelled"}
Terminal == {"merged", "cancelled"}

WorkersOf(r) == {w \in Workers : WRepo[w] = r}

\* D7: a task that asks for a worker waits for that one only; otherwise the pool.
Cands(t) == IF want[t] # None THEN {want[t]} ELSE WorkersOf(TRepo[t])

\* D4: a worker has room when its own count and its harness total both do.
OwnRoom(w) == used[w] < WCount[w]
HomeRoom(w) == WHarness[w] \notin Capped \/ homeUsed[WHarness[w]] < Cap[WHarness[w]]
Room(w) == OwnRoom(w) /\ HomeRoom(w)

Take(w) ==
  /\ used' = [used EXCEPT ![w] = @ + 1]
  /\ homeUsed' = [homeUsed EXCEPT ![WHarness[w]] = @ + 1]

Release(w) ==
  /\ used' = [used EXCEPT ![w] = @ - 1]
  /\ homeUsed' = [homeUsed EXCEPT ![WHarness[w]] = @ - 1]

NoBook == /\ UNCHANGED <<used, homeUsed>>

Init ==
  /\ phase = [t \in Tasks |-> "new"]
  /\ holds = [t \in Tasks |-> None]
  /\ used = [w \in Workers |-> 0]
  /\ homeUsed = [h \in Harnesses |-> 0]
  /\ want = [t \in Tasks |-> None]
  /\ last = [t \in Tasks |-> None]
  /\ isFb = [t \in Tasks |-> FALSE]
  /\ attempts = [t \in Tasks |-> 0]
  /\ waits = [t \in Tasks |-> 0]

(* The task's work step calls pool/agent. *)
Start(t) ==
  /\ phase[t] = "new"
  /\ phase' = [phase EXCEPT ![t] = "waiting"]
  /\ attempts' = [attempts EXCEPT ![t] = 1]
  /\ NoBook
  /\ UNCHANGED <<holds, want, last, isFb, waits>>

(* D5: the first worker, in listed order, with room in both counts takes the
   work; claim() is one atomic step. *)
Claim(t) ==
  LET free == {w \in Cands(t) : Room(w)}
      w == CHOOSE v \in free : \A u \in free : WRank[v] <= WRank[u]
  IN /\ phase[t] = "waiting"
     /\ free # {}
     /\ phase' = [phase EXCEPT ![t] = "running"]
     /\ holds' = [holds EXCEPT ![t] = w]
     /\ Take(w)
     /\ UNCHANGED <<want, last, isFb, attempts, waits>>

(* The run ends; `finally` gives the places back. *)
EndRun(t, w) ==
  /\ holds' = [holds EXCEPT ![t] = None]
  /\ Release(w)

(* The harness finished its work. The reviewer is not in a pool (D11). *)
RunDone(t) ==
  LET w == holds[t] IN
  /\ phase[t] = "running"
  /\ phase' = [phase EXCEPT ![t] = "review"]
  /\ last' = [last EXCEPT ![t] = w]
  /\ EndRun(t, w)
  /\ UNCHANGED <<want, isFb, attempts, waits>>

(* The model is unavailable or at its usage limit, or the harness process
   cannot start (a failed result with reason `missing` or `spawn`).
   D8: a worker with a fallback runs it, after its own places are released.
   D9: otherwise the step waits and runs the same worker again, then a person. *)
RunModelError(t) ==
  LET w == holds[t] IN
  /\ phase[t] = "running"
  /\ EndRun(t, w)
  /\ last' = [last EXCEPT ![t] = w]
  /\ IF WFallback[w] # None /\ ~isFb[t]
       THEN /\ phase' = [phase EXCEPT ![t] = "waiting"]
            /\ want' = [want EXCEPT ![t] = WFallback[w]]
            /\ isFb' = [isFb EXCEPT ![t] = TRUE]
            /\ UNCHANGED waits
       ELSE IF waits[t] < MaxWaits
              THEN /\ phase' = [phase EXCEPT ![t] = "retry"]
                   /\ want' = [want EXCEPT ![t] = w]
                   /\ waits' = [waits EXCEPT ![t] = @ + 1]
                   /\ UNCHANGED isFb
              ELSE /\ phase' = [phase EXCEPT ![t] = "person"]
                   /\ UNCHANGED <<want, isFb, waits>>
  /\ UNCHANGED attempts

(* A timeout, a thrown harness step or another failure: D8 says no fallback;
   a person judges. *)
RunFailed(t) ==
  LET w == holds[t] IN
  /\ phase[t] = "running"
  /\ phase' = [phase EXCEPT ![t] = "person"]
  /\ last' = [last EXCEPT ![t] = w]
  /\ EndRun(t, w)
  /\ UNCHANGED <<want, isFb, attempts, waits>>

(* cancel while the worker runs: the run is stopped, the places released. *)
CancelRunning(t) ==
  /\ phase[t] = "running"
  /\ phase' = [phase EXCEPT ![t] = "cancelled"]
  /\ EndRun(t, holds[t])
  /\ UNCHANGED <<want, last, isFb, attempts, waits>>

(* rework while the worker runs: the run is stopped and the task goes back to
   the worker of that attempt. *)
ReworkRunning(t) ==
  LET w == holds[t] IN
  /\ phase[t] = "running"
  /\ attempts[t] < MaxAttempts
  /\ phase' = [phase EXCEPT ![t] = "waiting"]
  /\ last' = [last EXCEPT ![t] = w]
  /\ want' = [want EXCEPT ![t] = w]
  /\ isFb' = [isFb EXCEPT ![t] = FALSE]
  /\ attempts' = [attempts EXCEPT ![t] = @ + 1]
  /\ waits' = [waits EXCEPT ![t] = 0]
  /\ EndRun(t, w)

(* cancel anywhere the task holds nothing. *)
CancelIdle(t) ==
  /\ phase[t] \in {"new", "waiting", "retry", "review", "person"}
  /\ phase' = [phase EXCEPT ![t] = "cancelled"]
  /\ NoBook
  /\ UNCHANGED <<holds, want, last, isFb, attempts, waits>>

(* The retry timer of the work step fires: pool/agent is called again. *)
Retry(t) ==
  /\ phase[t] = "retry"
  /\ phase' = [phase EXCEPT ![t] = "waiting"]
  /\ NoBook
  /\ UNCHANGED <<holds, want, last, isFb, attempts, waits>>

(* The reviewer accepts: the task is merged. *)
Merge(t) ==
  /\ phase[t] = "review"
  /\ phase' = [phase EXCEPT ![t] = "merged"]
  /\ NoBook
  /\ UNCHANGED <<holds, want, last, isFb, attempts, waits>>

(* A reject by the reviewer, or a rework or reject by a person: D7, back to
   the worker the latest attempt recorded. *)
Rework(t) ==
  /\ phase[t] \in {"review", "person"}
  /\ attempts[t] < MaxAttempts
  /\ phase' = [phase EXCEPT ![t] = "waiting"]
  /\ want' = [want EXCEPT ![t] = last[t]]
  /\ isFb' = [isFb EXCEPT ![t] = FALSE]
  /\ attempts' = [attempts EXCEPT ![t] = @ + 1]
  /\ waits' = [waits EXCEPT ![t] = 0]
  /\ NoBook
  /\ UNCHANGED <<holds, last>>

(* A person who sees a task that is waiting after its work failed or ran out of
   time chooses `reverify`: the dev flow verifies and reviews what the work left,
   with no worker (found by trace validation; the first model had no such step). *)
Reverify(t) ==
  /\ phase[t] = "person"
  /\ phase' = [phase EXCEPT ![t] = "review"]
  /\ NoBook
  /\ UNCHANGED <<holds, want, last, isFb, attempts, waits>>

Finished == \A t \in Tasks : phase[t] \in Terminal

Next ==
  \/ \E t \in Tasks :
       \/ Start(t) \/ Claim(t) \/ RunDone(t) \/ RunModelError(t) \/ RunFailed(t)
       \/ CancelRunning(t) \/ ReworkRunning(t) \/ CancelIdle(t) \/ Retry(t)
       \/ Merge(t) \/ Rework(t) \/ Reverify(t)
  \/ Finished /\ UNCHANGED vars

\* Weak fairness: a claim that stays possible is taken, a run that is going ends,
\* a retry timer fires. The environment (cancel, rework, a person, the
\* reviewer) is not fair.
Fairness ==
  \A t \in Tasks :
    /\ WF_vars(Start(t))
    /\ WF_vars(Claim(t))
    /\ WF_vars(RunDone(t) \/ RunModelError(t) \/ RunFailed(t))
    /\ WF_vars(Retry(t))

Spec == Init /\ [][Next]_vars /\ Fairness

-------------------------------------------------------------------------
(* Safety *)

TypeOK ==
  /\ phase \in [Tasks -> Phases]
  /\ holds \in [Tasks -> Workers \cup {None}]
  /\ used \in [Workers -> Nat]
  /\ homeUsed \in [Harnesses -> Nat]
  /\ want \in [Tasks -> Workers \cup {None}]
  /\ last \in [Tasks -> Workers \cup {None}]

\* D3: the repository share is never exceeded.
RepoLimit == \A w \in Workers : used[w] <= WCount[w]

\* D2: the home total of a listed harness is never exceeded.
HomeLimit == \A h \in Capped : homeUsed[h] <= Cap[h]

\* A worker holds at most one task per count: with a share of 1 only one task
\* holds it, and no task holds two workers (holds is a function).
OneTaskPerSlot ==
  \A w \in Workers : Cardinality({t \in Tasks : holds[t] = w}) <= WCount[w]

\* A slot is released whenever its task stops holding it: the book's counts are
\* exactly what the running tasks hold, and only running tasks hold.
SlotsMatchHolders ==
  /\ \A w \in Workers : used[w] = Cardinality({t \in Tasks : holds[t] = w})
  /\ \A h \in Harnesses :
       homeUsed[h] = Cardinality({t \in Tasks : holds[t] # None /\ WHarness[holds[t]] = h})
  /\ \A t \in Tasks : (phase[t] = "running") <=> (holds[t] # None)

\* D7, D8, D9: a task that asked for one worker (a rework, a fallback, a retry)
\* only ever runs on that worker; it never switches to another.
RunsOnAsked == \A t \in Tasks : (phase[t] = "running" /\ want[t] # None) => holds[t] = want[t]

\* D3: a task runs only a worker of its own repository.
RunsInOwnRepo == \A t \in Tasks : holds[t] # None => WRepo[holds[t]] = TRepo[t]

\* D11: a task in review holds nothing (the reviewer is not in a pool).
ReviewerHoldsNothing == \A t \in Tasks : phase[t] = "review" => holds[t] = None

\* No hold-and-wait: a task that waits holds nothing, so a waiting task only
\* waits for running tasks, which wait for nobody: the wait graph has no cycle.
NoHoldAndWait == \A t \in Tasks : phase[t] \in {"waiting", "retry", "person"} => holds[t] = None

WaitsFor(t, u) ==
  /\ phase[t] = "waiting" /\ holds[u] # None
  /\ \/ holds[u] \in Cands(t)
     \/ \E w \in Cands(t) : WHarness[w] = WHarness[holds[u]] /\ WHarness[w] \in Capped
NoWaitCycle == \A t \in Tasks : ~((\E u \in Tasks : WaitsFor(t, u)) /\ (\E u \in Tasks : WaitsFor(u, t)))

-------------------------------------------------------------------------
(* Liveness, under Fairness *)

\* A waiting task gets a worker (or ends) once one is free.
WaitingGetsWorker == \A t \in Tasks : (phase[t] = "waiting") ~> (phase[t] # "waiting")

\* A running worker's run ends.
RunsEnd == \A t \in Tasks : (phase[t] = "running") ~> (phase[t] # "running")
=======================================================================
