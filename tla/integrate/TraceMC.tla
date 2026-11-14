---------------------------- MODULE TraceMC ----------------------------
EXTENDS IntegrateTrace

\* The tasks come from the history. The rework of a task that failed its
\* integration is a new verified commit, so MaxVer is the most such failures one
\* task has. The history shows no hand push, crash or commit in the clone: one
\* hand push may happen; the others are off.
MCTasks == TraceTasks
MCMaxVer == TraceMaxFails
=======================================================================
