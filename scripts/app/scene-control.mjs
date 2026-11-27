/**
 * Pure helpers for the Journalinator scene-control button.
 *
 * Foundry's SceneControls calls `onChange(event, active)` twice for a control switch: once with
 * `active === false` for the control being left, and once with `active === true` for the new one.
 * Journalinator must only open on the activating call; otherwise selecting any other left-hand
 * control would reopen the journal over the canvas.
 */

/** Open only for the activating change, never for the deactivating one. */
export function shouldOpenSceneControl(active) {
  return active === true;
}

function controlList(controls) {
  if (controls instanceof Map) return [...controls.values()];
  if (Array.isArray(controls)) return controls;
  return controls && typeof controls === "object" ? Object.values(controls) : [];
}

function firstTool(control) {
  const tools = control?.tools;
  if (!tools || typeof tools !== "object") return null;
  const list = tools instanceof Map ? [...tools.values()] : Object.values(tools);
  // Foundry sorts tools by order before rendering; mirror that here so the fallback picks the
  // same tool a user would see first.
  list.sort((a, b) => (a?.order ?? Number.MAX_SAFE_INTEGER) - (b?.order ?? Number.MAX_SAFE_INTEGER));
  return list.find(tool => typeof tool?.name === "string" && tool.name)?.name ?? null;
}

function hasTool(tools, name) {
  return tools instanceof Map ? tools.has(name) : Object.hasOwn(tools, name);
}

function hasTools(tools) {
  return tools instanceof Map ? tools.size > 0 : Object.keys(tools).length > 0;
}

/**
 * Resolve the activation target used when Journalinator closes. Tokens/select is the normal
 * target; if that control is unavailable (or a module removed it) use the first usable control
 * and tool instead. Returns `null` when SceneControls has no usable control at all.
 */
export function defaultControlTarget(controls, preferred = { control: "tokens", tool: "select" }) {
  const usable = controlList(controls).filter(control =>
    control && typeof control.name === "string" && control.name
    && control.tools && typeof control.tools === "object"
    && hasTools(control.tools));
  if (!usable.length) return null;

  const preferredControl = preferred?.control
    ? usable.find(control => control.name === preferred.control)
    : null;
  const control = preferredControl ?? usable[0];

  const preferredTool = control === preferredControl && preferred?.tool
    && hasTool(control.tools, preferred.tool)
    ? preferred.tool : null;
  const tool = preferredTool
    ?? (typeof control.activeTool === "string" && hasTool(control.tools, control.activeTool)
      ? control.activeTool : null)
    ?? firstTool(control);

  return tool ? { control: control.name, tool } : null;
}
