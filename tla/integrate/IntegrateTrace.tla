----------------------- MODULE IntegrateTrace -----------------------
\* Trace validation of Integrate: is the history of real tasks a behaviour of
\* the model? See tla/pool/PoolTrace.tla for the method. What the history shows
\* of a task is only whether its integrate step is running, how it ended
\* (merged, sent back for rework, failed for a person, cancelled) and in what
\* order the tasks did that. The ticket, the turn, the batch, the candidate,
\* the checks, the push and the clone are not in it; they are free. Run with
\* `-workers 1 -deadlock`; "Invariant NotAllMatched is violated" is the accept.
EXTENDS Integrate, TraceData, Sequences, TLC

VARIABLE i   \* the next event to match

ObsOf(p) ==
  CASE p = "idle" -> "idle"
    [] p \in Active -> "active"
    [] p = "merged" -> "merged"
    [] p = "failed" -> "failed"
    [] p = "cancelled" -> "cancelled"

After(e) ==
  CASE e = "start:integrate" -> {"active"}
    [] e = "result:integrate:merged" -> {"merged"}
    [] e \in {"result:integrate:fail", "result:integrate:conflict"} -> {"idle"}
    [] e = "result:integrate:failed" -> {"failed"}
    [] e \in {"run:cancelled", "result:integrate:cancelled"} -> {"cancelled"}
    [] e \in {"run:failed", "run:crashed"} -> {"unmodelled"}   \* no model has these: a history with one is rejected
    [] OTHER -> {}

Steps == SelectSeq(TraceEvents, LAMBDA e : After(e[2]) # {})

Obs(t) == ObsOf(ph[t])
Obs2(t) == ObsOf(ph'[t])

tvars == <<vars, i>>

TInit == Init /\ i = 1 /\ TLCSet(1, 0)

\* What the code does by itself. Withdraw (a cancel or a rework by the world
\* while the task is queued) is left out: the history shows a cancel as its own
\* event, and without this a task sent back by a failed integration could be
\* explained as a withdrawal.
NextOwn ==
  \/ \E t \in Tasks :
       Join(t) \/ Turn(t) \/ OnMainDone(t) \/ Claim(t) \/ Build(t) \/ Check(t)
       \/ Pending(t) \/ Push(t) \/ Follow(t) \/ Prepare(t) \/ Record(t)
       \/ Batched1(t) \/ ClaimVoid(t) \/ Crash(t) \/ Restart(t)
  \/ HandPush \/ CloneDirty \/ CloneBranch \/ CloneCommit
  \/ AtRest /\ UNCHANGED vars

Hidden ==
  /\ NextOwn
  /\ \A t \in Tasks : Obs2(t) = Obs(t)
  /\ i' = i

\* The model makes the step the history shows, or the task is already where the
\* event leaves it.
Shown ==
  /\ i <= Len(Steps)
  /\ LET t == Steps[i][1]
         ok == After(Steps[i][2])
     IN \/ /\ IF ok = {"cancelled"} THEN Next ELSE NextOwn
           /\ Obs2(t) \in ok /\ Obs2(t) # Obs(t)
           /\ \A u \in Tasks \ {t} : Obs2(u) = Obs(u)
        \/ /\ Obs(t) \in ok
           /\ UNCHANGED vars
  /\ i' = i + 1

TNext == Hidden \/ Shown

TSpec == TInit /\ [][TNext]_tvars

TraceTypeOK == i \in 1..(Len(Steps) + 1)

Progress ==
  IF i > TLCGet(1)
  THEN /\ TLCSet(1, i)
       /\ PrintT(<<"TRACE", i - 1, Len(Steps),
                   IF i <= Len(Steps) THEN Steps[i][1] ELSE "-",
                   IF i <= Len(Steps) THEN Steps[i][2] ELSE "-">>)
  ELSE TRUE

NotAllMatched == i <= Len(Steps)
=====================================================================
