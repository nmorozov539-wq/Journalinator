import { test } from "node:test";
import assert from "node:assert/strict";
import { diffCounts, MAX_DIFF_EDITS } from "../scripts/text-diff.mjs";

test("identical bodies produce no counts", () => {
  assert.deepEqual(diffCounts("", ""), { charsAdded: 0, charsRemoved: 0 });
  assert.deepEqual(diffCounts("abc", "abc"), { charsAdded: 0, charsRemoved: 0 });
  assert.deepEqual(diffCounts("# title\n😀 body", "# title\n😀 body"), {
    charsAdded: 0,
    charsRemoved: 0
  });
});

test("insertions count only the added code points", () => {
  assert.deepEqual(diffCounts("hello", "hello world"), { charsAdded: 6, charsRemoved: 0 });
  assert.deepEqual(diffCounts("", "abc"), { charsAdded: 3, charsRemoved: 0 });
  assert.deepEqual(diffCounts("ab", "aXb"), { charsAdded: 1, charsRemoved: 0 });
});

test("deletions count only the removed code points", () => {
  assert.deepEqual(diffCounts("hello world", "hello"), { charsAdded: 0, charsRemoved: 6 });
  assert.deepEqual(diffCounts("abc", ""), { charsAdded: 0, charsRemoved: 3 });
  assert.deepEqual(diffCounts("aXb", "ab"), { charsAdded: 0, charsRemoved: 1 });
});

test("an equal-length replacement counts both sides, never net length", () => {
  assert.deepEqual(diffCounts("abc", "xyz"), { charsAdded: 3, charsRemoved: 3 });
  assert.deepEqual(diffCounts("abcd", "wxyz"), { charsAdded: 4, charsRemoved: 4 });
});

test("mixed edits report both additions and removals", () => {
  assert.deepEqual(diffCounts("abcdef", "abXYef"), { charsAdded: 2, charsRemoved: 2 });
  assert.deepEqual(diffCounts("one two", "one 2 three"), {
    charsAdded: 6,
    charsRemoved: 2
  });
});

test("counts are Unicode code points, not UTF-16 code units", () => {
  // Both emoji are surrogate pairs in UTF-16; each is one code point.
  assert.deepEqual(diffCounts("a😀b", "a😎b"), { charsAdded: 1, charsRemoved: 1 });
  assert.deepEqual(diffCounts("a", "a😀"), { charsAdded: 1, charsRemoved: 0 });
  assert.deepEqual(diffCounts("😀", ""), { charsAdded: 0, charsRemoved: 1 });
});

test("repeated characters do not confuse the alignment", () => {
  assert.deepEqual(diffCounts("aaaaab", "baaaaa"), { charsAdded: 1, charsRemoved: 1 });
  assert.deepEqual(diffCounts("abcabcabc", "abcabc"), { charsAdded: 0, charsRemoved: 3 });
  assert.deepEqual(
    diffCounts(`${"a".repeat(5000)}b`, `b${"a".repeat(5000)}`),
    { charsAdded: 1, charsRemoved: 1 }
  );
});

test("large localized changes stay fast", () => {
  const before = `${"a".repeat(100_000)}X${"b".repeat(100_000)}`;
  const after = `${"a".repeat(100_000)}Y${"b".repeat(100_000)}`;
  const start = performance.now();
  assert.deepEqual(diffCounts(before, after), { charsAdded: 1, charsRemoved: 1 });
  assert.ok(performance.now() - start < 2000, "200k-character localized diff is bounded");
});

test("a completely different large body is bounded and counts the whole middle", () => {
  const before = "a".repeat(200_000);
  const after = "b".repeat(200_000);
  const start = performance.now();
  assert.deepEqual(diffCounts(before, after), {
    charsAdded: 200_000,
    charsRemoved: 200_000
  });
  assert.ok(performance.now() - start < 5000, "200k-character full replacement is bounded");
});

test("beyond the edit cap the changed middle falls back to full removal + addition", () => {
  assert.equal(MAX_DIFF_EDITS, 2000);
  const before = "a".repeat(3000);
  const after = "b".repeat(3000);
  assert.deepEqual(diffCounts(before, after), { charsAdded: 3000, charsRemoved: 3000 });
});
