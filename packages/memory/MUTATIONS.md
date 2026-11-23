# Mutation records — `memory`

Rows whose mutation broke code in `packages/memory/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M1 | packages/memory/src/memory.ts | `ensureRepository` returned the directory without running `git init` | `the wiki directory > is created when missing, with a git repository` |
| T-0585-M2 | packages/memory/src/memory.ts | a repository that already held the directory was reported as one this call made | `the wiki directory > a directory that is already a repository is used as it is, never re-initialised` |
| T-0585-M3 | packages/memory/src/commit.ts | `withoutUntrustedLines` returned the index unchanged, so an untrusted note stayed linked | `a bot run is recorded in git > a note marked as untrusted is kept out of the index, and the note itself stays` |
| T-0585-M4 | packages/memory/src/commit.ts | `commitChanges` committed an unchanged directory instead of returning no commit | `a bot run is recorded in git > a second run that wrote nothing makes no commit` |
| T-0585-M5 | packages/memory/src/commit.ts | `commitMessage` left the bot and the chat out of the subject | `a bot run is recorded in git > one commit in the memory and one in the wiki, each naming the bot and the chat` |
| T-0585-M6 | packages/memory/src/memory.ts | `ensureMemoryLayout` stopped making `instructions.md` | `the memory layout > the index, the daily log and the instructions are made, and nothing is overwritten` |

## T-0585 rework 1 — a chat that is not a bot's

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M13 | packages/memory/src/commit.ts | `botChatOf` accepted a chat whose parent was not a bot | `a bot run is recorded in git > a chat that is not a bot's is left alone` |

## T-0586 — the memory files a reply carries

| id | file | mutation | failing test |
|---|---|---|---|
| T-0586-M7 | packages/memory/src/memory.ts | `memoryNotes` left the instructions out | `the files a bot chat carries as notes > the index is cut at 8,000 characters and the instructions are whole` |
| T-0586-M8 | packages/memory/src/memory.ts | `MEMORY_INDEX_MAX` was 9,000 instead of 8,000 | `the memory notes a bot chat carries > a long index is cut at the memory plugin's limit` |

## T-0587 — the full-text index, its scopes and the search tool

| id | file | mutation | failing test |
|---|---|---|---|
| T-0587-M1 | packages/memory/src/search/backend.ts | the trigram substring fallback was turned off, so a term shorter than three characters matched nothing | `the Chinese tokenizer measurement > trigram with its short-query fallback finds every fixture query` |
| T-0587-M2 | packages/memory/src/search/backend.ts | the scope/owner condition was dropped, so one bot's memory and chats were reachable from another bot's search | `the full-text index > a bot sees only its own memory and chats beside the shared wiki` |
| T-0587-M3 | packages/memory/src/search/service.ts | an existing document was always kept, so a changed file was never re-read | `the full-text index > a changed file is found on the next search, and a deleted one is gone` |
| T-0587-M4 | packages/memory/src/search/backend.ts | the frontmatter field conditions were left out of the query | `the full-text index > frontmatter fields filter the results` |
| T-0587-M5 | packages/memory/src/search/service.ts | the search skipped the `_about.md` lookup, so directory notes never came back | `the full-text index > a directory's _about.md is returned with its hits` |

## T-0588 — the memory tidy's check and rewrite guard

| id | file | mutation | failing test |
|---|---|---|---|
| T-0588-M1 | packages/memory/src/tidy.ts | `memoryTidyState` returned no changed notes | `the memory tidy's check > a fresh memory has no work, a new note is work, and the index over its limit is work` |
| T-0588-M2 | packages/memory/src/tidy.ts | `rewriteDrop` never reported a rewrite as voided | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M3 | packages/memory/src/tidy.ts | `applyAppendOnly` returned without restoring or merging any file | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M11 | packages/memory/src/commit.ts | a tidy that changed no file no longer made its empty commit | `Run without asking > a run that changes nothing makes the memory commit but sends no notice` |

## T-0590 — memory v1 follow-ups, the wiki and the search index

| id | file | mutation | failing test |
|---|---|---|---|
| T-0590-M17 | packages/memory/src/commit.ts | `commitBotRun` stripped untrusted links from the bot's index but not the wiki's | `a bot run is recorded in git > a note marked as untrusted in the wiki is kept out of the wiki's index too` |
| T-0590-M18 | packages/memory/src/commit.ts | the wiki's removed untrusted links were left out of `unindexed` | `a bot run is recorded in git > a note marked as untrusted in the wiki is kept out of the wiki's index too` |
| T-0590-M19 | packages/memory/src/tidy.ts | `tidyCommitForChat` matched the chat as a substring, so C-1 found C-12 | `the memory tidy's check > a tidy commit is found for its own chat, not one whose id has it as a prefix` |
| T-0590-M20 | packages/memory/src/search/service.ts | `refreshChats` read every chat's facts instead of comparing the latest fact sequence | `the full-text index > an unchanged chat's facts are not read on the next refresh` |
| T-0590-M21 | packages/memory/src/search/sources.ts | `chatOwner` returned the stored cwd string while a search resolved its owner | `the full-text index > a chat's owner is compared as a resolved path` |
| T-0590-M22 | packages/memory/src/tidy.ts | `lastTidyCommit` returned undefined instead of the latest tidy commit | `Run without asking > a run that changes nothing makes the memory commit but sends no notice` |
| T-0590-M23 | packages/memory/src/tidy.ts | `tidyCommitSummary` never reported a voided rewrite | `the void-rewrite guard > a tidy chat's commit voids the rewrite, keeps the old entries and records why` |

## T-0595 — untrusted notes are kept out of the index through wikilinks too

| id | file | mutation | failing test |
|---|---|---|---|
| T-0595-M1 | packages/memory/src/commit.ts | `withoutUntrustedLines` read only Markdown links, so an index line with a wikilink to an untrusted note stayed | `a bot run is recorded in git > an index line that links to an untrusted note with a wikilink is removed too` |
| T-0595-M2 | packages/memory/src/commit.ts | `withoutUntrustedLines` URL-decoded wikilink targets too, so a bare `%` threw and the commit step failed | `a bot run is recorded in git > a wikilink with a bare percent is not decoded and stays in the index` |

## T-0596 — wikilink folders, table pipes and a Markdown target's bare percent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0596-M1 | packages/memory/src/commit.ts | `wikilinkTarget` kept the backslash a table row escapes its alias pipe with, so the target never named the note | `a bot run is recorded in git > an index line that links to an untrusted note with a wikilink is removed too` |
| T-0596-M2 | packages/memory/src/commit.ts | `wikilinkLinksNote` compared a bare name with a note's whole path, so `[[from-web]]` missed `topics/from-web.md` | `a bot run is recorded in git > an index line that links to an untrusted note with a wikilink is removed too` |
| T-0596-M3 | packages/memory/src/commit.ts | `decodeLinkPath` called `decodeURIComponent` unguarded, so a Markdown target with a bare `%` threw and the commit step failed | `a bot run is recorded in git > a Markdown link with a bare percent is not decoded and stays in the index` |

## T-0597 — the link table in the search index

| id | file | mutation | failing test |
|---|---|---|---|
| T-0597-M1 | packages/memory/src/search/links.ts | `splitPipe` kept a `\|` in the target instead of splitting there, so a table wikilink named a note that does not exist | `the links a note writes > an escaped pipe in a table separates the target from the display text` |
| T-0597-M2 | packages/memory/src/search/links.ts | `decoded` called `decodeURIComponent` without catching, so a bare `%` made parsing throw | `the links a note writes > a bare percent is kept as written instead of throwing` |
| T-0597-M3 | packages/memory/src/search/links.ts | `withoutCode` returned the text unchanged, so a link shown as code was stored | `the links a note writes > code blocks and inline code are not links` |
| T-0597-M4 | packages/memory/src/search/links.ts | `external` only rejected an empty target, so `https:`, `mailto:` and `//` were note links | `the links a note writes > external links and image embeds are not note links` |
| T-0597-M5 | packages/memory/src/search/links.ts | `resolveNoteLink` tried the file name before the path from the scope root | `how a link resolves > a path from the scope root wins over a file of the same name` |
| T-0597-M6 | packages/memory/src/search/links.ts | `nearestByName` sorted the same-named files by path instead of by distance from the source | `how a link resolves > among files of the same name the one nearest the source note wins` |
| T-0597-M7 | packages/memory/src/search/links.ts | `resolveNoteLink` left out the source-relative candidates, so `../tea.md` fell through to the name match | `how a link resolves > a markdown target not at the root is taken relative to the source note` |
| T-0597-M8 | packages/memory/src/search/backend.ts | `put` deleted every unresolved link row after storing a document's links, so a target nobody wrote was forgotten | `the link table > a note written under a name somebody linked to takes those links` |
| T-0597-M9 | packages/memory/src/search/service.ts | `refresh` parsed the links only for a document it had not seen before, so an edited note kept no links | `the link table > editing a note replaces the links it wrote` |
| T-0597-M10 | packages/memory/src/search/service.ts | `refresh` resolved the links before it read the files, so a renamed note did not get its links | `the link table > renaming a note points the links that named it at the new place` |
| T-0597-M11 | packages/memory/src/search/backend.ts | `remove` kept the deleted document's own link rows | `the link table in the backend > removing a document drops its links and leaves the links to it unresolved` |
| T-0597-M12 | packages/memory/src/search/backend.ts | `remove` left the incoming target ids pointing at the deleted document | `the link table in the backend > removing a document drops its links and leaves the links to it unresolved` |
| T-0597-M13 | packages/memory/src/search/service.ts | `backlinks` selected the links a note writes instead of the links that point at it | `the link table > links from a note, backlinks and unresolved targets come from the same index` |
| T-0597-M14 | packages/memory/src/search/service.ts | `unresolvedTargets` counted one link per target however many named it | `the link table > links from a note, backlinks and unresolved targets come from the same index` |
| T-0597-M15 | packages/memory/src/search/service.ts | `orphanNotes` returned the notes other notes link to instead of the notes they do not | `the link table > a note no other note links to is an orphan` |
| T-0597-M16 | packages/memory/src/search/backend.ts | a tokenizer change dropped the documents but not `search_links`, so the old links survived the rebuild | `the link table > a rebuild for another tokenizer drops the old link table` |
| T-0597-M17 | packages/memory/src/search/service.ts | the resolution pool no longer named the scope and owner, so a wiki note resolved a name in a bot's memory | `the link table > a link stays in the scope of the note that writes it` |
| T-0597-M18 | packages/memory/src/search/backend.ts | an index without a link table (or with another version of it) no longer cleared its notes' stored modification time, so a refresh skipped every note and the table stayed empty | `the link table > an index built before the link table fills it on the next refresh`; `the link table > a link table from an older version is filled again from the notes` |
| T-0597-M19 | packages/memory/src/commit.ts | `withoutUntrustedLines` matched the untrusted note against the line's text instead of the links `parseNoteLinks` reads and `resolveNoteLink` resolves, so a bare `[[from-web]]` stayed in the index | `one link parser for the index and the link table > the targets the link table reads are the ones the index commit drops`; `a bot run is recorded in git > an index line that links to an untrusted note with a wikilink is removed too` |

## T-0598 — read lists the notes that link to it

| id | file | mutation | failing test |
|---|---|---|---|
| T-0598-M1 | packages/memory/src/search/service.ts | `read` returned an empty `backlinks` array instead of the links that point at the note | `the link table > a read lists the notes that link to it, with the line and excerpt` |
| T-0598-M2 | packages/memory/src/search/service.ts | `readBacklinks` marked every linking note as trusted, ignoring its `untrusted: true` frontmatter | `the link table > a read lists the notes that link to it, with the line and excerpt`; `the memory search commands > read ends with Backlinks, and --json gives the backlinks array` |
| T-0598-M3 | packages/memory/src/search/command.ts | `read` rendered text even when the caller asked for JSON with `--json` or JSON input | `the memory search commands > read ends with Backlinks, and --json gives the backlinks array` |

## T-0599 — the tidy's link check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0599-M1 | packages/memory/src/link-report.ts | every broken link reported line 1 instead of the line that writes it | `the link report a tidy reads > a fixture wiki gives broken links with their line, orphans, wanted targets and unlinked mentions` |
| T-0599-M2 | packages/memory/src/link-report.ts | `structural` treated `index.md`, `_about.md` and `log/` notes as ordinary orphans | `the link report a tidy reads > the index, the log and a directory description are never orphans` |
| T-0599-M3 | packages/memory/src/link-report.ts | a target was wanted when two notes linked to it instead of three | `the link report a tidy reads > a target is wanted only when three different notes link to it` |
| T-0599-M4 | packages/memory/src/link-report.ts | `UNLINKED_MENTION_LIMIT` was 25, so the list was not capped at 20 | `the link report a tidy reads > unlinked mentions stop at the cap` |

## T-0599 rework 1 — the tidy's link check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0599-M5 | packages/memory/src/link-report.ts | unlinked mentions did not skip a source note that already links the target | `the link report a tidy reads > a title a note already links to is not an unlinked mention` |

## T-0600 — the followups on the link table, backlinks and the tidy's lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0600-M1 | packages/memory/src/links.ts | `withoutCode` treated only eight leading spaces as an indented code block, so a four-space one kept its link | `the links a note writes > an indented code block is not links, but an indented paragraph line is` |
| T-0600-M2 | packages/memory/src/links.ts | a Markdown link read only the bare destination, so an angle-bracketed target was dropped | `the links a note writes > a markdown target may have a space or be enclosed in angle brackets` |
| T-0600-M3 | packages/memory/src/links.ts | a wikilink with a heading and no target was skipped, so `[[#Heading]]` did not point at its own note | `the links a note writes > a wikilink may name a heading in its own note`; `the link table > a read leaves out a note's link to itself and keeps a link's place after code` |
| T-0600-M4 | packages/memory/src/links.ts | a wikilink that names a path fell back to a same-named file anywhere | `how a link resolves > a target with a path is not reduced to a file name` |
| T-0600-M5 | packages/memory/src/links.ts | a Markdown target fell back to a file name, so an index line naming `from-web.md` matched `topics/from-web.md` | `how a link resolves > a target with a path is not reduced to a file name`; `one link parser for the index and the link table > the targets the link table reads are the ones the index commit drops` |
| T-0600-M6 | packages/memory/src/search/service.ts | a stored link's line was always 1, so a backlink pointed at the top of its note | `the link table > a read lists the notes that link to it, with the line and excerpt`; `the link table > a read leaves out a note's link to itself and keeps a link's place after code` |
| T-0600-M7 | packages/memory/src/search/service.ts | `readBacklinks` kept a note's link to itself | `the link table > a read leaves out a note's link to itself and keeps a link's place after code` |
| T-0600-M8 | packages/memory/src/link-report.ts | an unlinked mention used a substring match, so `Tea` matched inside `Steam` | `the link report a tidy reads > a short title inside another word is not an unlinked mention` |
| T-0600-M9 | packages/memory/src/link-report.ts | every note was trusted, so an untrusted note stayed in the lists | `the link report a tidy reads > a note marked untrusted is left out of every list` |
## T-0601 — the wiki as read-only objects

| id | file | mutation | failing test |
|---|---|---|---|
| T-0601-M1 | packages/memory/src/wiki.ts | `scanWiki` left folders out of the projection, so the root listed notes only | `the wiki objects > the root lists the top-level folders and notes` |
| T-0601-M2 | packages/memory/src/wiki.ts | a folder row dropped its `parent`, so a folder page listed no subfolders | `the wiki objects > a folder lists its subfolders and notes, and nothing else` |
| T-0601-M3 | packages/memory/src/wiki.ts | the projection stored no backlinks, so a note had no Backlinks section | `the wiki objects > a note shows its content, its backlinks and its untrusted mark` |
| T-0601-M4 | packages/memory/src/wiki.ts | `resolveWikiNoteId` returned another note's key, so a missing note resolved and opened | `the wiki objects > a missing note is not found` |
| T-0601-M5 | packages/memory/src/wiki.ts | `wikiObjectPath` kept `..` and absolute paths instead of refusing them | `the wiki objects > a path outside the wiki is refused` |
| T-0601-M6 | packages/memory/src/wiki.ts | `linksIn` stopped resolving a link to its target note's object id | `the wiki objects > the links in a note resolve to the object ids a client opens` |
| T-0601-M7 | packages/memory/src/wiki.ts | `textPages` returned a large note whole instead of paging it | `the wiki objects > a large note is paged by the section read` |
| T-0601-M8 | packages/memory/src/wiki.ts | a note row ignored its `untrusted` flag, so the mark was not shown | `the wiki objects > a note shows its content, its backlinks and its untrusted mark` |
| T-0601-M9 | packages/memory/src/index.ts | the memory plugin declared an action on a note | `the wiki objects > a note shows its content, its backlinks and its untrusted mark` |
| T-0601-M10 | packages/memory/src/wiki.ts | `syncWikiObjects` scanned the whole home instead of the wiki, so the root lost its notes | `the wiki objects > only the wiki is listed, not a bot's memory` |

## T-0601 follow-up (lead) — the wiki types claim only what the wiki holds

| id | file | mutation | failing test |
|---|---|---|---|
| T-0601-M11 | packages/memory/src/index.ts | `claimIfStored` returned the path without checking the store, so the wiki folder type claimed every bare id that is a valid path (a task id became ambiguous) | `the wiki objects > a bare id the wiki does not hold is not claimed by the wiki types` |

## T-0602 — the wiki projection's reads and a folder named like a note

| id | file | mutation | failing test |
|---|---|---|---|
| T-0602-M1 | packages/memory/src/wiki.ts | `resolveWikiFolderId` still treated a path ending in `.md` as a note, so a folder named `topics.md` was not claimed | `the wiki objects > a folder whose name ends in .md is a folder, not a note` |
| T-0602-M2 | packages/memory/src/wiki.ts | the content section listed every note object again instead of using the links the projection stored | `the wiki objects > a section read does not list the note objects again` |
| T-0602-M3 | packages/memory/src/index.ts | `prepareWiki` opened and refreshed its own search index again, so a list built it | `the wiki objects > a list does not build the search index` |
| T-0602-M4 | packages/memory/src/wiki.ts | a note whose file changed was not projected before its next section, so its old links were returned | `the wiki objects > a note edited after its first read is projected before its next section` |

## T-0603 — a wiki note row's modified time

| id | file | mutation | failing test |
|---|---|---|---|
| T-0603-M1 | packages/memory/src/wiki.ts | `wikiModifiedText` ignored the time zone it was given and always formatted in UTC | `the wiki objects > a note's modified time is formatted in the given zone` |

## T-0604 — memory v1 review follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0604-M1 | packages/memory/src/wiki.ts | `noteRow` put a space before `(untrusted)` even when the note had no time, so a zero-time untrusted note's row began with a space | `the wiki objects > a note row shows its local modified time, and only the mark at zero` |
| T-0604-M2 | packages/memory/src/wiki.ts | `wikiModifiedText` formatted in UTC when no time zone was given, ignoring the process's local zone | `the wiki objects > a note row shows its local modified time, and only the mark at zero` |

## T-0683 — a tidy result covers the whole run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0683-M1 | packages/memory/src/tidy.ts | `tidyCommitSummary` read only the tidy commit's own stat instead of the run from its baseline, so a chat's ordinary memory commit was missing | `a tidy run's summary > covers the chat's own memory commit before an empty tidy commit`, `Run and Skip > a result card reads the chat's own memory commit before an empty tidy commit` |
| T-0726-M1 | packages/memory/skills/memory/SKILL.md | the progress-file sentence was reworded away | `the memory skill is shipped with the package` |

## T-0735 — memory without git

| id | file | mutation | failing test |
|---|---|---|---|
| T-0735-M1 | packages/memory/src/memory.ts | `ensureRepository` skipped the no-program check, so it fell through to `git init` and threw "git is not installed" | `a machine without git > the wiki and the memory are plain folders with no error; git appearing makes the first commit` |
| T-0735-M2 | packages/memory/src/commit.ts | `commitChanges` ignored `tracked` and ran git status on a plain folder, throwing | `a machine without git > the wiki and the memory are plain folders with no error; git appearing makes the first commit` |

## T-0776 — the memory regression set

| id | file | mutation | failing test |
|---|---|---|---|
| T-0776-M1 | packages/memory/src/cases/score.ts | `normalised` kept spaces, so a fact written with other spacing or punctuation no longer matched | `scoring by exact phrases > case, spaces and punctuation do not matter` |
| T-0776-M2 | packages/memory/src/cases/score.ts | `scoreAnswer` ignored the `avoid` phrases | `scoring by exact phrases > repeating the wrong answer fails even when every fact is there` |
| T-0776-M3 | packages/memory/src/cases/score.ts | the messages a window drops were not put in the index, so search could not find them | `running the set > a window that drops a message leaves it to the search of the record` |
| T-0776-M4 | packages/memory/src/cases/score.ts | the memory index was not cut at `MEMORY_INDEX_MAX` | `running the set > the memory index is cut at its limit` |
| T-0776-M5 | packages/memory/src/cases/score.ts | a run appended to the history although `record` was false | `running the set > the history in the home grows by one line per run and holds no case text` |
| T-0776-M6 | packages/memory/src/cases/propose.ts | `proposeCases` did not skip a correction that already had a proposal | `proposing cases from the chat record > extraction only proposes: no case file until approval, and it is not repeated` |
| T-0776-M7 | packages/memory/src/cases/propose.ts | the correction pattern matched `no` without a boundary, so "Nothing else" was a correction | `proposing cases from the chat record > a correction is found with its question and context; thanks is not one` |
| T-0776-M8 | packages/memory/src/cases/score.ts | `programAnswerer` ignored the program's exit code | `running the set > a program that fails stops the run` |
| T-0776-M9 | packages/memory/src/cases/propose.ts | approving an already approved proposal wrote the case again instead of refusing | `proposing cases from the chat record > approving with phrases writes a case the runner can load; the item leaves pending` |

## T-0775 — Search inside one chat

Each row was applied to the source, the two search test files were run, and the source was restored.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0775-M1 | packages/memory/src/search/backend.ts | a search inside a chat kept one hit per document | `the full-text index > a search inside one chat returns every place in it with the message, and reaches no other chat` |
| T-0775-M2 | packages/memory/src/search/backend.ts | the chat named was not the only document searched | `the full-text index > a search inside one chat returns every place in it with the message, and reaches no other chat` |
| T-0775-M3 | packages/memory/src/search/command.ts | the JSON arguments of a bot's tool could name a chat | `the memory search commands > --chat searches inside one chat from any directory; the JSON arguments of a bot's tool cannot` |
| T-0775-M4 | packages/memory/src/search/sources.ts | the line of a later message was attributed to the wrong message | `the full-text index > a search inside one chat returns every place in it with the message, and reaches no other chat` |
