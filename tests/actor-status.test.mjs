import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actorIsDefeated, canObserveToken, defeatedStatusIds, normalizeActorRef, resolveActorStatus
} from "../scripts/actor-status.mjs";

/** Foundry Collections iterate values; a Map iterates entries, so give tests the same shape. */
function collection(items) {
  const map = new Map(items.map(item => [item.id, item]));
  map[Symbol.iterator] = function* () { yield* this.values(); };
  return map;
}

const actor = (id, { dead = false, visible = true } = {}) => ({
  id,
  statuses: new Set(dead ? ["dead"] : []),
  testUserPermission: () => visible
});

const token = (id, actorId, owner, { visible = true, scene } = {}) => ({
  id,
  actorId,
  actor: owner,
  parent: scene,
  testUserPermission: () => visible
});

function world({ actors = [], scenes = [], active = null, user = { isGM: true } } = {}) {
  return {
    game: {
      user,
      actors: new Map(actors.map(a => [a.id, a])),
      scenes: Object.assign(new Map(scenes.map(s => [s.id, s])), { active })
    },
    user
  };
}

test("actor refs keep only a real actor id and optional scene/token ids", () => {
  assert.deepEqual(normalizeActorRef({ actorId: " A ", sceneId: " S ", tokenId: " T " }),
    { actorId: "A", sceneId: "S", tokenId: "T" });
  assert.deepEqual(normalizeActorRef({ actorId: "A", tokenId: "T" }),
    { actorId: "A", sceneId: null, tokenId: null });
  assert.equal(normalizeActorRef({ sceneId: "S" }), null);
  assert.equal(normalizeActorRef(null), null);
});

test("dead status ids include the core default and the world's configured defeater", () => {
  assert.deepEqual(defeatedStatusIds({ specialStatusEffects: { DEFEATED: "defeated" } }), ["dead", "defeated"]);
  assert.deepEqual(defeatedStatusIds({}), ["dead"]);
});

test("an unscoped link reads the world actor", () => {
  const villain = actor("Villain000000001", { dead: true });
  const { game } = world({ actors: [villain] });
  assert.deepEqual(resolveActorStatus({ actorId: villain.id }, { game }),
    { state: "dead", actorId: villain.id, sceneId: null, tokenId: null });
  villain.statuses.clear();
  assert.equal(resolveActorStatus({ actorId: villain.id }, { game }), null);
});

test("a scene-scoped link follows that scene's tokens, not the world actor", () => {
  const base = actor("Guard00000000001");
  const sceneA = { id: "SceneA0000000001", name: "Gate", tokens: null };
  const sceneB = { id: "SceneB0000000001", name: "Camp", tokens: null };
  const guardA = token("TokenA0000000001", base.id, actor(base.id, { dead: true }), { scene: sceneA });
  const guardB = token("TokenB0000000001", base.id, actor(base.id), { scene: sceneB });
  sceneA.tokens = collection([guardA]);
  sceneB.tokens = collection([guardB]);
  const { game } = world({ actors: [base], scenes: [sceneA, sceneB], active: sceneB });

  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: sceneA.id }, { game }).tokenId, guardA.id,
    "the same base actor is dead in the gate");
  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: sceneB.id }, { game }), null,
    "and alive in the camp");
  assert.equal(resolveActorStatus({ actorId: base.id }, { game }), null,
    "the unscoped world actor is still healthy; no token state is guessed");
});

test("an absent token means no badge, not a dead actor", () => {
  const base = actor("Ghost00000000001");
  const scene = { id: "Scene0000000001", tokens: collection([]) };
  const { game } = world({ actors: [base], scenes: [scene] });
  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: scene.id }, { game }), null);
});

test("a token ref targets exactly one unlinked copy", () => {
  const base = actor("Twin00000000001");
  const scene = { id: "Scene0000000001", tokens: null };
  const dead = token("TokenDead0000001", base.id, actor(base.id, { dead: true }), { scene });
  const alive = token("TokenAlive000001", base.id, actor(base.id), { scene });
  scene.tokens = collection([dead, alive]);
  const { game } = world({ actors: [base], scenes: [scene] });

  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: scene.id }, { game }).tokenId, dead.id);
  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: scene.id, tokenId: alive.id }, { game }), null);
  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: scene.id, tokenId: dead.id }, { game })?.tokenId, dead.id);
});

test("tokens and world actors the viewer cannot observe never produce a badge", () => {
  const base = actor("Spy000000000001", { dead: true, visible: false });
  const scene = { id: "Scene0000000001", tokens: null };
  const hidden = token("TokenSpy00000001", base.id, actor(base.id, { dead: true }), { visible: false, scene });
  scene.tokens = collection([hidden]);
  const player = { isGM: false };
  const { game } = world({ actors: [base], scenes: [scene], user: player });

  assert.equal(canObserveToken(hidden, player), false);
  assert.equal(resolveActorStatus({ actorId: base.id }, { game }), null);
  assert.equal(resolveActorStatus({ actorId: base.id, sceneId: scene.id }, { game }), null);
});

test("status sets and arrays are both accepted", () => {
  assert.equal(actorIsDefeated({ statuses: new Set(["dead"]) }), true);
  assert.equal(actorIsDefeated({ statuses: ["dead"] }), true);
  assert.equal(actorIsDefeated({ statuses: new Set() }), false);
  assert.equal(actorIsDefeated(null), false);
});
