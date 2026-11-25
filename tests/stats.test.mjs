import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessions } from "../scripts/stats.mjs";

const bucket = chars => ({ gm: { chars, notes: 0, links: 0 } });

test("session markers own every activity day until the next marker", () => {
  const activity = {
    "2026-01-01": bucket(10),
    "2026-01-02": bucket(20),
    "2026-01-04": bucket(40),
    "2026-01-05": bucket(80),
    "2026-01-08": bucket(160)
  };
  const sessions = [
    { date: "2026-01-01", label: "Session 1" },
    { date: "2026-01-05", label: "Session 2" }
  ];
  assert.deepEqual(deriveSessions(activity, sessions), [
    { label: "Session 1", totals: { gm: 70 } },
    { label: "Session 2", totals: { gm: 240 } }
  ]);
});

test("sessions without markers still group by date gaps", () => {
  const activity = {
    "2026-01-01": bucket(10),
    "2026-01-02": bucket(20),
    "2026-01-05": bucket(40)
  };
  assert.deepEqual(deriveSessions(activity, []), [
    { label: "2026-01-01 – 2026-01-02", totals: { gm: 30 } },
    { label: "2026-01-05", totals: { gm: 40 } }
  ]);
});

test("activity before the first marker stays outside the marked sessions", () => {
  const activity = {
    "2026-01-01": bucket(5),
    "2026-01-03": bucket(10),
    "2026-01-04": bucket(20)
  };
  assert.deepEqual(deriveSessions(activity, [{ date: "2026-01-03", label: "Start" }]), [
    { label: "Start", totals: { gm: 30 } }
  ]);
});
