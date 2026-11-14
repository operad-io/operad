------------------------- MODULE PoolTrace -------------------------
\* Trace validation of Pool: is the history of real tasks a behaviour of the
\* model? The events come from TraceData (scripts/tla-trace.ts, from
\* `operad history --json`). A step of the history that the model shows is one
\* step of Pool's Next on that task, and the task's observed phase after it is
\* the one the event says. Steps the history does not show (a claim, a retry
\* wait) are free between two events, as long as they change no task's
\* observed phase. When the model allows the whole history, TLC reports
\* "Invariant NotAllMatched is violated" (the accept); otherwise it ends with
\* no error, and the last TRACE line says the model allowed k events and not the
\* next one. Run with `-workers 1 -deadlock` (a dead end is a branch that took
\* the wrong hidden step, not a rejection). `bun scripts/tla-trace.ts verdict`
\* reads TLC's output and says which.
EXTENDS Pool, TraceData, Sequences, TLC

VARIABLE i   \* the next event to match

\* What the history can tell of a task's phase. `waiting`, `running` and `retry`
\* all look like "the work step is active": the history does not show who holds
\* a worker, nor that a task waits for one.
ObsOf(p) ==
  CASE p = "new" -> "new"
    [] p \in {"waiting", "running", "retry"} -> "work"
    [] p = "review" -> "review"
    [] p = "person" -> "person"
    [] p = "merged" -> "merged"
    [] p = "cancelled" -> "cancelled"

\* The phases an event allows the task to be in (their observed form); {} for an
\* event the model has no variable for.
After(e) ==
  CASE e = "start:work" -> {"work"}
    [] e \in {"result:work:done", "result:work:nothing"} -> {"review"}
    [] e = "result:work:failed" -> {"person"}
    [] e = "result:work:unavailable" -> {"work", "person"}
    [] e = "result:reverify:ready" -> {"review"}
    [] e = "result:integrate:merged" -> {"merged"}
    [] e \in {"run:cancelled", "result:work:cancelled", "result:integrate:cancelled"} -> {"cancelled"}
    [] e \in {"run:failed", "run:crashed"} -> {"unmodelled"}   \* no model has these: a history with one is rejected
    [] OTHER -> {}

Steps == SelectSeq(TraceEvents, LAMBDA e : After(e[2]) # {})

Obs(t) == ObsOf(phase[t])
Obs2(t) == ObsOf(phase'[t])

tvars == <<vars, i>>

TInit == Init /\ i = 1 /\ TLCSet(1, 0)

\* A step the history does not show.
Hidden ==
  /\ Next
  /\ \A t \in Tasks : Obs2(t) = Obs(t)
  /\ i' = i

\* The model makes the step the history shows (or the task is already where the
\* event leaves it: the history does not show the claim that comes after).
Shown ==
  /\ i <= Len(Steps)
  /\ LET t == Steps[i][1]
         ok == After(Steps[i][2])
     IN \/ /\ Next
           /\ Obs2(t) \in ok /\ Obs2(t) # Obs(t)
           /\ \A u \in Tasks \ {t} : Obs2(u) = Obs(u)
        \/ /\ Obs(t) \in ok
           /\ UNCHANGED vars
  /\ i' = i + 1

TNext == Hidden \/ Shown

TSpec == TInit /\ [][TNext]_tvars

TraceTypeOK == i \in 1..(Len(Steps) + 1)

\* Prints, the first time the model reaches a position in the history, how many
\* events it has matched and the next one it must match. The last line printed
\* says where the model stopped; `bun scripts/tla-trace.ts verdict` reads it.
Progress ==
  IF i > TLCGet(1)
  THEN /\ TLCSet(1, i)
       /\ PrintT(<<"TRACE", i - 1, Len(Steps),
                   IF i <= Len(Steps) THEN Steps[i][1] ELSE "-",
                   IF i <= Len(Steps) THEN Steps[i][2] ELSE "-">>)
  ELSE TRUE

\* Violated when the whole history is matched: that is the accept.
NotAllMatched == i <= Len(Steps)
=====================================================================
