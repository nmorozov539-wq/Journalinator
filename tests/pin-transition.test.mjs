import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const moduleCss = readFileSync(new URL("../styles/stylized.css", import.meta.url), "utf8");
// Foundry v14 ships the global button rule that eases left/top. Load the real file when this
// machine has a Foundry install; otherwise use the same rule so the cascade test stays portable.
const foundryCssPath = [
  process.env.FOUNDRY_V14_CSS,
  join(homedir(), "foundry-v14/resources/app/public/css/foundry2.css")
].filter(Boolean).find(path => existsSync(path));
const foundryCss = foundryCssPath
  ? readFileSync(foundryCssPath, "utf8")
  : "a.button, button { transition: 0.5s; }";
const foundryButtonRule = foundryCss.match(/a\.button,\s*button\s*\{[\s\S]*?\}/)?.[0]
  ?? "a.button, button { transition: 0.5s; }";

test("pin buttons and drag ghosts override Foundry's positional button transition", () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div class="jn-canvas"><div class="jn-pin-layer">
      <button id="cardPin" class="jn-pin jn-pin-main jn-pin-style-enamel"></button>
      <button id="boardPin" class="jn-pin jn-pin-main jn-pin-style-enamel jn-board-pin-control"></button>
      <button id="ghost" class="jn-pin jn-pin-main jn-pin-style-enamel jn-board-pin-control jn-moving-pin"></button>
    </div></div>
  </body></html>`, { pretendToBeVisual: true });
  for (const css of [foundryButtonRule, moduleCss]) {
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);
  }
  for (const id of ["cardPin", "boardPin", "ghost"]) {
    const pin = dom.window.document.getElementById(id);
    const computed = dom.window.getComputedStyle(pin);
    assert.equal(computed.transition, "none", `${id} has no transitioned properties`);
    assert.ok(!computed.transitionDuration
      || computed.transitionDuration.split(",").every(value => value.trim() === "0s"),
    `${id} has no positional easing`);
  }
});
