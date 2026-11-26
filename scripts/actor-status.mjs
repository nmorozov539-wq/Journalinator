/**
 * Read-only actor status for note cards.
 *
 * This is deliberately a *derived* view: nothing here writes to the shared journal. A note may
 * point at an actor (and optionally a scene/token); the badge is computed from the documents the
 * current client can already see. That keeps a linked note honest when the same unlinked actor is
 * alive in one scene and dead in another, and it means a player never learns a status they could
 * not read from the canvas in the first place.
 *
 * "Dead" is read from actor status effects, not from a system-specific HP path. Core exposes
 * `CONST.specialStatusEffects.DEFEATED` (normally `"dead"`); systems and modules can change it,
 * so both that id and the core default are accepted.
 */

export const DEFAULT_DEFEATED_STATUS = "dead";

/** A stored reference is only meaningful when it names an actor. */
export function normalizeActorRef(input) {
  if (!input || typeof input !== "object") return null;
  const actorId = typeof input.actorId === "string" ? input.actorId.trim() : "";
  if (!actorId) return null;
  const sceneId = typeof input.sceneId === "string" && input.sceneId.trim() ? input.sceneId.trim() : null;
  const tokenId = typeof input.tokenId === "string" && input.tokenId.trim() ? input.tokenId.trim() : null;
  return { actorId, sceneId, tokenId: sceneId ? tokenId : null };
}

/** The status ids that mean "defeated" in this world. */
export function defeatedStatusIds(constants = globalThis.CONST) {
  const ids = new Set([DEFAULT_DEFEATED_STATUS]);
  const configured = constants?.specialStatusEffects?.DEFEATED;
  if (typeof configured === "string" && configured) ids.add(configured);
  return [...ids];
}

/** `Actor#statuses` is a Set in Foundry v14, but tests and older shims may hand us an array. */
export function actorIsDefeated(actor, statusIds = defeatedStatusIds()) {
  const statuses = actor?.statuses;
  if (!statuses) return false;
  return statusIds.some(id => {
    if (typeof statuses.has === "function") return statuses.has(id);
    if (Array.isArray(statuses)) return statuses.includes(id);
    return false;
  });
}

/**
 * A token the current user cannot observe must not contribute a badge. Foundry's token
 * permission test already folds in actor ownership and secret dispositions.
 */
export function canObserveToken(token, user = globalThis.game?.user) {
  if (!token || !user) return false;
  if (user.isGM) return true;
  if (typeof token.testUserPermission !== "function") return false;
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  return token.testUserPermission(user, observer);
}

function canObserveActor(actor, user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  if (typeof actor.testUserPermission !== "function") return false;
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  return actor.testUserPermission(user, observer);
}

function tokensForActor(scene, actorId) {
  if (!scene?.tokens) return [];
  return Array.from(scene.tokens).filter(token => token?.actorId === actorId);
}

/**
 * Resolve the badge state for a stored `system.actorRef`.
 *
 * - `{ actorId }`: the world actor's own status. Correct for linked actors.
 * - `{ actorId, sceneId }`: any visible token of that actor in that scene. This is the mode that
 *   answers "alive here, dead there" for unlinked tokens.
 * - `{ actorId, sceneId, tokenId }`: exactly one token, for worlds that put several unlinked
 *   copies of one actor in the same scene.
 *
 * Returns `{ state: "dead", actorId, sceneId, tokenId }` or null.
 */
export function resolveActorStatus(ref, {
  game = globalThis.game,
  scene = globalThis.canvas?.scene ?? game?.scenes?.active ?? null,
  user = game?.user,
  statusIds = defeatedStatusIds()
} = {}) {
  const normalized = normalizeActorRef(ref);
  if (!normalized || !game) return null;
  const baseActor = game.actors?.get?.(normalized.actorId) ?? null;

  if (normalized.tokenId) {
    const targetScene = normalized.sceneId ? game.scenes?.get?.(normalized.sceneId) : scene;
    const token = targetScene?.tokens?.get?.(normalized.tokenId) ?? null;
    if (!token || token.actorId !== normalized.actorId || !canObserveToken(token, user)) return null;
    return actorIsDefeated(token.actor, statusIds)
      ? { state: "dead", actorId: normalized.actorId, sceneId: targetScene.id ?? normalized.sceneId, tokenId: token.id }
      : null;
  }

  if (normalized.sceneId) {
    const targetScene = game.scenes?.get?.(normalized.sceneId);
    if (!targetScene) return null;
    const visible = tokensForActor(targetScene, normalized.actorId).filter(token => canObserveToken(token, user));
    if (!visible.length) return null;
    const dead = visible.find(token => actorIsDefeated(token.actor, statusIds));
    return dead ? { state: "dead", actorId: normalized.actorId, sceneId: targetScene.id ?? normalized.sceneId, tokenId: dead.id } : null;
  }

  if (!baseActor || !canObserveActor(baseActor, user)) return null;
  return actorIsDefeated(baseActor, statusIds)
    ? { state: "dead", actorId: normalized.actorId, sceneId: null, tokenId: null }
    : null;
}

