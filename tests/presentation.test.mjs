/**
 * The v2 runtime keeps only presentation helpers that still feed shared/private cards and
 * threads: safe attachment numbers, normalized link cosmetics and bounded anchor registries.
 * Legacy note labels, headings, blocks, kinds, secrets and migration are intentionally gone, so
 * their old suites are not kept here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ATTACHMENT, defaultLinkCosmetics, resolveAttachment, resolveLinkCosmetics,
  sanitizeCardAnchors, sanitizeCardAnchorsWithMain
} from "../scripts/presentation.mjs";

test("attachment defaults and clamping are safe", () => {
  assert.deepEqual(resolveAttachment({}), DEFAULT_ATTACHMENT);
  assert.deepEqual(
    resolveAttachment({
      system: { attachment: { mainPinEnabled: false, mainSnapRadius: 999, minorSnapRadius: -5, pinStyle: "brass" } }
    }),
    { mainPinEnabled: false, mainSnapRadius: 64, minorSnapRadius: 0, pinStyle: "brass" }
  );
  assert.deepEqual(
    resolveAttachment({ system: { attachment: { mainSnapRadius: "far", minorSnapRadius: "near", pinStyle: "rope" } } }),
    DEFAULT_ATTACHMENT
  );
});

test("link cosmetics resolve legacy dashed lines and clamp experimental bounds", () => {
  assert.deepEqual(defaultLinkCosmetics(), {
    material: "linen", thickness: 2.6, slack: 0.09, pattern: "continuous",
    ends: "standard", secondaryColor: ""
  });
  assert.equal(resolveLinkCosmetics({ lineStyle: "dashed" }).pattern, "interrupted");
  assert.deepEqual(
    resolveLinkCosmetics({
      material: "double", thickness: 0, slack: 1, pattern: "alternating",
      ends: "loose", secondaryColor: "link2"
    }),
    {
      material: "double", thickness: 0.8, slack: 0.25, pattern: "alternating",
      ends: "loose", secondaryColor: "link2"
    }
  );
  assert.deepEqual(resolveLinkCosmetics({ material: "rope", thickness: "wide" }), defaultLinkCosmetics());
  assert.equal(resolveLinkCosmetics({ secondaryColor: "url(javascript:alert(1))" }).secondaryColor, "");
  assert.equal(resolveLinkCosmetics({ secondaryColor: "#d6a45c" }).secondaryColor, "link2");
  assert.equal(resolveLinkCosmetics({ secondaryColor: "LINK3" }).secondaryColor, "link3");
});

test("card anchor sanitizing enforces bounds and the main-anchor convention", () => {
  assert.deepEqual(sanitizeCardAnchors({
    main: { kind: "main", x: 0.1, y: 0.9, createdBy: "u" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    badKind: { kind: "other", x: 0.1, y: 0.1 },
    offCard: { kind: "minor", x: 2, y: 0.5 },
    ["i".repeat(101)]: { kind: "minor", x: 0.1, y: 0.1 }
  }), {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  });
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) =>
    [`a${i}`, { kind: "minor", x: 0.5, y: 0.5 }]));
  assert.equal(Object.keys(sanitizeCardAnchors(many)).length, 256);

  // Non-canonical mains fold to the single `main` key; the following mains are dropped.
  assert.deepEqual(sanitizeCardAnchors({
    legacyMain: { kind: "main", x: 0.1, y: 0.1, createdBy: "first" },
    anotherMain: { kind: "main", x: 0.9, y: 0.9, createdBy: "second" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  }), {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "first" }
  });
  // Hostile prototype/path keys never become registry entries.
  const hostile = JSON.parse('{"constructor":{"kind":"minor","x":0.1,"y":0.1},"a.b":{"kind":"minor","x":0.1,"y":0.1},"ok":{"kind":"minor","x":0.1,"y":0.1}}');
  assert.deepEqual(sanitizeCardAnchors(hostile), {
    ok: { kind: "minor", x: 0.1, y: 0.1, createdBy: "" }
  });
});

test("sanitizing with a main pin adds one canonical anchor unless disabled", () => {
  assert.deepEqual(sanitizeCardAnchorsWithMain({
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  }, true, "author"), {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "author" }
  });
  assert.deepEqual(sanitizeCardAnchorsWithMain({
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  }, false, "author"), {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  });
  assert.deepEqual(sanitizeCardAnchorsWithMain({
    main: { kind: "main", x: 0.9, y: 0.9, createdBy: "first" }
  }, true, "second"), {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "first" }
  });
});
