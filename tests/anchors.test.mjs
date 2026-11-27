import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANCHOR_MERGE_TOLERANCE, MAIN_ANCHOR_ID, anchorWorld, canonicalizeMainAnchors, cardNormalizedPoint,
  collectAnchorRefs, defaultMainAnchor, mergeNearbyMinorAnchors, nearestAnchor, nearestMinorAnchor,
  projectToEdge, promoteLegacyLinkAnchors, pruneAnchorRegistry, redistributionAnchor, validAnchorId
} from "../scripts/anchors.mjs";
import { sanitizeCardAnchors } from "../scripts/presentation.mjs";

const box = (overrides = {}) => ({ x: 0, y: 0, w: 100, h: 50, rotation: 0, ...overrides });
const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`);

test("anchorWorld maps normalized anchors to world points with outward normals", () => {
  const top = anchorWorld(box(), { kind: "minor", x: 0.5, y: 0 });
  assert.deepEqual([top.x, top.y], [50, 0]);
  assert.equal(top.side, "top");
  near(top.nx, 0);
  near(top.ny, -1);

  const left = anchorWorld(box(), { kind: "minor", x: 0, y: 0.5 });
  assert.equal(left.side, "left");
  near(left.nx, -1);
  near(left.ny, 0);

  // Main is a constant at the top-centre even if an old record stored other coordinates.
  const main = anchorWorld(box(), { kind: "main", x: 0, y: 0.5 });
  assert.deepEqual([main.x, main.y, main.side], [50, 0, "top"]);

  const rotated = anchorWorld(box({ x: 10, y: 20, rotation: 90 }), { kind: "minor", x: 0.5, y: 0 });
  near(rotated.x, 85);
  near(rotated.y, 45);
  assert.equal(rotated.side, "top");
  near(rotated.nx, 1);
  near(rotated.ny, 0);

  assert.equal(anchorWorld(box(), { kind: "minor", x: 2, y: 0.5 }), null);
  assert.equal(anchorWorld(box(), null), null);
});

test("cardNormalizedPoint inverts world geometry and clamps to the card", () => {
  assert.deepEqual(cardNormalizedPoint(box(), { x: 75, y: 25 }), { x: 0.75, y: 0.5 });
  assert.deepEqual(cardNormalizedPoint(box(), { x: -30, y: 100 }), { x: 0, y: 1 });
  assert.equal(cardNormalizedPoint(box(), { x: NaN, y: 0 }), null);
  assert.equal(cardNormalizedPoint(null, { x: 0, y: 0 }), null);

  const rotated = cardNormalizedPoint(box({ x: 10, y: 20, rotation: 90 }), { x: 85, y: 45 });
  near(rotated.x, 0.5);
  near(rotated.y, 0);
});

test("nearestAnchor respects separate main/minor screen-space radii", () => {
  const anchors = {
    main: { kind: "main", x: 0.5, y: 0 },
    bottom: { kind: "minor", x: 0.5, y: 1 }
  };
  const mainHit = nearestAnchor(box(), anchors, { x: 51, y: 1 }, { zoom: 1 });
  assert.equal(mainHit.id, "main");

  const minorHit = nearestAnchor(box(), anchors, { x: 50, y: 49 }, { zoom: 1 });
  assert.equal(minorHit.id, "bottom");

  assert.equal(nearestAnchor(box(), anchors, { x: 51, y: 1 }, {
    zoom: 1, mainRadius: 0, minorRadius: 6
  }), null, "main can be excluded from snapping");

  assert.equal(nearestAnchor(box(), anchors, { x: 65, y: 25 }, {
    zoom: 1, mainRadius: 24, minorRadius: 6
  }), null);
});

test("projectToEdge picks the nearest rotated-card boundary point", () => {
  const left = projectToEdge(box(), { x: -20, y: 25 });
  assert.equal(left.side, "left");
  assert.deepEqual(left.point, { x: 0, y: 0.5 });
  assert.equal(left.distance, 20);

  const top = projectToEdge(box(), { x: 50, y: 10 });
  assert.equal(top.side, "top");
  assert.deepEqual(top.point, { x: 0.5, y: 0 });

  assert.equal(projectToEdge(box(), { x: NaN, y: 0 }), null);
  assert.equal(projectToEdge(null, { x: 0, y: 0 }), null);
});

test("redistributionAnchor reuses a nearby minor then falls back to the edge", () => {
  const anchors = {
    main: { kind: "main", x: 0.5, y: 0 },
    side: { kind: "minor", x: 0.5, y: 0 }
  };
  const reuse = redistributionAnchor(box(), anchors, { x: 51, y: 1 }, { snap: 12 });
  assert.equal(reuse.anchorId, "side");
  assert.deepEqual(reuse.anchor, anchors.side);

  const fresh = redistributionAnchor(box(), anchors, { x: 100, y: 25 }, { snap: 12 });
  assert.equal(fresh.anchorId, "");
  assert.equal(fresh.anchor.kind, "minor");
  assert.deepEqual([fresh.anchor.x, fresh.anchor.y], [1, 0.5]);
});

test("defaultMainAnchor and validAnchorId use the canonical main pin", () => {
  assert.deepEqual(defaultMainAnchor("user1"), {
    kind: "main", x: 0.5, y: 0, createdBy: "user1"
  });
  assert.equal(MAIN_ANCHOR_ID, "main");
  assert.equal(validAnchorId("main"), true);
  assert.equal(validAnchorId("a".repeat(100)), true);
  assert.equal(validAnchorId("a".repeat(101)), false);
  assert.equal(validAnchorId(""), false);
  assert.equal(validAnchorId(42), false);
});

test("anchor ids reject paths, prototype keys, over-long and non-string values", () => {
  for (const id of ["constructor", "__proto__", "prototype", "a.b", "a/b", "", "a".repeat(101), 42, null]) {
    assert.equal(validAnchorId(id), false, `${String(id)} is not a valid anchor id`);
  }
  for (const id of ["main", "minor-1", "A_b-9", "a".repeat(100)]) {
    assert.equal(validAnchorId(id), true, `${id} is valid`);
  }

  const dirty = JSON.parse(`{
    "main": { "kind": "main", "x": 0.9, "y": 0.9, "createdBy": "spoof" },
    "legacy-main": { "kind": "main", "x": 0.1, "y": 0.1, "createdBy": "also-spoof" },
    "constructor": { "kind": "minor", "x": 0.2, "y": 0.2 },
    "__proto__": { "kind": "minor", "x": 0.2, "y": 0.2 },
    "a.b": { "kind": "minor", "x": 0.2, "y": 0.2 },
    "a/b": { "kind": "minor", "x": 0.2, "y": 0.2 },
    "safe": { "kind": "minor", "x": 0.3, "y": 0.4, "createdBy": "u" }
  }`);
  assert.deepEqual(sanitizeCardAnchors(dirty), {
    safe: { kind: "minor", x: 0.3, y: 0.4, createdBy: "u" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "spoof" }
  }, "any main folds into one canonical main; unsafe ids and duplicate mains are dropped");
  assert.equal(Object.hasOwn(sanitizeCardAnchors(dirty), "constructor"), false);
});

test("nearestAnchor and redistribution ignore unsound registry keys", () => {
  const anchors = {
    "a.b": { kind: "minor", x: 0.5, y: 0 },
    constructor: { kind: "minor", x: 0.5, y: 0 },
    safe: { kind: "minor", x: 0.5, y: 0 }
  };
  assert.equal(nearestAnchor(box(), anchors, { x: 50, y: 0 }, { zoom: 1, minorRadius: 10 }).id, "safe");
  assert.equal(nearestAnchor(box(), { "a.b": anchors["a.b"] }, { x: 50, y: 0 }, {
    zoom: 1, minorRadius: 10
  }), null);
});

test("collectAnchorRefs counts source, target and route references per owning note", () => {
  const refs = collectAnchorRefs([
    {
      id: "a",
      system: {
        links: [
          {
            sourceAnchorId: "s1",
            targetId: "b",
            targetAnchorId: "t1",
            routeAnchors: [{ noteId: "b", anchorId: "r1" }, { noteId: "c", anchorId: "r2" }]
          }
        ]
      }
    },
    {
      id: "b",
      system: {
        links: [{ sourceAnchorId: "s2", targetId: "a", targetAnchorId: "t2" }]
      }
    }
  ]);

  assert.deepEqual([...refs.get("a")].sort(), ["s1", "t2"]);
  assert.deepEqual([...refs.get("b")].sort(), ["r1", "s2", "t1"]);
  assert.deepEqual([...refs.get("c")], ["r2"]);
  assert.equal(refs.has("missing"), false);
});

test("pruneAnchorRegistry drops unsafe keys and only preserves the canonical main", () => {
  const cards = {
    a: {
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        legacyMain: { kind: "main", x: 0.1, y: 0.1, createdBy: "u" },
        constructor: { kind: "minor", x: 0.2, y: 0.2 },
        "a.b": { kind: "minor", x: 0.2, y: 0.2 },
        used: { kind: "minor", x: 0.3, y: 0.3 }
      }
    }
  };
  const changed = pruneAnchorRegistry(cards, [{
    id: "a", system: { links: [{ sourceAnchorId: "used" }] }
  }]);
  assert.deepEqual(changed.map(entry => entry.noteId), ["a"]);
  assert.deepEqual(Object.keys(changed[0].anchors).sort(), ["main", "used"]);
});

test("pruneAnchorRegistry preserves manually placed pins without connections", () => {
  const cards = {
    a: {
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        m1: { kind: "minor", x: 0.1, y: 0.2, createdBy: "u" },
        m2: { kind: "minor", x: 0.3, y: 0.4, createdBy: "u" }
      }
    },
    b: {
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        t1: { kind: "minor", x: 0.7, y: 0.8, createdBy: "u" }
      }
    },
    c: {
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        orphan: { kind: "minor", x: 0.9, y: 0.1, createdBy: "u" }
      }
    }
  };
  const notes = [{
    id: "a",
    system: {
      links: [
        { sourceAnchorId: "m1", targetId: "b", targetAnchorId: "t1" },
        { sourceAnchorId: "m1", targetId: "c" } // m1 is shared by several links and survives
      ]
    }
  }];

  const changed = pruneAnchorRegistry(cards, notes);
  assert.deepEqual(changed, []);

  const second = pruneAnchorRegistry({
    ...cards,
    a: { anchors: { main: cards.a.anchors.main, m1: cards.a.anchors.m1 } },
    c: { anchors: { main: cards.c.anchors.main } }
  }, notes);
  assert.deepEqual(second, [], "pruning is idempotent");
});

test("canonicalizeMainAnchors folds referenced non-canonical mains and rewrites links", () => {
  const cards = {
    a: {
      anchors: {
        main: { kind: "main", x: 0.9, y: 0.9, createdBy: "u" },
        legacyMain: { kind: "main", x: 0.1, y: 0.2, createdBy: "u" },
        m1: { kind: "minor", x: 0.3, y: 0.4, createdBy: "u" }
      }
    },
    b: { anchors: { legacyOnly: { kind: "main", x: 0.2, y: 0.3, createdBy: "b" } } }
  };
  const notes = [
    {
      id: "a",
      system: {
        links: [
          { id: "l1", sourceAnchorId: "legacyMain", targetId: "b", targetAnchorId: "legacyOnly" },
          {
            id: "l2", sourceAnchorId: "m1", targetId: "a", targetAnchorId: "legacyMain",
            routeAnchors: [{ noteId: "b", anchorId: "legacyOnly" }]
          }
        ]
      }
    }
  ];

  const result = canonicalizeMainAnchors(cards, notes);
  assert.deepEqual(result.cards.a.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
    m1: { kind: "minor", x: 0.3, y: 0.4, createdBy: "u" }
  });
  assert.deepEqual(result.cards.b.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "b" }
  });
  assert.deepEqual(result.changed.map(card => card.noteId).sort(), ["a", "b"]);

  const links = result.links.find(entry => entry.noteId === "a").links;
  assert.equal(links[0].sourceAnchorId, "main");
  assert.equal(links[0].targetAnchorId, "main");
  assert.equal(links[1].targetAnchorId, "main");
  assert.deepEqual(links[1].routeAnchors, [{ noteId: "b", anchorId: "main" }]);
  assert.equal(links[1].sourceAnchorId, "m1", "minor anchor references are untouched");

  // The canonicalized registry has no unreferenced minors left to prune and keeps one main each.
  const pruned = pruneAnchorRegistry(result.cards, [{ ...notes[0], system: { links } }]);
  assert.deepEqual(pruned, []);
  assert.deepEqual(Object.keys(result.cards.a.anchors).filter(id => result.cards.a.anchors[id].kind === "main"),
    ["main"]);

  // Even when pruning is called directly, a referenced non-canonical main folds instead of
  // surviving as a second main under its legacy id.
  const direct = pruneAnchorRegistry({
    a: {
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        legacyMain: { kind: "main", x: 0.2, y: 0.3, createdBy: "u" }
      }
    }
  }, [{ id: "a", system: { links: [{ sourceAnchorId: "legacyMain" }] } }]);
  assert.deepEqual(direct[0].anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" }
  });
});

test("nearestMinorAnchor reuses only nearby minors, never the main pin", () => {
  const anchors = {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
    right: { kind: "minor", x: 1, y: 0.5, createdBy: "u" },
    far: { kind: "minor", x: 0, y: 0.5, createdBy: "u" }
  };
  const hit = nearestMinorAnchor(box(), anchors, { x: 1, y: 0.52 }, 4);
  assert.equal(hit.id, "right");
  assert.deepEqual(hit.point, { x: 100, y: 25, nx: 1, ny: 0, side: "right", index: 1 });
  assert.equal(nearestMinorAnchor(box(), anchors, { x: 1, y: 0.7 }, 4), null);
  assert.equal(nearestMinorAnchor(box(), anchors, { x: 0.5, y: 0 }, 4), null,
    "the main handle is never reused as a minor");
  assert.equal(nearestMinorAnchor(null, anchors, { x: 1, y: 0.5 }, 4), null);
});

test("mergeNearbyMinorAnchors folds stacked minors and rewrites every reference", () => {
  const cards = {
    a: {
      x: 0, y: 0, width: 100, height: 50, rotation: 0,
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        m1: { kind: "minor", x: 1, y: 0.5, createdBy: "u" },
        m2: { kind: "minor", x: 1, y: 0.52, createdBy: "u" },
        // 2 world px from m1: deliberately distinct at this tolerance.
        m3: { kind: "minor", x: 0.98, y: 0.5, createdBy: "u" }
      }
    },
    b: {
      x: 400, y: 0, width: 100, height: 50, rotation: 90,
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
        t1: { kind: "minor", x: 0, y: 0.5, createdBy: "u" },
        t2: { kind: "minor", x: 0, y: 0.52, createdBy: "u" }
      }
    },
    c: {
      x: 800, y: 0, width: 100, height: 50, rotation: 0,
      anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: "u" } }
    }
  };
  const notes = [{
    id: "a",
    system: {
      links: [
        { id: "l1", sourceAnchorId: "m2", targetId: "b", targetAnchorId: "t2" },
        {
          id: "l2", sourceAnchorId: "m3", targetId: "b", targetAnchorId: "t2",
          routeAnchors: [{ noteId: "a", anchorId: "m2" }, { noteId: "b", anchorId: "t2" }]
        }
      ]
    }
  }, { id: "b", system: { links: [] } }];
  const pinLinks = {
    tied: { source: "n:a:m2", target: "n:b:t2" },
    "free-to-distinct": { source: "p:free", target: "n:a:m3" }
  };

  const result = mergeNearbyMinorAnchors(cards, notes, { tolerance: 1.5, pinLinks });
  assert.deepEqual(Object.keys(result.cards.a.anchors).sort(), ["m1", "m3", "main"],
    "only the stacked minor folds; the distinct minor and main survive");
  assert.deepEqual(Object.keys(result.cards.b.anchors).sort(), ["main", "t1"],
    "rotation still measures the real world distance");
  assert.deepEqual(result.changed.map(entry => entry.noteId).sort(), ["a", "b"]);

  const [first, second] = result.links.find(entry => entry.noteId === "a").links;
  assert.equal(first.sourceAnchorId, "m1");
  assert.equal(first.targetAnchorId, "t1");
  assert.equal(second.sourceAnchorId, "m3", "a distinct pin reference is untouched");
  assert.equal(second.targetAnchorId, "t1");
  assert.deepEqual(second.routeAnchors, [{ noteId: "a", anchorId: "m1" }, { noteId: "b", anchorId: "t1" }]);
  assert.equal(result.links.find(entry => entry.noteId === "a").links.length, 2,
    "no link is dropped while references are repointed");

  assert.deepEqual(result.pinLinks, [
    { id: "tied", source: "n:a:m1", target: "n:b:t1" }
  ], "board pin links follow the canonical refs; unrelated refs stay untouched");

  // A second pass over the merged data is a no-op.
  const mergedNotes = result.links.find(entry => entry.noteId === "a").links;
  const again = mergeNearbyMinorAnchors(result.cards,
    [{ id: "a", system: { links: mergedNotes } }], { tolerance: 1.5, pinLinks });
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.links, []);
  assert.deepEqual(again.pinLinks, []);
  assert.equal(ANCHOR_MERGE_TOLERANCE, 2);
});

test("promoteLegacyLinkAnchors converts point-only endpoints and reuses nearby pins", () => {
  const cards = {
    a: { x: 0, y: 0, width: 200, height: 100, anchors: {
      main: { kind: "main", x: 0.5, y: 0, createdBy: "u" }
    } },
    b: { x: 300, y: 0, width: 200, height: 100, anchors: {} }
  };
  const notes = [
    { _id: "a", system: { attachment: { mainPinEnabled: true }, links: [
      { id: "one", targetId: "b", targetPoint: { x: 0, y: 0.5 } },
      { id: "two", targetId: "b", targetPoint: { x: 0, y: 0.5 } }
    ] } },
    { _id: "b", system: { attachment: { mainPinEnabled: true }, links: [] } }
  ];
  const result = promoteLegacyLinkAnchors(cards, notes);
  const links = result.links.find(entry => entry.noteId === "a").links;
  assert.ok(links[0].targetAnchorId);
  assert.equal(links[1].targetAnchorId, links[0].targetAnchorId,
    "the second legacy endpoint reuses the pin the first one created");
  assert.equal(result.cards.b.anchors[links[0].targetAnchorId].kind, "minor");
  assert.equal(result.changed.some(entry => entry.noteId === "b"), true);

  // An explicitly cleared id is not legacy data; it must keep the point/side fallback.
  const cleared = promoteLegacyLinkAnchors(cards, [
    { _id: "a", system: { links: [
      { id: "cleared", targetId: "b", targetPoint: { x: 0, y: 0.5 }, targetAnchorId: "" }
    ] } },
    { _id: "b", system: { links: [] } }
  ]);
  assert.equal(cleared.links.length, 0,
    "a deliberate empty anchor id stays empty and is not promoted");
});
