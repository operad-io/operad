------------------------- MODULE Integrate -------------------------
\* The integration queue (packages/dev/src/integration-queue.ts), the step that
\* merges into the main branch (integrate.ts: runIntegrate, landBatch) and the
\* main clone (mainclone.ts: updateMainClone). Commits are records; a commit's
\* parent is part of its identity, so a candidate checked on one base is a
\* different commit from the same change on another base.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Tasks,      \* the tasks that may be merged
  MaxVer,     \* how many times a task can be reworked (a new verified commit)
  MaxHand,    \* pushes made by hand to origin/main
  MaxLocal,   \* commits made by hand in the main clone
  MaxCrash,   \* crashes of an integrating process
  MaxRound,   \* MAX_INTEGRATION_ROUNDS
  BatchMax,   \* settings.integration.batch (1: no batches)
  None

VARIABLES
  origin,      \* the commits of origin/main, oldest first
  clone,       \* the commits of the main clone's branch
  cdirty,      \* the clone has uncommitted changes
  cbranch,     \* the clone is on the main branch
  nlocal,      \* commits made by hand in the clone
  needPrep,    \* the clone moved and its prepare lines have not run yet
  followedTo,  \* the commit the last successful follow brought the clone to
  hands, crashes,
  ph,          \* each task's phase
  ver,         \* each task's verified commit (a version number)
  queue,       \* the tickets, in order; a crashed process's ticket stays until looked at
  claim,       \* claim file: a task named as follower of a leader (or None)
  solo,        \* "integrate alone" marks
  res,         \* a leader's result file: state and the batch head
  mem,         \* what a leader's candidate holds: pairs <<task, version>>
  cand,        \* a leader's candidate commit
  chk,         \* the integration checks passed on a leader's current candidate
  rnd,         \* rounds a leader has built
  rec,         \* the candidate saved as pending before the push
  tgt,         \* the commit the main clone follows
  unwanted     \* tasks merged although cancelled or reworked; "unchecked": a push whose checks had not passed

vars == <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo, hands,
  crashes, ph, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec, tgt,
  unwanted>>

Genesis == [kind |-> "genesis", parent |-> "none", mem |-> {}]
NoCommit == [kind |-> "none", parent |-> "none", mem |-> {}]
Tip(s) == IF s = <<>> THEN Genesis ELSE s[Len(s)]
Has(s, c) == \E i \in 1..Len(s) : s[i] = c
IdxOf(s, c) == CHOOSE i \in 1..Len(s) : s[i] = c
IsPrefix(a, b) == Len(a) <= Len(b) /\ SubSeq(b, 1, Len(a)) = a
Without(s, t) == SelectSeq(s, LAMBDA x : x # t)

Merging == {"turn", "start", "built", "checked", "pending"}
Active == {"queued", "turn", "start", "built", "checked", "pending", "pushed",
  "prep", "followed", "crashed"}
Final == {"merged", "failed", "cancelled"}

\* ---- the queue's reading of the tickets (tickets() and turn()) ----
IsLive(x) == ph[x] # "crashed"
LQ == SelectSeq(queue, IsLive)
InLQ(x) == Has(LQ, x)
\* A claim holds while its leader is queued or has left a result.
Claimed(x) ==
  /\ claim[x] # None
  /\ InLQ(x)
  /\ (InLQ(claim[x]) \/ res[claim[x]].state # "none")
NotClaimed(x) == ~Claimed(x)
UQ == SelectSeq(LQ, NotClaimed)
TurnHolder == IF UQ = <<>> THEN None ELSE UQ[1]

\* tickets() removes a claim file when none of its members has a live ticket, or
\* its leader is gone and left no result; it runs whenever a task joins.
Keep(l) ==
  /\ \E y \in Tasks : claim[y] = l /\ InLQ(y)
  /\ (InLQ(l) \/ res[l].state # "none")
PrunedClaim == [x \in Tasks |-> IF claim[x] # None /\ Keep(claim[x]) THEN claim[x] ELSE None]
PrunedRes == [l \in Tasks |->
  IF Keep(l) THEN res[l] ELSE [state |-> "none", head |-> NoCommit]]

OnMain(t) == \E i \in 1..Len(origin) : <<t, ver[t]>> \in origin[i].mem
Batched(t) == Cardinality(mem[t]) > 1
StillQueued(t) == \A p \in mem[t] : p[1] = t \/ InLQ(p[1])
Wanted(l, p) ==
  \/ p[1] = l
  \/ (ph[p[1]] \in {"queued", "crashed"} /\ ver[p[1]] = p[2])
Others(t) == {p[1] : p \in mem[t]} \ {t}

\* ---- initial state ----
Init ==
  /\ origin = <<>> /\ clone = <<>> /\ cdirty = FALSE /\ cbranch = TRUE
  /\ nlocal = 0 /\ needPrep = FALSE /\ followedTo = NoCommit
  /\ hands = 0 /\ crashes = 0
  /\ ph = [t \in Tasks |-> "idle"] /\ ver = [t \in Tasks |-> 0]
  /\ queue = <<>> /\ claim = [t \in Tasks |-> None] /\ solo = {}
  /\ res = [t \in Tasks |-> [state |-> "none", head |-> NoCommit]]
  /\ mem = [t \in Tasks |-> {}] /\ cand = [t \in Tasks |-> NoCommit]
  /\ chk = [t \in Tasks |-> FALSE] /\ rnd = [t \in Tasks |-> 0] /\ rec = [t \in Tasks |-> NoCommit]
  /\ tgt = [t \in Tasks |-> NoCommit] /\ unwanted = {}

\* ---- a task's integration ----

\* A task whose merge was chosen takes a ticket at the end of the queue.
Join(t) ==
  /\ ph[t] = "idle"
  /\ ph' = [ph EXCEPT ![t] = "queued"]
  /\ queue' = Append(queue, t)
  /\ rec' = [rec EXCEPT ![t] = NoCommit]
  /\ claim' = PrunedClaim /\ res' = PrunedRes
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, solo, mem, cand, chk, rnd, tgt, unwanted>>

\* The first live ticket that is not claimed has the turn.
Turn(t) ==
  /\ ph[t] = "queued"
  /\ TurnHolder = t
  /\ ph' = [ph EXCEPT ![t] = "turn"]
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec,
       tgt, unwanted>>

\* A leader that died after its push left the merge on main: found, not pushed again.
OnMainDone(t) ==
  /\ ph[t] = "turn"
  /\ OnMain(t)
  /\ ph' = [ph EXCEPT ![t] = "pushed"]
  /\ tgt' = [tgt EXCEPT ![t] = Tip(origin)]
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec,
       unwanted>>

\* queue.claim(batch): the first BatchMax-1 followers that are not solo and not claimed.
Claim(t) ==
  /\ ph[t] = "turn"
  /\ ~OnMain(t)
  /\ LET behind == SubSeq(LQ, IdxOf(LQ, t) + 1, Len(LQ))
         elig == SelectSeq(behind, LAMBDA x : x \notin solo /\ ~Claimed(x))
         k == IF t \in solo THEN 0
              ELSE IF Len(elig) < BatchMax - 1 THEN Len(elig) ELSE BatchMax - 1
         F == {elig[i] : i \in 1..k}
     IN /\ mem' = [mem EXCEPT ![t] = {<<t, ver[t]>>} \cup {<<f, ver[f]>> : f \in F}]
        /\ IF F # {}
           THEN /\ claim' = [x \in Tasks |->
                      IF x \in F THEN t ELSE IF claim[x] = t THEN None ELSE claim[x]]
                /\ res' = [res EXCEPT ![t] = [state |-> "none", head |-> NoCommit]]
           ELSE UNCHANGED <<claim, res>>
  /\ ph' = [ph EXCEPT ![t] = "start"]
  /\ rnd' = [rnd EXCEPT ![t] = 0]
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, queue, solo, cand, chk, rec, tgt, unwanted>>

\* A batch could not land: its tasks integrate one by one (queue.fallBack).
FallBack(t) ==
  /\ solo' = solo \cup Others(t)
  /\ claim' = [x \in Tasks |-> IF claim[x] = t THEN None ELSE claim[x]]
  /\ res' = [res EXCEPT ![t] = [state |-> "none", head |-> NoCommit]]
  /\ mem' = [mem EXCEPT ![t] = {<<t, ver[t]>>}]
  /\ rnd' = [rnd EXCEPT ![t] = 0]
  /\ ph' = [ph EXCEPT ![t] = "start"]

\* The task goes back to its work with a new verified commit, or waits for a person.
ReworkOrFail(t) ==
  /\ ph' = [ph EXCEPT ![t] = IF ver[t] < MaxVer THEN "idle" ELSE "failed"]
  /\ ver' = [ver EXCEPT ![t] = IF ver[t] < MaxVer THEN ver[t] + 1 ELSE ver[t]]

\* Build the candidate on a fresh fetch of origin/main; it may conflict.
Build(t) ==
  /\ ph[t] = "start"
  /\ \/ \* built
        /\ cand' = [cand EXCEPT ![t] =
             [parent |-> Tip(origin), mem |-> mem[t], kind |-> "merge"]]
        /\ chk' = [chk EXCEPT ![t] = FALSE]
        /\ rnd' = [rnd EXCEPT ![t] = @ + 1]
        /\ ph' = [ph EXCEPT ![t] = "built"]
        /\ UNCHANGED <<ver, queue, claim, solo, res, mem>>
     \/ \* conflict with main
        /\ Batched(t)
        /\ FallBack(t)
        /\ UNCHANGED <<ver, queue, cand, chk>>
     \/ \* conflict with main, alone: rework
        /\ ~Batched(t)
        /\ ReworkOrFail(t)
        /\ queue' = Without(queue, t) /\ solo' = solo \ {t}
        /\ UNCHANGED <<claim, res, mem, cand, rnd, chk>>
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, rec, tgt, unwanted>>

\* The integration checks run on the candidate.
Check(t) ==
  /\ ph[t] = "built"
  /\ \/ \* pass
        /\ chk' = [chk EXCEPT ![t] = TRUE]
        /\ ph' = [ph EXCEPT ![t] = "checked"]
        /\ UNCHANGED <<ver, queue, claim, solo, res, mem, rnd>>
     \/ \* the code fails the checks: a batch falls back, a single task is reworked
        /\ UNCHANGED chk
        /\ \/ Batched(t) /\ FallBack(t) /\ UNCHANGED <<ver, queue>>
           \/ ~Batched(t) /\ ReworkOrFail(t) /\ queue' = Without(queue, t)
              /\ solo' = solo \ {t} /\ UNCHANGED <<claim, res, mem, rnd>>
     \/ \* not the code (the machine): the task waits for a person, a batch falls back
        /\ UNCHANGED chk
        /\ ph' = [ph EXCEPT ![t] = "failed"]
        /\ queue' = Without(queue, t)
        /\ solo' = (IF Batched(t) THEN solo \cup Others(t) ELSE solo) \ {t}
        /\ claim' = [x \in Tasks |-> IF claim[x] = t /\ Batched(t) THEN None ELSE claim[x]]
        /\ res' = [res EXCEPT ![t] = IF Batched(t) THEN [state |-> "none", head |-> NoCommit] ELSE @]
        /\ UNCHANGED <<ver, mem, rnd>>
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, cand, rec, tgt, unwanted>>

\* The pending record is saved; a batch publishes its result if no one left.
Pending(t) ==
  /\ ph[t] = "checked"
  /\ rec' = [rec EXCEPT ![t] = cand[t]]
  /\ IF Batched(t) /\ ~StillQueued(t)
     THEN /\ FallBack(t)
          /\ UNCHANGED <<ver, queue, cand>>
     ELSE /\ res' = [res EXCEPT ![t] = IF Batched(t)
                       THEN [state |-> "pending", head |-> cand[t]] ELSE @]
          /\ ph' = [ph EXCEPT ![t] = "pending"]
          /\ UNCHANGED <<claim, solo, mem, rnd>>
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, queue, cand, chk, tgt, unwanted>>

\* git push: it lands only when origin/main is still the candidate's parent.
Push(t) ==
  /\ ph[t] = "pending"
  /\ chk[t]
  /\ LET c == cand[t] IN
     IF Tip(origin) = c.parent
     THEN /\ origin' = Append(origin, c)
          /\ unwanted' = unwanted \cup {p[1] : p \in {q \in c.mem : ~Wanted(t, q)}}
               \cup (IF chk[t] THEN {} ELSE {"unchecked"})
          /\ ph' = [ph EXCEPT ![t] = "pushed"]
          /\ tgt' = [tgt EXCEPT ![t] = c]
          /\ UNCHANGED <<queue, solo, claim, res, mem, rnd, ver>>
     ELSE /\ UNCHANGED <<origin, unwanted, tgt>>
          /\ IF rnd[t] < MaxRound
             THEN /\ ph' = [ph EXCEPT ![t] = "start"]
                  /\ UNCHANGED <<queue, solo, claim, res, mem, rnd, ver>>
             ELSE IF Batched(t)
             THEN /\ FallBack(t) /\ UNCHANGED <<queue, ver>>
             ELSE /\ ph' = [ph EXCEPT ![t] = "failed"]
                  /\ queue' = Without(queue, t) /\ solo' = solo \ {t}
                  /\ UNCHANGED <<claim, res, mem, rnd, ver>>
  /\ UNCHANGED <<clone, cdirty, cbranch, nlocal, needPrep, followedTo, hands,
       crashes, cand, chk, rec>>

\* updateMainClone: fast-forward only, on the branch, clean.
\* Each branch is enabled only under its own condition from updateMainClone.
FollowBlocked(t) ==
  \/ ~cbranch \/ cdirty
  \/ (~Has(clone, tgt[t])
      /\ ~IsPrefix(clone, SubSeq(origin, 1, IdxOf(origin, tgt[t]))))

Follow(t) ==
  /\ ph[t] = "pushed"
  /\ LET ts == SubSeq(origin, 1, IdxOf(origin, tgt[t])) IN
     \/ \* off the branch or uncommitted changes: not updated, the note says why
        /\ ~cbranch \/ cdirty
        /\ ph' = [ph EXCEPT ![t] = "followed"]
        /\ tgt' = [tgt EXCEPT ![t] = NoCommit]
        /\ UNCHANGED <<clone, needPrep, followedTo>>
     \/ \* the commit is already in the clone (is-ancestor): nothing to do
        /\ cbranch /\ ~cdirty /\ Has(clone, tgt[t])
        /\ ph' = [ph EXCEPT ![t] = "followed"]
        /\ followedTo' = tgt[t]
        /\ UNCHANGED <<clone, needPrep, tgt>>
     \/ \* clean, on the branch, the clone is an ancestor of the commit: fast-forward
        /\ cbranch /\ ~cdirty /\ ~Has(clone, tgt[t]) /\ IsPrefix(clone, ts)
        /\ clone' = ts /\ needPrep' = TRUE /\ followedTo' = tgt[t]
        /\ ph' = [ph EXCEPT ![t] = "prep"]
        /\ UNCHANGED tgt
     \/ \* clean, on the branch, but diverged (a local commit): cannot fast-forward
        /\ cbranch /\ ~cdirty /\ ~Has(clone, tgt[t]) /\ ~IsPrefix(clone, ts)
        /\ ph' = [ph EXCEPT ![t] = "followed"]
        /\ tgt' = [tgt EXCEPT ![t] = NoCommit]
        /\ UNCHANGED <<clone, needPrep, followedTo>>
  /\ UNCHANGED <<origin, cdirty, cbranch, nlocal, hands, crashes, ver, queue,
       claim, solo, res, mem, cand, chk, rnd, rec, unwanted>>

\* The prepare lines run in the clone after it moved (they may fail; the note says so).
Prepare(t) ==
  /\ ph[t] = "prep"
  /\ needPrep' = FALSE
  /\ ph' = [ph EXCEPT ![t] = "followed"]
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, followedTo, hands,
       crashes, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec, tgt,
       unwanted>>

\* recordMerged, then queue.finish() and queue.leave().
Record(t) ==
  /\ ph[t] = "followed"
  /\ ph' = [ph EXCEPT ![t] = "merged"]
  /\ res' = [res EXCEPT ![t] =
       IF res[t].state = "pending" /\ Has(queue, t)
       THEN [state |-> "done", head |-> res[t].head] ELSE @]
  /\ queue' = Without(queue, t) /\ solo' = solo \ {t}
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, claim, mem, cand, chk, rnd, rec, tgt, unwanted>>

\* A claimed task records the leader's result (done, or pending with a dead
\* leader whose push landed); a pending result whose push never landed voids the claim.
Batched1(x) ==
  /\ ph[x] = "queued" /\ Claimed(x)
  /\ LET l == claim[x]
         listed == \E p \in mem[l] : p[1] = x
         stale == \E p \in mem[l] : p[1] = x /\ p[2] # ver[x]
         landed == res[l].state = "pending" /\ ~InLQ(l) /\ Has(origin, res[l].head)
     IN /\ \/ res[l].state = "done" \/ landed
        /\ ph' = [ph EXCEPT ![x] = IF listed THEN "merged" ELSE "failed"]
        /\ unwanted' = IF stale THEN unwanted \cup {x} ELSE unwanted
  /\ queue' = Without(queue, x) /\ solo' = solo \ {x}
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, claim, res, mem, cand, chk, rnd, rec, tgt>>

ClaimVoid(x) ==
  /\ ph[x] = "queued" /\ Claimed(x)
  /\ LET l == claim[x] IN
     /\ res[l].state = "pending" /\ ~InLQ(l) /\ ~Has(origin, res[l].head)
     /\ claim' = [y \in Tasks |-> IF claim[y] = l THEN None ELSE claim[y]]
     /\ res' = [res EXCEPT ![l] = [state |-> "none", head |-> NoCommit]]
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ph, ver, queue, solo, mem, cand, chk, rnd, rec, tgt,
       unwanted>>

\* ---- what the world does ----

\* A task is cancelled or reworked (new verified commit) before its push.
Withdraw(t) ==
  /\ ph[t] \in {"queued", "turn", "start", "built", "checked"}
  /\ \/ ph' = [ph EXCEPT ![t] = "cancelled"] /\ UNCHANGED ver
     \/ /\ ver[t] < MaxVer
        /\ ph' = [ph EXCEPT ![t] = "idle"]
        /\ ver' = [ver EXCEPT ![t] = @ + 1]
  /\ queue' = Without(queue, t) /\ solo' = solo \ {t}
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, claim, res, mem, cand, chk, rnd, rec, tgt, unwanted>>

\* The integrating process is killed; its ticket stays until someone looks.
Crash(t) ==
  /\ crashes < MaxCrash
  /\ ph[t] \in Active \ {"crashed"}
  /\ ph' = [ph EXCEPT ![t] = "crashed"]
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec, tgt,
       unwanted>>

\* The run resumes. A saved candidate that origin has: do not push again.
Restart(t) ==
  /\ ph[t] = "crashed"
  /\ IF rec[t] # NoCommit /\ Has(origin, rec[t])
     THEN /\ ph' = [ph EXCEPT ![t] = "pushed"]
          /\ tgt' = [tgt EXCEPT ![t] = rec[t]]
          /\ queue' = Without(queue, t)
     ELSE /\ ph' = [ph EXCEPT ![t] = "queued"]
          /\ queue' = Append(Without(queue, t), t)
          /\ UNCHANGED tgt
  /\ IF rec[t] # NoCommit /\ Has(origin, rec[t])
     THEN UNCHANGED <<claim, res>>
     ELSE claim' = PrunedClaim /\ res' = PrunedRes
  /\ UNCHANGED <<origin, clone, cdirty, cbranch, nlocal, needPrep, followedTo,
       hands, crashes, ver, solo, mem, cand, chk, rnd, rec,
       unwanted>>

HandPush ==
  /\ hands < MaxHand
  /\ origin' = Append(origin, [parent |-> Tip(origin), mem |-> {}, kind |-> "hand"])
  /\ hands' = hands + 1
  /\ UNCHANGED <<clone, cdirty, cbranch, nlocal, needPrep, followedTo, crashes,
       ph, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec, tgt, unwanted>>

CloneDirty ==
  /\ cdirty' = ~cdirty
  /\ UNCHANGED <<origin, clone, cbranch, nlocal, needPrep, followedTo, hands,
       crashes, ph, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec,
       tgt, unwanted>>

CloneBranch ==
  /\ cbranch' = ~cbranch
  /\ UNCHANGED <<origin, clone, cdirty, nlocal, needPrep, followedTo, hands,
       crashes, ph, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec,
       tgt, unwanted>>

CloneCommit ==
  /\ nlocal < MaxLocal
  /\ clone' = Append(clone, [parent |-> Tip(clone), mem |-> {}, kind |-> "local"])
  /\ nlocal' = nlocal + 1
  /\ UNCHANGED <<origin, cdirty, cbranch, needPrep, followedTo, hands, crashes,
       ph, ver, queue, claim, solo, res, mem, cand, chk, rnd, rec, tgt, unwanted>>

AtRest == \A t \in Tasks : ph[t] \in Final

Next ==
  \/ \E t \in Tasks :
       Join(t) \/ Turn(t) \/ OnMainDone(t) \/ Claim(t) \/ Build(t) \/ Check(t)
       \/ Pending(t) \/ Push(t) \/ Follow(t) \/ Prepare(t) \/ Record(t)
       \/ Batched1(t) \/ ClaimVoid(t) \/ Withdraw(t) \/ Crash(t) \/ Restart(t)
  \/ HandPush \/ CloneDirty \/ CloneBranch \/ CloneCommit
  \/ AtRest /\ UNCHANGED vars

\* Weak fairness for what the code does by itself; the world (hand pushes,
\* cancel, rework, crashes, the clone's owner) is not fair.
Spec == Init /\ [][Next]_vars /\ \A t \in Tasks :
  /\ WF_vars(Join(t)) /\ WF_vars(Turn(t)) /\ WF_vars(OnMainDone(t))
  /\ WF_vars(Claim(t)) /\ WF_vars(Build(t)) /\ WF_vars(Check(t))
  /\ WF_vars(Pending(t)) /\ WF_vars(Push(t)) /\ WF_vars(Follow(t))
  /\ WF_vars(Prepare(t)) /\ WF_vars(Record(t)) /\ WF_vars(Batched1(t))
  /\ WF_vars(ClaimVoid(t)) /\ WF_vars(Restart(t))

\* ---- invariants ----
TypeOK ==
  /\ ph \in [Tasks -> Active \cup Final \cup {"idle"}]
  /\ \A t \in Tasks : ver[t] \in 0..MaxVer
  /\ Len(queue) <= Cardinality(Tasks)

\* At most one task is merging into the main branch.
OneMerge == Cardinality({t \in Tasks : ph[t] \in Merging}) <= 1

\* Every merge on origin is a candidate whose checks passed, on that very commit.
MergedWasChecked == "unchecked" \notin unwanted

\* origin/main only grows: each commit's parent is the one before it.
OriginLinear == \A i \in 1..Len(origin) :
  origin[i].parent = IF i = 1 THEN Genesis ELSE origin[i - 1]

\* The main clone holds no commit that origin lacks, except those made there by hand.
CloneNotAhead == \A i \in 1..Len(clone) : Has(origin, clone[i]) \/ clone[i].kind = "local"

\* A commit made by hand in the clone is never dropped (no reset).
LocalKept == nlocal > 0 => \E i \in 1..Len(clone) : clone[i].kind = "local"

\* Only a task that still wants the commit it was merged with is merged.
NoUnwantedMerge == unwanted \cap Tasks = {}

\* The prepare lines ran after the clone moved, once everything is done.
PrepareRan == AtRest => ~needPrep

\* After the last merge, a clone that was followed ends equal to origin/main.
CloneEqualsOrigin ==
  (AtRest /\ followedTo # NoCommit /\ followedTo = Tip(origin) /\ nlocal = 0) => clone = origin

\* ---- properties ----
\* A task that has pushed is recorded as merged.
PushedGetsMerged == \A t \in Tasks : (ph[t] = "pushed") ~> (ph[t] = "merged")

\* After a merge the main clone holds the merged commit, unless the follow was
\* skipped (off the branch, uncommitted changes, local commits): then the note
\* says so (tgt is NoCommit). A hand push after the last merge is not followed.
CloneFollowsMerge ==
  /\ \A t \in Tasks :
       (ph[t] = "pushed") ~> (ph[t] = "merged" /\ (tgt[t] = NoCommit \/ Has(clone, tgt[t])))
  \* a follow is skipped only when the clone was off the branch, dirty or diverged
  /\ [][\A t \in Tasks :
        (ph[t] = "pushed" /\ ph'[t] \in {"followed", "prep"} /\ tgt'[t] = NoCommit)
          => FollowBlocked(t)]_vars

\* A task in the queue is merged, reported (failed, cancelled) or sent back (idle).
QueuedResolves == \A t \in Tasks :
  (ph[t] \in Active) ~> (ph[t] \in Final \cup {"idle"})

=============================================================================
