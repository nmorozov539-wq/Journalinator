import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowHead, ThreadMotion, threadPath } from "../scripts/link-thread.mjs";

const start = { x: 150, y: 90, nx: 1, ny: 0 };
const end = { x: 490, y: 90, nx: -1, ny: 0 };

test("thread sags between fixed sockets and leaves room for its arrow", () => {
  const thread = threadPath(start, end);
  assert.match(thread.path, /^M150 90 L172 90 C/);
  assert.match(thread.path, / L490 90$/);
  assert.equal(thread.center.x, 320);
  assert.ok(thread.center.y > 90);
  const [tip, base] = arrowHead(end, thread.lead).split(" ");
  assert.equal(tip, "490,90");
  assert.ok(Number(tip.split(",")[0]) > Number(base.split(",")[0]));
  const vertical = threadPath({ ...start, nx: 0, ny: 1 }, { x: start.x, y: 300, nx: 0, ny: -1 });
  assert.deepEqual(vertical.center, { x: 150, y: 195 });
});

test("moving a socket pulls the thread, which settles while its endpoints stay fixed", () => {
  const motion = new ThreadMotion(start, end);
  const moved = { ...end, x: 550, y: 135 };
  motion.retarget(start, moved, true);
  const active = threadPath(start, moved, motion);
  const resting = threadPath(start, moved);
  assert.ok(motion.moving);
  assert.notDeepEqual(active.center, resting.center);
  for (let i = 0; i < 150 && motion.moving; i++) motion.step(1 / 60);
  assert.equal(motion.moving, false);
  assert.equal(threadPath(start, moved, motion).path, resting.path);
  assert.match(active.path, /^M150 90 /);
  assert.match(active.path, / L550 135$/);
  motion.retarget(start, end, false);
  assert.equal(motion.moving, false);
});
