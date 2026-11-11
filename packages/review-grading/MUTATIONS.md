# Mutation records — `review-grading`

Rows whose mutation broke code in `packages/review-grading/`. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0059-M1 | packages/review-grading/src/index.ts | the default's fixLevel won over the flow's | `readReviewGrading > a flow entry overrides the default field by field` |
| T-0059-M2 | packages/review-grading/src/index.ts | a flow's rules were ignored in favour of the default's | `readReviewGrading > a flow entry overrides the default field by field` |
| T-0059-M3 | packages/review-grading/src/index.ts | the flow's own entry was never looked up | `readReviewGrading > a flow entry alone works without a default` |
| T-0059-M4 | packages/review-grading/src/index.ts | a missing file was read instead of giving an empty grading | `readReviewGrading > a missing file gives an empty grading` |
