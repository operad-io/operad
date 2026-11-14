---------------------------- MODULE TraceMC ----------------------------
EXTENDS PoolTrace

\* The instance of a trace: the tasks and their repositories come from the
\* history; each repository has one worker with one place, and the harness has
\* no home total. The history shows no worker, so this is the tightest instance
\* that is not trivially free.
MCTasks == TraceTasks
MCTRepo == TraceRepoOf
MCRepos == {TraceRepoOf[t] : t \in TraceTasks}
MCWorkers == MCRepos   \* the worker of a repository is named like it
MCHarnesses == {"h"}
MCCapped == {}
MCCap == [h \in {} |-> 1]
MCWRepo == [w \in MCWorkers |-> w]
MCWHarness == [w \in MCWorkers |-> "h"]
MCWCount == [w \in MCWorkers |-> 1]
MCWFallback == [w \in MCWorkers |-> "none"]
MCWRank == [w \in MCWorkers |-> 1]
MCMaxAttempts == TraceMaxStarts
=======================================================================
