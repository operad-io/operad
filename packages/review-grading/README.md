# @operad-io/review-grading

The reader for a repository's review grading, `.operad/review.json`. A plugin
whose flow reviews calls

```ts
readReviewGrading(repositoryPath, flowName): Grading
```

and puts the result in its review prompt. The package has no runtime
dependency. `review.schema.json` is the file's JSON Schema.

```json
{
  "$schema": "../packages/review-grading/review.schema.json",
  "default": { "fixLevel": "major" },
  "flows": {
    "dev": {
      "levels": { "critical": "…", "major": "…", "minor": "…" },
      "rules": ["…"],
      "fixLevel": "major"
    }
  }
}
```

Every field is optional. A flow's entry falls back to `default` field by field
(`levels` per level; `rules` as a whole). A missing file gives an empty grading,
so the plugin adds no grading text and keeps its own fix level. An invalid file
throws a `ReviewGradingError` whose message names `review.json` and what is
wrong.

| field | meaning |
|---|---|
| `levels.critical`, `levels.major`, `levels.minor` | what each severity means, given to the reviewer verbatim |
| `rules` | rules for grading, given to the reviewer verbatim |
| `fixLevel` | the lowest severity that fails a review; wins over a plugin's own setting |
