import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSearchBackend } from "../src/search/backend.ts";
import type { TokenizerName } from "../src/search/types.ts";

interface FixtureDocument {
  readonly path: string;
  readonly text: string;
}

interface FixtureQuery {
  readonly text: string;
  readonly relevant: readonly string[];
}

interface Fixture {
  readonly documents: readonly FixtureDocument[];
  readonly queries: readonly FixtureQuery[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "search", "chinese.json"), "utf8"),
) as Fixture;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Metrics {
  readonly recall: number;
  readonly mrr: number;
  readonly found: number;
  readonly relevant: number;
}

function measureSync(tokenizer: TokenizerName, file: string): Metrics {
  const backend = new SqliteSearchBackend({ file, tokenizer });
  try {
    for (const document of fixture.documents) {
      const id = `wiki:${document.path}`;
      backend.put({
        id,
        scope: "wiki",
        owner: "",
        path: document.path,
        directory: "",
        name: document.path,
        title: document.path,
        text: document.text,
        fields: {},
        lineCount: document.text.split("\n").length,
        digest: `${tokenizer}:${document.path}`,
      });
    }
    let found = 0;
    let relevant = 0;
    let reciprocal = 0;
    for (const query of fixture.queries) {
      const hits = backend.search({ text: query.text, scopes: ["wiki"], owner: "", limit: 5 });
      const ids = hits.map((hit) => hit.id);
      const rank = query.relevant
        .map((path) => ids.indexOf(`wiki:${path}`))
        .filter((at) => at >= 0)
        .sort((left, right) => left - right)[0];
      found += query.relevant.filter((path) => ids.includes(`wiki:${path}`)).length;
      relevant += query.relevant.length;
      if (rank !== undefined) reciprocal += 1 / (rank + 1);
    }
    return {
      recall: relevant === 0 ? 0 : found / relevant,
      mrr: fixture.queries.length === 0 ? 0 : reciprocal / fixture.queries.length,
      found,
      relevant,
    };
  } finally {
    backend.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), "memory-chinese-"));
roots.push(directory);
const latin = measureSync("unicode61", join(directory, "unicode61.sqlite"));
const chosen = measureSync("trigram", join(directory, "trigram.sqlite"));

describe("the Chinese tokenizer measurement", () => {
  test("trigram with its short-query fallback finds every fixture query", () => {
    expect(chosen.found).toBe(chosen.relevant);
    expect(chosen.recall).toBe(1);
  });

  test("unicode61 misses the Chinese words inside a sentence", () => {
    expect(latin.recall).toBeLessThan(chosen.recall);
    expect(latin.found).toBeLessThan(chosen.found);
  });

  test("a two-character query uses the substring fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-chinese-short-"));
    roots.push(root);
    const backend = new SqliteSearchBackend({ file: join(root, "short.sqlite"), tokenizer: "trigram" });
    try {
      backend.put({
        id: "wiki:记忆.md",
        scope: "wiki",
        owner: "",
        path: "记忆.md",
        directory: "",
        name: "记忆.md",
        title: "记忆",
        text: "把记忆分成小块。",
        fields: {},
        lineCount: 1,
        digest: "short",
      });
      expect(backend.search({ text: "记忆", scopes: ["wiki"], owner: "", limit: 5 })).toHaveLength(1);
    } finally {
      backend.close();
    }
  });
});
