import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultControlTarget, shouldOpenSceneControl } from "../scripts/app/scene-control.mjs";

const control = (name, tools, extra = {}) => ({ name, tools, ...extra });
const tool = (name, order) => ({ name, order });

test("scene-control activation opens only for the activating call", () => {
  assert.equal(shouldOpenSceneControl(true), true);
  assert.equal(shouldOpenSceneControl(false), false, "deactivating another control must not reopen the app");
  assert.equal(shouldOpenSceneControl(undefined), false, "a missing active flag is not an activation");
  assert.equal(shouldOpenSceneControl("true"), false, "only the literal boolean opens");
});

test("defaultControlTarget prefers tokens/select when available", () => {
  const controls = {
    walls: control("walls", { select: tool("select", 1) }),
    tokens: control("tokens", { target: tool("target", 2), select: tool("select", 1) }, { activeTool: "select" })
  };
  assert.deepEqual(defaultControlTarget(controls), { control: "tokens", tool: "select" });
});

test("defaultControlTarget falls back to the token control's active tool", () => {
  const controls = {
    tokens: control("tokens", { target: tool("target", 2), move: tool("move", 1) }, { activeTool: "target" })
  };
  assert.deepEqual(defaultControlTarget(controls), { control: "tokens", tool: "target" });
});

test("defaultControlTarget falls back to the first available control and tool", () => {
  const controls = {
    walls: control("walls", { draw: tool("draw", 2), select: tool("select", 1) }),
    lights: control("lights", { select: tool("select", 1) })
  };
  assert.deepEqual(defaultControlTarget(controls), { control: "walls", tool: "select" },
    "the lowest-order tool is used when the preferred tool is missing");
  assert.deepEqual(defaultControlTarget({ lights: controls.lights }), { control: "lights", tool: "select" });
});

test("defaultControlTarget handles empty or malformed control records", () => {
  assert.equal(defaultControlTarget({}), null);
  assert.equal(defaultControlTarget(null), null);
  assert.equal(defaultControlTarget({ empty: { name: "empty", tools: {} } }), null,
    "a control without a usable tool cannot be activated");
  assert.deepEqual(defaultControlTarget(new Map([["tokens", control("tokens", { select: tool("select", 1) })]])),
    { control: "tokens", tool: "select" }, "Map-backed control records work too");
});
