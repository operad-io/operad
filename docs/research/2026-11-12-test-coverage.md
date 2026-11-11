# Test coverage (2026-11-12)

Measured once for `operad-test-slimming.md` decision 1. This is a
research note: it changes no code, no test and no check.

## Run

The suite was run the way `scripts/run-tests.sh` runs it, with coverage
added. The script does not accept a coverage flag, so its two steps were
copied to a temporary script outside the repository:

```sh
# all packages except tui, plus scripts/: same list and parallelism as run-tests.sh
bun test --timeout 30000 --parallel=2 \
  --coverage --coverage-reporter=lcov --coverage-dir=/tmp/operad-coverage-full \
  ./packages/access-match/ ./packages/chat/ ./packages/cli/ ./packages/dev/ \
  ./packages/engine/ ./packages/harness-claude/ ./packages/harness-pi/ \
  ./packages/harness-process/ ./packages/harness-radian/ ./packages/mcp/ \
  ./packages/pool/ ./packages/review-grading/ ./packages/shell/ \
  ./packages/source-cron/ ./scripts/

# tui alone, as run-tests.sh does
bun test --timeout 30000 \
  --coverage --coverage-reporter=lcov --coverage-dir=/tmp/operad-coverage-tui \
  ./packages/tui/
```

Date of the run: 2026-11-11 (local, EST); the note follows the task's
2026-11-12 filename. Bun 1.3.14.

| Step | Time | Tests | Result |
|---|---:|---:|---|
| all packages except tui + scripts | 557 s | 2458 across 180 files | 2453 pass, 3 skip, 2 fail |
| tui | 2 s | 400 across 34 files | 400 pass |
| **total** | **559 s (9 min 19 s)** | **2858 across 214 files** | 2 failures in the non-tui step |

The two failures were `packages/cli/test/closed-pipe.test.ts` (the child wrote
an `ENOTCONN` message instead of keeping stderr empty) and
`packages/dev/test/gate.test.ts` (the flaky-task proposal was not found).
Running those two files alone afterwards passed: 150 pass, 0 fail, 278.61 s.
The same flaky-task expectation also failed in one isolated run of
`packages/dev/test/integrate.test.ts`. No test or source was changed; the
failures are recorded here because they were part of the measured run.

The two Bun coverage reports were merged as LCOV so the totals below cover
both steps. Bun wrote no per-function records in LCOV, so a function's line
coverage here is the hit/total count of LCOV executable lines inside its body
(TypeScript AST), not Bun's function-hit percentage. Functions with no
executable lines are omitted.

## Totals

- Source files in scope (`packages/*/src/**/*.ts`): **203**
- Source lines: **43,031 / 48,758 executable lines covered (88.25%)**
- Files below 50% line coverage: **8**
- Functions below 50% line coverage: **307** (of them 210 have 0% coverage)
- Files never loaded by a test: **4**
- Files loaded but with no executable lines: **2**

By package:

| Package | Lines covered | Coverage |
|---|---:|---:|
| `harness-claude` | 756 / 1,356 | 55.75% |
| `harness-pi` | 718 / 1,275 | 56.31% |
| `mcp` | 862 / 1,485 | 58.05% |
| `source-cron` | 48 / 63 | 76.19% |
| `cli` | 2,220 / 2,841 | 78.14% |
| `harness-process` | 656 / 746 | 87.94% |
| `engine` | 16,266 / 18,073 | 90.00% |
| `chat` | 461 / 510 | 90.39% |
| `dev` | 13,204 / 14,274 | 92.50% |
| `shell` | 323 / 346 | 93.35% |
| `harness-radian` | 591 / 626 | 94.41% |
| `review-grading` | 124 / 131 | 94.66% |
| `tui` | 5,568 / 5,782 | 96.30% |
| `pool` | 653 / 664 | 98.34% |
| `access-match` | 581 / 586 | 99.15% |

## Files below 50% line coverage

| File | Lines covered | Coverage |
|---|---:|---:|
| `packages/cli/src/code-reload.ts` | 46 / 148 | 31.1% |
| `packages/dev/src/editor.ts` | 4 / 33 | 12.1% |
| `packages/dev/src/stdin.ts` | 2 / 12 | 16.7% |
| `packages/harness-claude/src/worker.ts` | 34 / 558 | 6.1% |
| `packages/harness-pi/src/worker.ts` | 31 / 531 | 5.8% |
| `packages/harness-process/src/ask-call.ts` | 82 / 167 | 49.1% |
| `packages/mcp/src/format.ts` | 39 / 144 | 27.1% |
| `packages/mcp/src/server.ts` | 119 / 383 | 31.1% |

## Code no test runs at all

### Files never loaded

- `packages/engine/src/runner/step-worker.ts`
- `packages/engine/src/testing/types.ts`
- `packages/harness-radian/src/hook.ts`
- `packages/mcp/src/stdio.ts`

### Files loaded but with no executable lines

- `packages/engine/src/log/types.ts`
- `packages/engine/src/plugin/harness.ts`

### Uncovered executable lines

Every loaded source file that has at least one executable line is listed; a
file that is absent from this table has every executable line covered. Files
never loaded are listed above.

| File | Uncovered lines |
|---|---|
| `packages/access-match/src/command.ts` | 61-64 |
| `packages/access-match/src/index.ts` | 129 |
| `packages/chat/src/index.ts` | 97 |
| `packages/chat/src/model.ts` | 142, 149-150, 200-201 |
| `packages/chat/src/reply.ts` | 57, 85, 87-95, 97-98, 107-108, 122, 130, 137, 153-155, 158-162, 164, 172, 188, 190-191, 197, 211-213, 225-226, 233 |
| `packages/chat/src/views.ts` | 46-48, 88-89 |
| `packages/cli/src/code-reload.ts` | 31-34, 93-115, 142-165, 199-249 |
| `packages/cli/src/main.ts` | 118, 122-125, 134-139, 147-151, 336-337, 355-369, 459-460, 524, 556-557, 578, 589, 686, 719-731, 758-759, 770-777, 817-818, 828, 834-835, 847, 867-869, 927-928, 937-941, 943, 948-949, 953-954, 969-971, 974, 979, 984-987, 1002-1003, 1010-1016, 1055, 1058, 1072, 1075, 1083, 1086-1090, 1093, 1110-1115, 1180, 1278-1279, 1295, 1298, 1307-1310, 1338, 1341-1343, 1364, 1368, 1403, 1437-1451, 1466-1471, 1522-1530, 1578-1579, 1595-1620, 1626-1774, 1807-1808, 1812, 1814-1815, 1892, 1921, 1925, 1990-1991, 1995-1997, 2001-2002, 2011-2031, 2045, 2069, 2075-2076, 2105-2106, 2197, 2236, 2258-2260, 2281-2282, 2326-2327, 2374-2375, 2378-2379, 2387-2428, 2430, 2475-2484, 2486-2489, 2491, 2509-2521, 2523-2528, 2551-2553, 2555, 2568-2580, 2591-2594, 2601-2604, 2635, 2651 |
| `packages/cli/src/serve-stop.ts` | 31-38, 78-79, 96-102 |
| `packages/dev/src/actions.ts` | 143, 147, 172-173, 240, 335-336, 343-344 |
| `packages/dev/src/announce.ts` | 51-52, 134, 140 |
| `packages/dev/src/chat.ts` | 120, 124, 126, 130, 134-135, 139 |
| `packages/dev/src/check.ts` | 58, 82, 89 |
| `packages/dev/src/commands.ts` | 51, 57, 83, 95, 98, 136, 148, 152-162, 167, 198, 215-221, 231-239, 259, 266, 271-275, 293, 296, 303-307, 338 |
| `packages/dev/src/editor.ts` | 13, 18-45 |
| `packages/dev/src/flaky.ts` | 207, 212, 242-250, 346, 424-425, 503-509, 579-580, 583, 608-610 |
| `packages/dev/src/followups.ts` | 120, 158, 167, 186 |
| `packages/dev/src/gate.ts` | 186-187, 189, 206-207, 342-345, 628, 757, 784-785, 787-788, 813, 848-849, 935, 1037-1039, 1047, 1055-1057, 1060-1062, 1070, 1101-1102, 1152, 1187, 1189, 1195-1196, 1356-1359, 1369-1371, 1494-1497, 1735-1736, 1742-1743, 1773, 1837-1838, 1948-1958, 1968-1979, 2011-2022, 2033-2044, 2628-2646, 2661, 2667-2671, 2683, 2718-2724, 2748-2749, 2772, 2789-2792, 2794, 2806, 2808-2811, 2813-2814, 2828, 2854, 2870-2871, 2876, 2881-2885 |
| `packages/dev/src/integrate.ts` | 174-175, 178-183, 188-191, 199, 205-209, 332-333, 353, 364-365, 385, 403-404, 410-411, 413, 439-440, 452-453, 455, 459-461, 488-489, 507-508, 523-524, 533, 547, 564, 568-569, 588-590, 608, 621, 629, 652-653, 687-688, 713, 731, 733-734, 746-748, 755-763, 765-767, 789-790, 798, 801-804, 807-821, 823-824, 832-833, 835, 843, 848-850, 854, 856, 859, 916, 920-922, 941, 943, 956, 1003, 1023-1024, 1080-1082, 1098, 1101, 1116, 1120-1122, 1131-1132, 1135-1138, 1169, 1171-1177, 1188, 1190, 1206-1207, 1221 |
| `packages/dev/src/integration-queue.ts` | 181, 191, 201-202, 212, 250-252, 269, 280-281, 290-293, 306-307, 313, 317, 390 |
| `packages/dev/src/mainclone.ts` | 22-31, 43-44, 70, 82-85, 99-103 |
| `packages/dev/src/marks.ts` | 41-42 |
| `packages/dev/src/model.ts` | 1107, 1111, 1119-1120, 1124-1127 |
| `packages/dev/src/prepare.ts` | 59-62, 82-86, 106 |
| `packages/dev/src/project-flows.ts` | 50, 139-143 |
| `packages/dev/src/project-settings.ts` | 14 |
| `packages/dev/src/rerun.ts` | 58-65, 90-91, 233-234, 333-335 |
| `packages/dev/src/retry.ts` | 68, 71, 78, 80, 84, 96, 98, 106-107, 116, 121, 123, 127, 132, 134, 179, 183, 199, 210 |
| `packages/dev/src/schedule.ts` | 123-127, 206, 228-229, 238, 445-449, 467-468, 477, 693-694, 757, 759, 907-908 |
| `packages/dev/src/service.ts` | 280, 289-292, 303-317, 340, 366-376, 379, 385-399, 424, 428-429, 432-447, 454, 501, 519, 532-535, 541-544, 608, 757, 765, 1033-1036, 1144-1148, 1265-1271, 1427, 1439-1440, 1539, 1639-1642, 1648-1651, 1742-1763, 1799, 2049, 2089-2098, 2102-2111, 2122-2125, 2150-2151 |
| `packages/dev/src/settings.ts` | 416-419, 439, 443, 451, 455, 520, 527, 531, 535, 549, 559, 587, 591, 609-612, 618, 625, 648, 668, 696, 723-724, 745, 761-762, 826, 848, 852, 891, 928, 973, 981-985, 1055, 1059, 1063, 1079, 1084, 1104, 1108, 1219-1224, 1229, 1277-1286, 1294-1299, 1364-1365 |
| `packages/dev/src/standing.ts` | 70-71, 77-78, 94, 101, 107-108, 120-125, 128-129, 204-205 |
| `packages/dev/src/stdin.ts` | 4-13 |
| `packages/dev/src/steps.ts` | 132-133, 142, 146, 148-149, 154-157, 163, 376-379, 406, 419, 424, 427-429, 432, 435-439, 473, 523-529, 840, 852, 859, 995, 1133-1161, 1167-1195, 1200-1202, 1206, 1231-1259, 1354, 1385-1386, 1398, 1523-1524, 1626-1630 |
| `packages/dev/src/stops.ts` | 77, 100 |
| `packages/dev/src/throughput.ts` | 63, 92, 98, 103-112, 127-133, 151, 184, 233, 252, 280, 291-292, 296, 317 |
| `packages/dev/src/views.ts` | 137-138, 156, 160-162, 164, 191-192, 298, 398, 404, 409, 424-428, 462, 482, 484, 504-505, 523-542, 608-610, 615, 639-642, 654, 657, 672, 755, 785, 862, 864, 872-873, 882-884, 929, 956-957, 989-991 |
| `packages/engine/src/config/config.ts` | 200-203, 221-225, 228-230, 236-237, 241, 256, 261, 402, 416-417, 461, 484-486, 541, 543, 546-547, 560-562, 581, 602-613, 615-616, 619-621, 626, 630, 633, 635 |
| `packages/engine/src/flow/load.ts` | 24, 30-31, 41-42 |
| `packages/engine/src/flow/validate.ts` | 38-39, 67, 71, 74, 77, 80, 84, 87, 93, 100, 102-104, 113, 117, 122-123, 137, 142, 150, 157, 162-163, 168, 172, 174, 178, 189, 193, 197, 200, 203, 211, 213, 218, 222, 232, 236, 239, 259, 271, 291 |
| `packages/engine/src/http/address.ts` | 30-33, 42, 44-47, 67, 69, 111 |
| `packages/engine/src/http/server.ts` | 110-111, 133-134, 138-139, 262, 343, 356-358, 364-365, 369, 377-378, 382-383, 389-390, 395, 409, 412, 414, 433, 435, 443, 454, 458-462, 480, 490, 522, 533, 537, 570, 580-581, 610, 613, 615, 643, 648-649, 674, 689, 693-698, 707-711, 729, 735-736, 740-741, 743, 753-754, 759, 770 |
| `packages/engine/src/kernel/decide.ts` | 47, 51, 122-123, 125-127, 144, 148, 246, 250-251, 267-268, 276-277, 279, 290, 296, 304-307, 334-335, 404, 407-409, 435-436, 440-441, 470-471, 486, 502, 515, 535, 567, 576, 579-580, 601, 611, 627, 642-643, 647, 653, 658, 672, 679 |
| `packages/engine/src/kernel/state.ts` | 53-56, 198 |
| `packages/engine/src/log/errors.ts` | 11 |
| `packages/engine/src/log/facts.ts` | 11, 17, 23, 29, 32, 36, 39 |
| `packages/engine/src/log/json-value.ts` | 21, 34, 49, 56 |
| `packages/engine/src/log/jsonl.ts` | 124, 417, 461, 580-581, 594-595, 600-601, 619, 624, 641-642, 651-652, 657, 667-668, 676-677, 680, 692, 694-695, 706-707, 713-714, 725-726, 757-758, 814-815, 1009-1011, 1020-1021, 1028, 1034, 1041, 1246, 1254, 1269, 1326, 1334 |
| `packages/engine/src/log/secret.ts` | 23 |
| `packages/engine/src/log/sqlite.ts` | 240-252, 298-299, 308, 315, 326-329, 341, 350, 408-409, 428, 434, 457-458, 473-474, 493, 497, 502-503, 513, 525, 550, 559-560, 567-572, 576-577, 584-585, 596, 608, 631-632, 637, 643-645, 651, 659-660, 666, 670-671, 679-680, 686, 690-691, 723-724, 743, 746-747, 766-767, 807, 829, 851-852, 864-865, 869, 903-904, 917, 946, 952-953, 961-962, 974 |
| `packages/engine/src/loop/code-watch.ts` | 95, 103, 111, 119, 136-137, 182, 217-218, 221-222, 238-240, 248, 256-257, 281-288, 305, 309-310, 312, 378, 421-422, 426-427 |
| `packages/engine/src/loop/serve.ts` | 75-76, 95, 99, 101-102, 116, 118, 120, 141-145, 147-149, 163, 178-179, 182-183, 197-198, 200, 205, 207, 212-214, 230, 236-239, 260-261, 263, 276, 292-294, 296, 298, 310-313, 317, 322, 324-325, 330, 339, 342-343, 349-352, 354, 363-365, 369, 393-394, 401, 424, 426-429, 435, 437-438, 446, 448, 457, 465-466 |
| `packages/engine/src/markdown.ts` | 403-405, 417-421 |
| `packages/engine/src/notify/notify.ts` | 121-122, 132-133, 165-167, 171-172, 186, 193-194, 197-198, 213-214, 225, 249, 252 |
| `packages/engine/src/platform/file-lock.ts` | 167, 173, 220-221, 232, 293, 296, 301, 307, 310, 321, 343-344, 350 |
| `packages/engine/src/platform/process-group.ts` | 142, 154-155, 193-194, 222-224, 272-273, 359, 388-389, 401-402, 408-409, 411-412, 441, 474-475, 487, 495-496, 501, 511, 527, 529, 538, 552-553, 577, 580-583, 594, 598, 602-603, 605-608, 611-616, 622, 625 |
| `packages/engine/src/platform/process-watch.ts` | 82, 84, 87, 97, 109-110, 115, 127, 145, 150 |
| `packages/engine/src/platform/sqlite-open.ts` | 36, 61-65 |
| `packages/engine/src/platform/step-reap.ts` | 151, 159-191, 233, 347-348, 404, 411, 466, 524, 528, 576-577, 614-616, 643-648, 659 |
| `packages/engine/src/platform/watch.ts` | 153, 163-164 |
| `packages/engine/src/plugin/action-schema.ts` | 55, 61, 71, 76, 81, 103-104, 111, 127, 140-141, 146, 156, 188, 256, 261-262, 264-265, 328 |
| `packages/engine/src/plugin/errors.ts` | 53-56 |
| `packages/engine/src/plugin/file-store.ts` | 50, 111, 114, 117-119, 128-129, 276, 320, 324, 334, 361, 449-451, 470-471, 473-474, 519, 521 |
| `packages/engine/src/plugin/home.ts` | 12 |
| `packages/engine/src/plugin/keys.ts` | 33-34, 41-44, 48, 54-56, 59-61 |
| `packages/engine/src/plugin/load.ts` | 107-108, 167-170 |
| `packages/engine/src/plugin/paging.ts` | 44, 52, 77, 91-93, 123, 133 |
| `packages/engine/src/plugin/registry.ts` | 474-475, 527, 539, 599-601, 637, 655, 727-729, 758, 774-776, 783-789, 809, 819, 828-829, 837, 887-888, 918, 922, 953-954, 958-959, 972, 975, 977, 985, 996, 998, 1105-1108, 1137, 1150, 1163, 1165-1166, 1184-1186, 1193, 1206, 1337-1339, 1397, 1400, 1411, 1417, 1419-1424, 1430-1437, 1439-1444, 1446-1449, 1471-1472, 1492, 1650 |
| `packages/engine/src/plugin/secrets.ts` | 62-63, 70-71 |
| `packages/engine/src/plugin/semver.ts` | 45-47, 54, 61-64, 69-74, 82, 86, 90, 105-106 |
| `packages/engine/src/plugin/settings.ts` | 27, 30 |
| `packages/engine/src/plugin/sqlite-store.ts` | 208-213, 259-263, 273, 293, 326, 332-335, 399-401, 486-489, 497-499 |
| `packages/engine/src/plugin/store.ts` | 205, 213-231 |
| `packages/engine/src/plugin/validate.ts` | 117-121, 143, 149, 152, 155, 158, 161, 164, 185, 188, 196, 213, 215, 228, 233, 236, 254-255, 269, 302, 307, 330, 334, 338, 341, 352-354, 357-359, 406, 411-413, 416, 426, 431, 436, 439-441, 449-451, 461, 486, 490, 493, 496, 503-505, 515, 517, 554, 560-562, 567, 570, 589, 617, 624, 626, 629, 642, 665, 683, 693, 766, 787, 812-813, 826-827, 921, 925-927 |
| `packages/engine/src/runner/answer.ts` | 83, 94-95, 127, 129-130, 132, 152 |
| `packages/engine/src/runner/ask.ts` | 34-35, 90-92, 132, 178, 192, 273, 289-290, 301, 324, 378, 390-391, 393-394, 406, 423, 473 |
| `packages/engine/src/runner/cancel.ts` | 29 |
| `packages/engine/src/runner/grants.ts` | 27-28, 78-79 |
| `packages/engine/src/runner/limits.ts` | 184-191, 204, 221-227, 236-238, 247-274, 276-281, 322, 328, 330-331, 340-342, 350-352, 369, 383 |
| `packages/engine/src/runner/lock.ts` | 58-61, 79-80, 97, 110, 119-121, 127, 129-130 |
| `packages/engine/src/runner/runner.ts` | 265-266, 271-272, 348-354, 361-363, 376-377, 383, 405, 410, 424-430, 439, 442, 444-446, 455, 458, 474, 484, 486-488, 515-516, 540-541, 544-545, 561, 577, 582, 584-586, 640-645, 658-659, 686-696, 712, 743-747, 749-751, 764-765, 792-793, 815, 831-833, 841-842, 847-849, 859-860, 872, 877, 880, 907, 925-930, 943-944, 969-971, 978-980, 994-996, 1013-1015, 1028, 1055-1057, 1071, 1079, 1084, 1097-1098, 1100 |
| `packages/engine/src/runner/service.ts` | 133-137, 139-140, 142 |
| `packages/engine/src/store-copy/copy.ts` | 128, 136-137, 140, 167-170, 183, 193, 211, 213-215, 225, 237, 243, 256, 277-278, 299-301, 310, 322-323, 328, 337, 353, 356, 385, 396, 426-428, 438, 440-441, 453, 455, 463-471, 503-504, 508-512, 522-523, 525-526, 542, 550, 569, 589, 617 |
| `packages/engine/src/testing/clock.ts` | 21, 27-28, 46, 49, 55, 60-63, 65 |
| `packages/engine/src/testing/world.ts` | 100, 133-136, 191, 221-222, 283, 329 |
| `packages/engine/src/trigger/cron.ts` | 32, 36, 45, 50, 54, 61-68, 73-74, 77, 79, 102-105, 112, 121-126, 145, 150-152, 175, 180-191 |
| `packages/engine/src/trigger/kernel.ts` | 148-157, 198, 200-206, 215-217, 233, 246, 266, 295-297, 313, 322-329, 347-350, 363, 372-377, 384-386, 391-392, 401, 409, 417, 425, 438, 456-458, 475, 534, 536-539, 563-569, 582, 588, 602-604, 620, 640-642, 658-659, 662, 681, 694-696, 715-719, 733-741, 743-744, 759, 762-763, 796, 798-800, 827-852, 869-870, 877-879, 888-890, 909, 912-914, 932-956, 966-968, 984-985, 988-989, 995-997, 1048, 1050-1057, 1073-1075, 1078, 1100, 1108, 1114, 1143-1146, 1177-1179 |
| `packages/engine/src/trigger/rules.ts` | 38, 46, 67, 81, 83-84, 89-91, 93-95, 97, 100-107, 111, 123-124, 127-128, 134, 138-139, 152, 155, 161, 170, 172, 189, 236, 252, 273, 275-276, 280-282, 284 |
| `packages/engine/src/trigger/store.ts` | 169, 178, 203-217 |
| `packages/engine/src/views/history.ts` | 59, 77, 85, 120, 131, 139, 147, 157, 165, 185, 193-211, 213, 221, 229-237, 239, 246, 255, 258-265, 267, 278, 289, 300, 308-309, 324, 446, 452, 472, 488, 520, 529-530, 541, 598, 600 |
| `packages/engine/src/views/presentation.ts` | 288-290, 334-335, 343-344, 383-396, 479, 693-694, 714, 743, 750, 752-753, 777, 785, 923-928, 1146-1149, 1858, 1972-1978, 1981-2003, 2005-2007, 2031, 2035-2036, 2049-2051, 2062 |
| `packages/engine/src/views/running.ts` | 136 |
| `packages/engine/src/views/settings.ts` | 107, 133, 135, 164, 183, 191, 349, 362, 369, 406, 408 |
| `packages/harness-claude/src/access.ts` | 152 |
| `packages/harness-claude/src/claude-install.ts` | 104, 106, 128, 143, 169-174 |
| `packages/harness-claude/src/index.ts` | 77, 159, 170, 178, 186, 211, 225, 247, 249, 327, 338, 353-356, 358, 362-363, 375, 377-380, 384, 396-399, 467, 479, 502, 504, 529, 532, 550, 555, 562, 568, 583, 586-589, 592, 594, 609-610, 613, 616 |
| `packages/harness-claude/src/protocol.ts` | 191-193, 199, 205, 219, 229, 232, 234, 243, 248-249, 251, 254, 256, 265 |
| `packages/harness-claude/src/worker.ts` | 110-120, 124, 128-135, 139, 147-491, 503-535, 541-665 |
| `packages/harness-pi/src/index.ts` | 170, 181, 189, 197, 266, 353, 368-371, 392-395, 406-409, 649, 652, 655 |
| `packages/harness-pi/src/pi-install.ts` | 83-87, 90, 99, 103-104, 128, 134, 151, 153, 170, 172-173, 191, 194, 197, 204, 207 |
| `packages/harness-pi/src/protocol.ts` | 147, 153, 157, 162, 165, 173, 175, 181, 185, 193, 198, 201, 203, 206, 212 |
| `packages/harness-pi/src/worker.ts` | 89-97, 101, 106-109, 121-158, 163, 171-453, 466-498, 504-634 |
| `packages/harness-process/src/ask-call.ts` | 24-25, 27-41, 44-46, 52, 54, 62-67, 74-76, 79-81, 86-88, 93-94, 109-115, 118-151, 154-155, 159, 162-163 |
| `packages/harness-process/src/limit.ts` | 64, 69-71, 87 |
| `packages/harness-radian/src/index.ts` | 102, 128, 236, 243, 250, 258, 387, 389 |
| `packages/harness-radian/src/refusal.ts` | 38-50, 54-59, 76, 79-85 |
| `packages/mcp/src/arguments.ts` | 27-29, 32-59, 72, 78, 82-84 |
| `packages/mcp/src/channel.ts` | 288-289, 300, 319-321, 332-333, 339-341, 350-351, 361, 380-382, 392-395, 450, 453-455, 461-462, 465-466, 506-507, 512, 520-522, 526-527, 532, 541, 549, 563, 572-573, 582, 588, 594-595, 609, 619, 625 |
| `packages/mcp/src/format.ts` | 18-21, 25, 34-40, 42, 44, 49-66, 71-115, 120-122, 127-129, 134, 138-151, 156-162 |
| `packages/mcp/src/policy.ts` | 40, 54-55, 66-75, 80-91 |
| `packages/mcp/src/server.ts` | 57-58, 62, 132-134, 139, 143-147, 151, 155, 159-162, 168-176, 181-184, 207, 209-215, 217-218, 220, 229, 231, 239, 241, 261-264, 272-307, 312-344, 349-407, 412-432, 441-501, 529, 546-547, 551 |
| `packages/mcp/src/tools.ts` | 299-302, 321, 336-473 |
| `packages/pool/src/index.ts` | 78, 193, 240 |
| `packages/pool/src/places.ts` | 76, 78, 111, 127 |
| `packages/pool/src/shared.ts` | 228-229, 238, 240 |
| `packages/review-grading/src/index.ts` | 51, 58, 75, 112, 117, 156, 173 |
| `packages/shell/src/index.ts` | 23, 31, 40, 52, 64, 69, 120-126, 188, 203, 229-232, 351, 359, 385, 394 |
| `packages/source-cron/src/index.ts` | 70-81, 90-92 |
| `packages/tui/src/actions.ts` | 840 |
| `packages/tui/src/app.ts` | 388-394, 456-457, 577, 598-601, 674-679, 718-719, 728, 768-771, 773, 791-796, 923-924, 933-934, 970-971, 979-980, 1026, 1033, 1042, 1050-1054, 1139, 1191-1199, 1220-1222, 1291, 1294-1295, 1318-1319, 1329-1330 |
| `packages/tui/src/args.ts` | 71-81, 95-98, 101-105, 128-132 |
| `packages/tui/src/autostart.ts` | 175-176, 252 |
| `packages/tui/src/client.ts` | 389-402 |
| `packages/tui/src/discover.ts` | 69, 80 |
| `packages/tui/src/events.ts` | 156, 187-188 |
| `packages/tui/src/layout.ts` | 37-39, 46, 256-257 |
| `packages/tui/src/state.ts` | 454-456, 983, 1230-1231, 1243-1244, 1269, 1306-1307, 1313-1324, 1518, 1676-1677, 1704, 1789-1790, 1852, 1863-1864, 1868, 2040-2041, 2048-2049, 2204-2205, 2460-2461, 2563-2565, 2659, 2667, 2734-2735 |
| `packages/tui/src/theme.ts` | 150, 153, 254-255, 259, 264, 274, 426 |
| `packages/tui/src/view/index.ts` | 330, 544, 705-707, 713-714, 803, 805-807, 809-810, 839-847, 849-856, 944-946, 960 |

## Functions below 50% line coverage

| File | Function | Lines | Hit / lines | Coverage |
|---|---|---|---:|---:|
| `packages/cli/src/code-reload.ts` | `settingsRoots` | 31-36 | 1 / 5 | 20.0% |
| `packages/cli/src/code-reload.ts` | `<anonymous@32>` | 32-35 | 1 / 4 | 25.0% |
| `packages/cli/src/code-reload.ts` | `probeLoad` | 93-117 | 1 / 24 | 4.2% |
| `packages/cli/src/code-reload.ts` | `<anonymous@110>` | 110-110 | 0 / 1 | 0.0% |
| `packages/cli/src/code-reload.ts` | `<anonymous@111>` | 111-111 | 0 / 1 | 0.0% |
| `packages/cli/src/code-reload.ts` | `codeChecker` | 141-168 | 2 / 26 | 7.7% |
| `packages/cli/src/code-reload.ts` | `<anonymous@142>` | 142-167 | 1 / 25 | 4.0% |
| `packages/cli/src/code-reload.ts` | `superviseServe` | 201-252 | 0 / 49 | 0.0% |
| `packages/cli/src/code-reload.ts` | `<anonymous@204>` | 204-207 | 0 / 4 | 0.0% |
| `packages/cli/src/code-reload.ts` | `pass` | 204-207 | 0 / 4 | 0.0% |
| `packages/cli/src/code-reload.ts` | `attach` | 210-213 | 0 / 4 | 0.0% |
| `packages/cli/src/code-reload.ts` | `detach` | 214-217 | 0 / 4 | 0.0% |
| `packages/cli/src/main.ts` | `outputWasClosed` | 118-120 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `isClosedPipe` | 122-128 | 0 / 4 | 0.0% |
| `packages/cli/src/main.ts` | `writeStream` | 134-142 | 1 / 7 | 14.3% |
| `packages/cli/src/main.ts` | `<anonymous@147>` | 147-153 | 1 / 6 | 16.7% |
| `packages/cli/src/main.ts` | `onLog` | 336-339 | 1 / 3 | 33.3% |
| `packages/cli/src/main.ts` | `onEvent` | 355-371 | 1 / 16 | 6.2% |
| `packages/cli/src/main.ts` | `onLog` | 360-360 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 368-368 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `showRecent` | 723-733 | 0 / 9 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@773>` | 773-773 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@1088>` | 1088-1088 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `readLine` | 1108-1117 | 2 / 8 | 25.0% |
| `packages/cli/src/main.ts` | `<anonymous@1467>` | 1467-1467 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `commandRunning` | 1517-1532 | 6 / 15 | 40.0% |
| `packages/cli/src/main.ts` | `spawnChild` | 1598-1624 | 0 / 23 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@1599>` | 1599-1623 | 0 / 22 | 0.0% |
| `packages/cli/src/main.ts` | `commandServe` | 1633-1776 | 0 / 142 | 0.0% |
| `packages/cli/src/main.ts` | `stop` | 1637-1639 | 0 / 3 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 1653-1656 | 0 / 4 | 0.0% |
| `packages/cli/src/main.ts` | `titleOf` | 1672-1672 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `answeredAutomatically` | 1673-1673 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 1674-1674 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `startHttp` | 1683-1692 | 0 / 10 | 0.0% |
| `packages/cli/src/main.ts` | `onListen` | 1690-1690 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 1691-1691 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `now` | 1700-1700 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@1701>` | 1701-1701 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `wait` | 1701-1701 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onProblem` | 1715-1715 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onChange` | 1723-1731 | 0 / 9 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@1736>` | 1736-1736 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 1746-1746 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `clock` | 1749-1749 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onPass` | 1751-1755 | 0 / 5 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@1752>` | 1752-1754 | 0 / 3 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 1807-1810 | 1 / 3 | 33.3% |
| `packages/cli/src/main.ts` | `<anonymous@1995>` | 1995-1995 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `readSecretValue` | 2006-2033 | 5 / 26 | 19.2% |
| `packages/cli/src/main.ts` | `<anonymous@2025>` | 2025-2025 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@2326>` | 2326-2329 | 1 / 3 | 33.3% |
| `packages/cli/src/main.ts` | `<anonymous@2405>` | 2405-2405 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@2406>` | 2406-2406 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `write` | 2419-2419 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `error` | 2420-2420 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `error` | 2475-2475 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `onLog` | 2481-2481 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `write` | 2527-2527 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `runOnce` | 2562-2584 | 6 / 19 | 31.6% |
| `packages/cli/src/main.ts` | `log` | 2570-2570 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `exit` | 2571-2571 | 0 / 1 | 0.0% |
| `packages/cli/src/main.ts` | `startReplacement` | 2572-2581 | 0 / 9 | 0.0% |
| `packages/cli/src/main.ts` | `<anonymous@2602>` | 2602-2602 | 0 / 1 | 0.0% |
| `packages/cli/src/serve-stop.ts` | `processCommand` | 31-40 | 1 / 9 | 11.1% |
| `packages/dev/src/commands.ts` | `<anonymous@153>` | 153-153 | 0 / 1 | 0.0% |
| `packages/dev/src/commands.ts` | `editable` | 215-223 | 0 / 7 | 0.0% |
| `packages/dev/src/commands.ts` | `newBrief` | 231-241 | 0 / 9 | 0.0% |
| `packages/dev/src/editor.ts` | `editText` | 21-48 | 0 / 25 | 0.0% |
| `packages/dev/src/gate.ts` | `waitFor` | 2628-2648 | 1 / 20 | 5.0% |
| `packages/dev/src/gate.ts` | `<anonymous@2629>` | 2629-2647 | 1 / 19 | 5.3% |
| `packages/dev/src/gate.ts` | `cleanup` | 2634-2637 | 0 / 4 | 0.0% |
| `packages/dev/src/gate.ts` | `<anonymous@2638>` | 2638-2641 | 0 / 4 | 0.0% |
| `packages/dev/src/gate.ts` | `onAbort` | 2642-2645 | 0 / 4 | 0.0% |
| `packages/dev/src/gate.ts` | `gateSource` | 2714-2727 | 6 / 13 | 46.2% |
| `packages/dev/src/gate.ts` | `verifiedCommitOf` | 2870-2873 | 1 / 3 | 33.3% |
| `packages/dev/src/gate.ts` | `taskGatePath` | 2881-2887 | 0 / 5 | 0.0% |
| `packages/dev/src/mainclone.ts` | `runCommand` | 22-33 | 1 / 11 | 9.1% |
| `packages/dev/src/mainclone.ts` | `lastLine` | 43-46 | 1 / 3 | 33.3% |
| `packages/dev/src/mainclone.ts` | `<anonymous@44>` | 44-44 | 0 / 1 | 0.0% |
| `packages/dev/src/model.ts` | `higherPriority` | 1119-1122 | 1 / 3 | 33.3% |
| `packages/dev/src/model.ts` | `lowerPriority` | 1124-1129 | 1 / 5 | 20.0% |
| `packages/dev/src/service.ts` | `unknownRepository` | 306-319 | 0 / 12 | 0.0% |
| `packages/dev/src/service.ts` | `resolveObjectRepository` | 363-401 | 11 / 38 | 28.9% |
| `packages/dev/src/service.ts` | `<anonymous@396>` | 396-396 | 0 / 1 | 0.0% |
| `packages/dev/src/service.ts` | `resolveDevKey` | 418-449 | 11 / 30 | 36.7% |
| `packages/dev/src/service.ts` | `moveTaskPhase` | 1271-1273 | 0 / 1 | 0.0% |
| `packages/dev/src/service.ts` | `rejectTask` | 1746-1765 | 1 / 19 | 5.3% |
| `packages/dev/src/service.ts` | `<anonymous@1754>` | 1754-1764 | 1 / 11 | 9.1% |
| `packages/dev/src/service.ts` | `raisePriority` | 2092-2100 | 1 / 8 | 12.5% |
| `packages/dev/src/service.ts` | `lowerPriorityOf` | 2105-2113 | 1 / 8 | 12.5% |
| `packages/dev/src/service.ts` | `taskBelongsTo` | 2150-2153 | 0 / 2 | 0.0% |
| `packages/dev/src/settings.ts` | `autoMode` | 416-421 | 0 / 4 | 0.0% |
| `packages/dev/src/settings.ts` | `flakyPlanId` | 609-614 | 0 / 4 | 0.0% |
| `packages/dev/src/settings.ts` | `readDefaults` | 1294-1301 | 1 / 7 | 14.3% |
| `packages/dev/src/stdin.ts` | `readStdinText` | 2-14 | 2 / 12 | 16.7% |
| `packages/dev/src/steps.ts` | `guardTask` | 526-531 | 1 / 5 | 20.0% |
| `packages/dev/src/steps.ts` | `<anonymous@995>` | 995-995 | 0 / 1 | 0.0% |
| `packages/dev/src/steps.ts` | `failBefore` | 1167-1197 | 1 / 30 | 3.3% |
| `packages/dev/src/steps.ts` | `<anonymous@1386>` | 1386-1386 | 0 / 1 | 0.0% |
| `packages/dev/src/views.ts` | `workerLogPath` | 518-543 | 5 / 25 | 20.0% |
| `packages/dev/src/views.ts` | `<anonymous@532>` | 532-532 | 0 / 1 | 0.0% |
| `packages/engine/src/http/address.ts` | `ipv4Group` | 30-35 | 0 / 4 | 0.0% |
| `packages/engine/src/http/server.ts` | `error` | 740-743 | 1 / 4 | 25.0% |
| `packages/engine/src/log/sqlite.ts` | `migrateInputs` | 238-254 | 3 / 16 | 18.8% |
| `packages/engine/src/loop/code-watch.ts` | `tick` | 309-312 | 1 / 4 | 25.0% |
| `packages/engine/src/platform/step-reap.ts` | `listWithProc` | 159-193 | 1 / 34 | 2.9% |
| `packages/engine/src/plugin/action-schema.ts` | `schemaError` | 55-57 | 0 / 1 | 0.0% |
| `packages/engine/src/plugin/action-schema.ts` | `<anonymous@262>` | 262-264 | 0 / 2 | 0.0% |
| `packages/engine/src/plugin/paging.ts` | `<anonymous@52>` | 52-52 | 0 / 1 | 0.0% |
| `packages/engine/src/plugin/registry.ts` | `PluginRegistry.sourcePlugins` | 1433-1439 | 1 / 7 | 14.3% |
| `packages/engine/src/plugin/registry.ts` | `<anonymous@1434>` | 1435-1437 | 0 / 3 | 0.0% |
| `packages/engine/src/plugin/semver.ts` | `tildeUpper` | 45-49 | 0 / 3 | 0.0% |
| `packages/engine/src/plugin/settings.ts` | `<anonymous@27>` | 27-27 | 0 / 1 | 0.0% |
| `packages/engine/src/plugin/sqlite-store.ts` | `SqlitePluginStore.maxSequence` | 486-491 | 1 / 5 | 20.0% |
| `packages/engine/src/plugin/store.ts` | `MemoryPluginStore.subscribeFacts` | 217-234 | 1 / 16 | 6.2% |
| `packages/engine/src/plugin/validate.ts` | `parseObjectKeyMaybe` | 117-123 | 0 / 5 | 0.0% |
| `packages/engine/src/runner/ask.ts` | `realAskTimer` | 34-37 | 1 / 3 | 33.3% |
| `packages/engine/src/runner/limits.ts` | `StepLimits.resetNested` | 255-276 | 1 / 22 | 4.5% |
| `packages/engine/src/runner/runner.ts` | `Runner.startInputFor` | 743-749 | 1 / 7 | 14.3% |
| `packages/engine/src/runner/runner.ts` | `<anonymous@925>` | 925-932 | 2 / 8 | 25.0% |
| `packages/engine/src/runner/step-worker.ts` | `openWorkerStore` | 81-90 | 0 / 10 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `main` | 92-288 | 0 / 185 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `report` | 111-111 | 0 / 1 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `acquire` | 112-112 | 0 / 1 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `hold` | 117-151 | 0 / 35 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@123>` | 123-133 | 0 / 11 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `cancel` | 134-134 | 0 / 1 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@137>` | 137-144 | 0 / 8 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@139>` | 140-143 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@140>` | 140-143 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@145>` | 145-148 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `useGrant` | 167-176 | 0 / 10 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@172>` | 172-175 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `ask` | 177-209 | 0 / 33 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@182>` | 182-208 | 0 / 27 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `cancel` | 183-183 | 0 / 1 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `resolve` | 185-188 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `reject` | 189-192 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@212>` | 212-249 | 0 / 38 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `emit` | 251-260 | 0 / 10 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@256>` | 256-259 | 0 / 4 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@271>` | 271-273 | 0 / 3 | 0.0% |
| `packages/engine/src/runner/step-worker.ts` | `<anonymous@291>` | 291-297 | 0 / 7 | 0.0% |
| `packages/engine/src/testing/clock.ts` | `sleep` | 61-65 | 1 / 5 | 20.0% |
| `packages/engine/src/testing/clock.ts` | `<anonymous@62>` | 62-64 | 1 / 3 | 33.3% |
| `packages/engine/src/trigger/cron.ts` | `expandNames` | 101-107 | 2 / 6 | 33.3% |
| `packages/engine/src/trigger/cron.ts` | `<anonymous@102>` | 102-106 | 1 / 5 | 20.0% |
| `packages/engine/src/trigger/cron.ts` | `cronMinutesBetween` | 184-193 | 0 / 8 | 0.0% |
| `packages/engine/src/trigger/kernel.ts` | `start` | 150-159 | 1 / 9 | 11.1% |
| `packages/engine/src/trigger/kernel.ts` | `Kernel.triggerForRun` | 198-200 | 1 / 3 | 33.3% |
| `packages/engine/src/trigger/kernel.ts` | `Kernel.startSources` | 831-840 | 0 / 10 | 0.0% |
| `packages/engine/src/trigger/kernel.ts` | `Kernel.emit` | 835-837 | 0 / 3 | 0.0% |
| `packages/engine/src/trigger/kernel.ts` | `Kernel.stopSources` | 843-854 | 1 / 11 | 9.1% |
| `packages/engine/src/trigger/kernel.ts` | `Kernel.recordSkip` | 940-959 | 1 / 18 | 5.6% |
| `packages/engine/src/trigger/store.ts` | `TriggerStore.readRunTrigger` | 203-220 | 1 / 16 | 6.2% |
| `packages/engine/src/views/history.ts` | `<anonymous@236>` | 236-236 | 0 / 1 | 0.0% |
| `packages/engine/src/views/presentation.ts` | `editDistance` | 383-398 | 1 / 15 | 6.7% |
| `packages/engine/src/views/presentation.ts` | `<anonymous@384>` | 384-384 | 0 / 1 | 0.0% |
| `packages/engine/src/views/presentation.ts` | `Views.facts` | 927-930 | 1 / 3 | 33.3% |
| `packages/engine/src/views/presentation.ts` | `Views.recent` | 1985-2005 | 1 / 21 | 4.8% |
| `packages/engine/src/views/presentation.ts` | `<anonymous@2003>` | 2003-2003 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `failure` | 110-122 | 0 / 11 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `finite` | 124-126 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `usageOf` | 128-137 | 0 / 8 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `read` | 130-130 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `runWorker` | 152-493 | 1 / 341 | 0.3% |
| `packages/harness-claude/src/worker.ts` | `onCancel` | 165-168 | 0 / 4 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `deniedByProfile` | 182-193 | 0 / 12 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `startCall` | 194-209 | 0 / 16 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `endCall` | 210-223 | 0 / 14 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@226>` | 226-235 | 0 / 10 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `toolHook` | 226-235 | 0 / 10 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `canUseTool` | 240-273 | 0 / 34 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@251>` | 251-258 | 0 / 8 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@253>` | 253-253 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@263>` | 263-266 | 0 / 4 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@265>` | 265-265 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `stderr` | 308-312 | 0 / 5 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@332>` | 332-344 | 0 / 13 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@333>` | 333-340 | 0 / 8 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@341>` | 341-343 | 0 / 3 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@346>` | 346-346 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@347>` | 347-347 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@378>` | 378-378 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@476>` | 476-476 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `StdinLines.#more` | 505-515 | 0 / 11 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `StdinLines.next` | 518-533 | 0 / 16 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `main` | 541-667 | 1 / 126 | 0.8% |
| `packages/harness-claude/src/worker.ts` | `write` | 542-544 | 0 / 3 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@546>` | 546-548 | 0 / 3 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `flush` | 546-548 | 0 / 3 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@547>` | 547-547 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `line` | 558-558 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `onMessage` | 559-562 | 0 / 4 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `log` | 563-563 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@565>` | 565-574 | 0 / 10 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `useGrant` | 565-574 | 0 / 10 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@576>` | 576-589 | 0 / 14 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `ask` | 576-589 | 0 / 14 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@583>` | 583-587 | 0 / 5 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@592>` | 592-594 | 0 / 3 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@597>` | 597-597 | 0 / 1 | 0.0% |
| `packages/harness-claude/src/worker.ts` | `<anonymous@615>` | 615-657 | 0 / 43 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `textOf` | 89-99 | 0 / 9 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@93>` | 94-96 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `finite` | 101-103 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `priceOf` | 106-111 | 0 / 4 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `Tally.add` | 121-150 | 0 / 30 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `Tally.cost` | 156-160 | 1 / 4 | 25.0% |
| `packages/harness-pi/src/worker.ts` | `runWorker` | 176-456 | 1 / 279 | 0.4% |
| `packages/harness-pi/src/worker.ts` | `operadExtension` | 228-284 | 0 / 57 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@229>` | 229-283 | 0 / 55 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@257>` | 257-257 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@271>` | 271-274 | 0 / 4 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@273>` | 273-273 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `onLog` | 309-309 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@316>` | 316-328 | 0 / 13 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `execute` | 322-327 | 0 / 6 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@324>` | 324-324 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `settle` | 346-346 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@347>` | 347-349 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@350>` | 350-391 | 0 / 42 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `result` | 393-400 | 0 / 8 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@404>` | 404-409 | 0 / 6 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@406>` | 406-408 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `onCancel` | 412-415 | 0 / 4 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `StdinLines.#more` | 468-478 | 0 / 11 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `StdinLines.next` | 481-496 | 0 / 16 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `main` | 504-636 | 1 / 132 | 0.8% |
| `packages/harness-pi/src/worker.ts` | `write` | 505-507 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@509>` | 509-511 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `flush` | 509-511 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@510>` | 510-510 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `line` | 521-521 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `onMessage` | 522-525 | 0 / 4 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `log` | 526-526 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@528>` | 528-537 | 0 / 10 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `useGrant` | 528-537 | 0 / 10 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@539>` | 539-552 | 0 / 14 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `ask` | 539-552 | 0 / 14 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@546>` | 546-550 | 0 / 5 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@555>` | 555-557 | 0 / 3 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@566>` | 566-566 | 0 / 1 | 0.0% |
| `packages/harness-pi/src/worker.ts` | `<anonymous@584>` | 584-626 | 0 / 43 | 0.0% |
| `packages/harness-radian/src/refusal.ts` | `patchPaths` | 38-52 | 0 / 13 | 0.0% |
| `packages/harness-radian/src/refusal.ts` | `describe` | 54-61 | 1 / 7 | 14.3% |
| `packages/mcp/src/arguments.ts` | `checkOne` | 21-61 | 9 / 40 | 22.5% |
| `packages/mcp/src/format.ts` | `flags` | 18-23 | 0 / 4 | 0.0% |
| `packages/mcp/src/format.ts` | `listMarkdown` | 30-47 | 8 / 17 | 47.1% |
| `packages/mcp/src/format.ts` | `actionMarkdown` | 49-68 | 1 / 19 | 5.3% |
| `packages/mcp/src/format.ts` | `showMarkdown` | 71-117 | 1 / 46 | 2.2% |
| `packages/mcp/src/format.ts` | `valueText` | 120-124 | 1 / 4 | 25.0% |
| `packages/mcp/src/format.ts` | `sectionMarkdown` | 127-131 | 1 / 4 | 25.0% |
| `packages/mcp/src/format.ts` | `historyMarkdown` | 134-136 | 0 / 1 | 0.0% |
| `packages/mcp/src/format.ts` | `pendingItemMarkdown` | 138-153 | 1 / 15 | 6.7% |
| `packages/mcp/src/format.ts` | `<anonymous@147>` | 147-147 | 0 / 1 | 0.0% |
| `packages/mcp/src/format.ts` | `pendingMarkdown` | 156-164 | 0 / 7 | 0.0% |
| `packages/mcp/src/policy.ts` | `<anonymous@55>` | 55-55 | 0 / 1 | 0.0% |
| `packages/mcp/src/policy.ts` | `splitActions` | 69-77 | 1 / 8 | 12.5% |
| `packages/mcp/src/policy.ts` | `splitPendingActions` | 84-93 | 0 / 8 | 0.0% |
| `packages/mcp/src/policy.ts` | `<anonymous@85>` | 85-85 | 0 / 1 | 0.0% |
| `packages/mcp/src/policy.ts` | `<anonymous@86>` | 86-92 | 0 / 6 | 0.0% |
| `packages/mcp/src/policy.ts` | `<anonymous@88>` | 88-91 | 0 / 4 | 0.0% |
| `packages/mcp/src/server.ts` | `RpcError.constructor` | 132-136 | 1 / 4 | 25.0% |
| `packages/mcp/src/server.ts` | `validId` | 143-149 | 1 / 6 | 16.7% |
| `packages/mcp/src/server.ts` | `lineWriter` | 161-165 | 1 / 3 | 33.3% |
| `packages/mcp/src/server.ts` | `serializedWrite` | 170-179 | 1 / 8 | 12.5% |
| `packages/mcp/src/server.ts` | `<anonymous@172>` | 172-178 | 1 / 6 | 16.7% |
| `packages/mcp/src/server.ts` | `<anonymous@173>` | 173-175 | 0 / 3 | 0.0% |
| `packages/mcp/src/server.ts` | `<anonymous@176>` | 176-176 | 0 / 1 | 0.0% |
| `packages/mcp/src/server.ts` | `logWriter` | 183-187 | 1 / 3 | 33.3% |
| `packages/mcp/src/server.ts` | `onAnswer` | 209-217 | 1 / 9 | 11.1% |
| `packages/mcp/src/server.ts` | `onLog` | 218-220 | 1 / 3 | 33.3% |
| `packages/mcp/src/server.ts` | `onLog` | 229-231 | 1 / 3 | 33.3% |
| `packages/mcp/src/server.ts` | `onLog` | 239-241 | 1 / 3 | 33.3% |
| `packages/mcp/src/server.ts` | `requireEmptyParams` | 261-266 | 1 / 5 | 20.0% |
| `packages/mcp/src/server.ts` | `callTool` | 275-310 | 1 / 34 | 2.9% |
| `packages/mcp/src/server.ts` | `dispatch` | 317-347 | 1 / 29 | 3.4% |
| `packages/mcp/src/server.ts` | `handleLine` | 356-410 | 1 / 53 | 1.9% |
| `packages/mcp/src/server.ts` | `decodeLines` | 414-434 | 1 / 20 | 5.0% |
| `packages/mcp/src/server.ts` | `runMcpServer` | 443-504 | 1 / 60 | 1.7% |
| `packages/mcp/src/server.ts` | `<anonymous@446>` | 446-446 | 0 / 1 | 0.0% |
| `packages/mcp/src/server.ts` | `<anonymous@448>` | 448-448 | 0 / 1 | 0.0% |
| `packages/mcp/src/server.ts` | `<anonymous@450>` | 450-450 | 0 / 1 | 0.0% |
| `packages/mcp/src/server.ts` | `pending` | 467-473 | 0 / 7 | 0.0% |
| `packages/mcp/src/server.ts` | `send` | 479-487 | 0 / 9 | 0.0% |
| `packages/mcp/src/server.ts` | `onLog` | 488-490 | 0 / 3 | 0.0% |
| `packages/mcp/src/server.ts` | `<anonymous@495>` | 495-497 | 0 / 3 | 0.0% |
| `packages/mcp/src/tools.ts` | `structuredValue` | 299-304 | 1 / 5 | 20.0% |
| `packages/mcp/src/tools.ts` | `runTool` | 314-476 | 22 / 161 | 13.7% |
| `packages/mcp/src/tools.ts` | `<anonymous@404>` | 404-404 | 0 / 1 | 0.0% |
| `packages/pool/src/index.ts` | `messageOf` | 78-80 | 0 / 1 | 0.0% |
| `packages/source-cron/src/index.ts` | `CronSource.start` | 70-83 | 1 / 13 | 7.7% |
| `packages/source-cron/src/index.ts` | `<anonymous@71>` | 71-73 | 0 / 3 | 0.0% |
| `packages/source-cron/src/index.ts` | `CronSource.stop` | 78-81 | 0 / 4 | 0.0% |
| `packages/source-cron/src/index.ts` | `start` | 90-94 | 1 / 4 | 25.0% |
| `packages/tui/src/app.ts` | `<anonymous@1294>` | 1294-1297 | 1 / 3 | 33.3% |
| `packages/tui/src/client.ts` | `TuiClient.setSetting` | 393-404 | 1 / 11 | 9.1% |
| `packages/tui/src/events.ts` | `TuiEvents.return` | 187-190 | 1 / 3 | 33.3% |
| `packages/tui/src/state.ts` | `filterFor` | 454-458 | 1 / 4 | 25.0% |
| `packages/tui/src/state.ts` | `childLines` | 1789-1792 | 0 / 2 | 0.0% |
| `packages/tui/src/state.ts` | `<anonymous@1852>` | 1852-1852 | 0 / 1 | 0.0% |
| `packages/tui/src/state.ts` | `<anonymous@1864>` | 1864-1864 | 0 / 1 | 0.0% |
| `packages/tui/src/view/index.ts` | `give` | 705-709 | 1 / 4 | 25.0% |
| `packages/tui/src/view/index.ts` | `<anonymous@805>` | 805-809 | 0 / 4 | 0.0% |
| `packages/tui/src/view/index.ts` | `<anonymous@845>` | 845-849 | 0 / 4 | 0.0% |

## Tests with the same line coverage

Method: each of the 210 package test files was run alone with coverage
(sum of the isolated run times: 898 s). For each source file, the hit-line
set of every test file was compared. Tests with exactly the same set were
grouped. This is test-file granularity; it does not distinguish individual
test cases inside a file.

Raw result: **518 groups**, touching
**193 test files**. Most raw groups are module
loading: many test files import the same engine module and hit the same few
initialisation lines. The candidate list below keeps groups that cover at
least 80% of a source file's executable lines, at least 5 lines, with 2 to
20 test files from the source file's own package; `index.ts` and `types.ts`
barrels are omitted. It is a starting list for later tasks, not a deletion
list. 33 groups remain after this filter.

### `packages/tui/src/themes.ts`

34 / 34 executable lines covered by all of:

- `packages/tui/test/app.test.ts`
- `packages/tui/test/fatal.test.ts`
- `packages/tui/test/object-page.test.ts`
- `packages/tui/test/palette-theme.test.ts`
- `packages/tui/test/popular-themes.test.ts`

### `packages/engine/src/log/open-log.ts`

8 / 8 executable lines covered by all of:

- `packages/engine/test/loop/serve-history.test.ts`
- `packages/engine/test/open-log.test.ts`
- `packages/engine/test/runner/runner.test.ts`
- `packages/engine/test/trigger/trigger.test.ts`

### `packages/engine/src/plugin/logger.ts`

19 / 19 executable lines covered by all of:

- `packages/engine/test/platform/step-reap.test.ts`
- `packages/engine/test/plugin/registry.test.ts`
- `packages/engine/test/runner/runner.test.ts`

### `packages/dev/src/reruns.ts`

41 / 41 executable lines covered by all of:

- `packages/dev/test/flaky.test.ts`
- `packages/dev/test/gate.test.ts`

### `packages/dev/src/timeouts.ts`

10 / 10 executable lines covered by all of:

- `packages/dev/test/gate.test.ts`
- `packages/dev/test/timeouts.test.ts`

### `packages/engine/src/plugin/filters.ts`

20 / 20 executable lines covered by all of:

- `packages/engine/test/views/filters.test.ts`
- `packages/engine/test/views/tree.test.ts`

### `packages/engine/src/plugin/open-store.ts`

26 / 26 executable lines covered by all of:

- `packages/engine/test/plugin/object-store.test.ts`
- `packages/engine/test/runner/runner.test.ts`

### `packages/tui/src/recent.ts`

24 / 24 executable lines covered by all of:

- `packages/tui/test/palette-fuzzy.test.ts`
- `packages/tui/test/palette-theme.test.ts`

### `packages/tui/src/live.ts`

52 / 54 executable lines covered by all of:

- `packages/tui/test/live.test.ts`
- `packages/tui/test/plugin-tabs.test.ts`

### `packages/chat/src/model.ts`

132 / 140 executable lines covered by all of:

- `packages/chat/test/flow.test.ts`
- `packages/chat/test/surface.test.ts`

### `packages/tui/src/live.ts`

50 / 54 executable lines covered by all of:

- `packages/tui/test/filter.test.ts`
- `packages/tui/test/object-app.test.ts`
- `packages/tui/test/object-focus.test.ts`
- `packages/tui/test/pages-refresh.test.ts`

### `packages/engine/src/log/json-value.ts`

43 / 47 executable lines covered by all of:

- `packages/engine/test/jsonl.test.ts`
- `packages/engine/test/sqlite.test.ts`

### `packages/dev/src/refusals.ts`

177 / 194 executable lines covered by all of:

- `packages/dev/test/followups.test.ts`
- `packages/dev/test/proposed-pending.test.ts`
- `packages/dev/test/schedule.test.ts`

### `packages/engine/src/platform/watch.ts`

70 / 77 executable lines covered by all of:

- `packages/engine/test/runner/ask.test.ts`
- `packages/engine/test/runner/limits.test.ts`

### `packages/tui/src/wrap.ts`

96 / 106 executable lines covered by all of:

- `packages/tui/test/object-page.test.ts`
- `packages/tui/test/object-view.test.ts`

### `packages/engine/src/plugin/store.ts`

191 / 211 executable lines covered by all of:

- `packages/engine/test/http/server.test.ts`
- `packages/engine/test/views/presentation.test.ts`

### `packages/dev/src/git.ts`

37 / 41 executable lines covered by all of:

- `packages/dev/test/gate.test.ts`
- `packages/dev/test/harness-pi.test.ts`
- `packages/dev/test/integrate.test.ts`
- `packages/dev/test/resume-verify.test.ts`
- `packages/dev/test/wrap-up.test.ts`

### `packages/engine/src/plugin/secrets.ts`

95 / 107 executable lines covered by all of:

- `packages/engine/test/http/server.test.ts`
- `packages/engine/test/notify/notify.test.ts`
- `packages/engine/test/testing/testing.test.ts`
- `packages/engine/test/views/filters.test.ts`
- `packages/engine/test/views/tree.test.ts`

### `packages/dev/src/places.ts`

119 / 135 executable lines covered by all of:

- `packages/dev/test/harness-pi.test.ts`
- `packages/dev/test/integrate.test.ts`
- `packages/dev/test/resume-verify.test.ts`
- `packages/dev/test/worktree.test.ts`

### `packages/engine/src/trigger/store.ts`

126 / 143 executable lines covered by all of:

- `packages/engine/test/loop/serve.test.ts`
- `packages/engine/test/trigger/trigger.test.ts`

### `packages/engine/src/runner/service.ts`

80 / 91 executable lines covered by all of:

- `packages/engine/test/fixtures/example-plugin/plugin.test.ts`
- `packages/engine/test/testing/testing.test.ts`

### `packages/dev/src/git.ts`

36 / 41 executable lines covered by all of:

- `packages/dev/test/chat.test.ts`
- `packages/dev/test/pause.test.ts`
- `packages/dev/test/retry.test.ts`
- `packages/dev/test/worktree.test.ts`

### `packages/dev/src/refusals.ts`

170 / 194 executable lines covered by all of:

- `packages/dev/test/after-any.test.ts`
- `packages/dev/test/flow-compiler.test.ts`
- `packages/dev/test/integrate.test.ts`

### `packages/engine/src/plugin/settings.ts`

39 / 45 executable lines covered by all of:

- `packages/engine/test/testing/testing.test.ts`
- `packages/engine/test/views/settings.test.ts`

### `packages/engine/src/plugin/home.ts`

6 / 7 executable lines covered by all of:

- `packages/engine/test/plugin/answered-automatically.test.ts`
- `packages/engine/test/plugin/declare-flow.test.ts`
- `packages/engine/test/plugin/registry.test.ts`
- `packages/engine/test/plugin/usage.test.ts`
- `packages/engine/test/plugin/validate.test.ts`
- `packages/engine/test/trigger/start-checks.test.ts`
- `packages/engine/test/trigger/trigger.test.ts`
- `packages/engine/test/views/filters.test.ts`
- `packages/engine/test/views/pending-row.test.ts`
- `packages/engine/test/views/prepare.test.ts`
- `packages/engine/test/views/presentation.test.ts`
- `packages/engine/test/views/refusals.test.ts`
- `packages/engine/test/views/running.test.ts`
- `packages/engine/test/views/standing.test.ts`
- `packages/engine/test/views/tree.test.ts`

### `packages/dev/src/refusals.ts`

165 / 194 executable lines covered by all of:

- `packages/dev/test/gate.test.ts`
- `packages/dev/test/metrics-run.test.ts`

### `packages/engine/src/log/secret.ts`

11 / 13 executable lines covered by all of:

- `packages/engine/test/jsonl.test.ts`
- `packages/engine/test/sqlite.test.ts`

### `packages/dev/src/refusals.ts`

161 / 194 executable lines covered by all of:

- `packages/dev/test/busy-after-write.test.ts`
- `packages/dev/test/config-error.test.ts`
- `packages/dev/test/flow-choice.test.ts`
- `packages/dev/test/project-flows.test.ts`
- `packages/dev/test/repo-type.test.ts`

### `packages/engine/src/platform/file-lock.ts`

200 / 241 executable lines covered by all of:

- `packages/engine/test/fixtures/example-plugin/emit.test.ts`
- `packages/engine/test/fixtures/example-plugin/failure.test.ts`
- `packages/engine/test/fixtures/example-plugin/plugin.test.ts`
- `packages/engine/test/fixtures/example-plugin/timeout.test.ts`
- `packages/engine/test/http/server.test.ts`
- `packages/engine/test/loop/serve-history.test.ts`
- `packages/engine/test/loop/serve.test.ts`
- `packages/engine/test/runner/access.test.ts`
- `packages/engine/test/testing/testing.test.ts`
- `packages/engine/test/trigger/start-checks.test.ts`
- `packages/engine/test/trigger/trigger.test.ts`

### `packages/engine/src/log/json-value.ts`

39 / 47 executable lines covered by all of:

- `packages/engine/test/fixtures/example-plugin/plugin.test.ts`
- `packages/engine/test/loop/serve.test.ts`
- `packages/engine/test/notify/notify.test.ts`
- `packages/engine/test/runner/ask-resume.test.ts`
- `packages/engine/test/runner/ask.test.ts`
- `packages/engine/test/runner/runner.test.ts`
- `packages/engine/test/testing/testing.test.ts`
- `packages/engine/test/views/running.test.ts`

### `packages/dev/src/git.ts`

34 / 41 executable lines covered by all of:

- `packages/dev/test/schedule.test.ts`
- `packages/dev/test/views.test.ts`

### `packages/dev/src/git.ts`

33 / 41 executable lines covered by all of:

- `packages/dev/test/actions.test.ts`
- `packages/dev/test/after-any.test.ts`
- `packages/dev/test/busy-after-write.test.ts`
- `packages/dev/test/check.test.ts`
- `packages/dev/test/cli.test.ts`
- `packages/dev/test/flaky.test.ts`
- `packages/dev/test/flow-choice.test.ts`
- `packages/dev/test/flow-compiler.test.ts`
- `packages/dev/test/followups.test.ts`
- `packages/dev/test/lead-actions.test.ts`
- `packages/dev/test/metrics-run.test.ts`
- `packages/dev/test/project-flows.test.ts`
- `packages/dev/test/proposed-pending.test.ts`
- `packages/dev/test/refusals.test.ts`
- `packages/dev/test/replay.test.ts`
- `packages/dev/test/repo-type.test.ts`
- `packages/dev/test/throughput.test.ts`
- `packages/dev/test/waiting.test.ts`

### `packages/engine/src/http/token.ts`

40 / 50 executable lines covered by all of:

- `packages/engine/test/views/filters.test.ts`
- `packages/engine/test/views/tree.test.ts`

