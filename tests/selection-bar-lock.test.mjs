import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of ["document", "window", "Node", "HTMLElement", "Event"]) {
  globalThis[key] = dom.window[key];
}

const { createSelectionBar } = await import("../scripts/app/selection-bar.mjs");
const t = key => key;

function rect(left, top, width, height) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top
  };
}

function mountScenario({ rootRect, cardRect, badgeRect, barSize }) {
  const root = document.createElement("div");
  const card = document.createElement("div");
  card.className = "jn-card";
  card.dataset.id = "note-1";
  const badge = document.createElement("div");
  badge.className = "jn-lock-badge";
  badge.hidden = false;
  card.appendChild(badge);
  root.appendChild(card);
  document.body.appendChild(root);

  root.getBoundingClientRect = () => rect(...rootRect);
  card.getBoundingClientRect = () => rect(...cardRect);
  badge.getBoundingClientRect = () => rect(...badgeRect);

  const bar = createSelectionBar({ t });
  root.appendChild(bar.element);
  bar.element.getBoundingClientRect = () => rect(0, 0, barSize.width, barSize.height);
  bar.update({
    notes: [{ _id: "note-1", system: { layout: "plain" } }],
    lockedIds: ["note-1"],
    cards: {}
  });
  bar.position(card, root);
  return { bar, root, card, badge };
}

test("a locked selection places the toolbar above its Unlock badge at desktop width", () => {
  const { bar, root, badge } = mountScenario({
    rootRect: [0, 0, 1000, 700],
    cardRect: [100, 300, 220, 160],
    badgeRect: [100, 262, 180, 30],
    barSize: { width: 340, height: 100 }
  });
  const top = Number.parseFloat(bar.element.style.top);
  const left = Number.parseFloat(bar.element.style.left);
  const badgeTop = 262 - root.getBoundingClientRect().top;
  const badgeLeft = 100 - root.getBoundingClientRect().left;
  assert.ok(top + 100 <= badgeTop, "the whole bar sits above the lock badge");
  assert.ok(left <= badgeLeft + 180 && left + 340 >= badgeLeft,
    "the bar is still horizontally anchored over the card");
});

test("when there is no room above, a locked selection moves below the card at narrow width", () => {
  const { bar, root, card, badge } = mountScenario({
    rootRect: [0, 0, 400, 600],
    cardRect: [20, 80, 220, 140],
    badgeRect: [20, 42, 180, 30],
    barSize: { width: 360, height: 150 }
  });
  const top = Number.parseFloat(bar.element.style.top);
  const cardBottom = card.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
  const badgeBottom = badge.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
  assert.ok(top >= cardBottom, "the bar starts below the card that carries the badge");
  assert.ok(top > badgeBottom, "the badge and its Unlock button stay clear");
  assert.ok(top + 150 <= 600 - 8, "all selection controls remain inside the board");
});

test("the informational selection notice is click-through above a lock badge", () => {
  const css = readFileSync(new URL("../styles/journal.css", import.meta.url), "utf8");
  const rule = /\.jn-selection-notice\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the selection notice rule exists");
  assert.match(rule[1], /pointer-events:\s*none/,
    "a badge beneath the notice still receives the Unlock click");
});
