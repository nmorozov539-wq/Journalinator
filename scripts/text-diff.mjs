/**
 * Bounded character diff for the activity foundation.
 *
 * Counts are Unicode code points, never UTF-16 code units and never a net
 * length. The body pairs compared here are the previous confirmed body and the
 * next confirmed body, so a replacement of equal length still counts as both
 * removals and additions (the old text is gone and the new text arrived).
 *
 * Algorithm:
 *   1. Convert both sides to code-point arrays.
 *   2. Trim the common prefix and common suffix, so localized edits do not pay
 *      for the unchanged bulk of a long note.
 *   3. Run Myers' O((N+M)D) greedy shortest-edit-script search on the remaining
 *      middle, stopping at `MAX_DIFF_EDITS`.
 *   4. If the search exceeds the edit cap or the work budget (pathological
 *      repeated text, or a completely different large body), report the whole
 *      changed middle as removals + additions. That is exact for the common
 *      "everything changed" case and deliberately conservative otherwise.
 *
 * Memory is O(N+M) for the code-point arrays plus O(D) for Myers' frontier, not
 * O(N*M). Large bodies are therefore safe to diff on the GM.
 */

export const MAX_DIFF_EDITS = 2000;
export const MAX_DIFF_WORK = 20_000_000;

const EMPTY = Object.freeze({ charsAdded: 0, charsRemoved: 0 });

function codePoints(value) {
  return Array.from(typeof value === "string" ? value : String(value ?? ""));
}

function fallback(added, removed) {
  return { charsAdded: added, charsRemoved: removed };
}

/**
 * Myers greedy search over two code-point arrays. Returns the shortest edit
 * distance, or `null` when it is larger than the cap/budget. The distance is
 * `insertions + deletions`, so with `L = (n + m - d) / 2` the two sides are
 * `m - L` additions and `n - L` removals.
 */
function myersDistance(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const maxD = Math.min(n + m, MAX_DIFF_EDITS);
  const offset = maxD + 1;
  const frontier = new Int32Array(2 * maxD + 3);
  frontier[offset + 1] = 0;
  let work = 0;

  for (let d = 0; d <= maxD; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const left = frontier[offset + k - 1];
      const right = frontier[offset + k + 1];
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
        work += 1;
        if (work > MAX_DIFF_WORK) return null;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return d;
      work += 1;
      if (work > MAX_DIFF_WORK) return null;
    }
  }
  return null;
}

/**
 * Returns `{ charsAdded, charsRemoved }` for `previous -> next`, counted in
 * Unicode code points. Identical bodies return `{0, 0}`.
 */
export function diffCounts(previous, next) {
  const a = codePoints(previous);
  const b = codePoints(next);

  if (a.length === b.length) {
    let identical = true;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return { ...EMPTY };
  }

  // Trim the unchanged prefix, then the unchanged suffix without allowing the
  // two trims to overlap.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  const aMiddle = a.slice(prefix, a.length - suffix);
  const bMiddle = b.slice(prefix, b.length - suffix);
  if (aMiddle.length === 0) return fallback(bMiddle.length, 0);
  if (bMiddle.length === 0) return fallback(0, aMiddle.length);

  const distance = myersDistance(aMiddle, bMiddle);
  if (distance === null) return fallback(bMiddle.length, aMiddle.length);

  const lcs = (aMiddle.length + bMiddle.length - distance) / 2;
  return fallback(bMiddle.length - lcs, aMiddle.length - lcs);
}
