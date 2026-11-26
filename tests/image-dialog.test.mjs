import { test } from "node:test";
import assert from "node:assert/strict";

let config;
globalThis.foundry = {
  applications: { api: { DialogV2: { wait: async captured => { config = captured; return "worlds/w/pick.webp"; } } } },
  utils: { escapeHTML: value => String(value) }
};

const { promptImageSource } = await import("../scripts/app/image-dialog.mjs");

test("image dialog offers OK and a null-returning cancel", async () => {
  const result = await promptImageSource("Image", "worlds/w/old.webp", "clear to remove");
  assert.equal(result, "worlds/w/pick.webp");
  assert.equal(config.window.title, "Image");
  assert.match(config.content, /value="worlds\/w\/old\.webp"/);
  assert.match(config.content, /clear to remove/);
  assert.deepEqual(config.buttons.map(button => button.action), ["ok", "cancel"]);
  assert.equal(config.buttons[1].callback(), null);

  const button = { form: { elements: { value: { value: "  modules/x/y.webp  " } } } };
  assert.equal(config.buttons[0].callback({}, button), "modules/x/y.webp");
});

test("the browse button is wired to the file picker", async () => {
  let listener = null;
  const browse = { addEventListener: (type, callback) => { assert.equal(type, "click"); listener = callback; } };
  const input = { value: "worlds/w/old.webp", focus() {}, select() {}, dispatchEvent() {} };
  config.render({}, {
    form: { elements: { value: input } },
    element: { querySelector: selector => selector === ".jn-image-browse" ? browse : null }
  });
  assert.equal(typeof listener, "function");
  assert.doesNotThrow(() => listener({ preventDefault() {} }));
});
