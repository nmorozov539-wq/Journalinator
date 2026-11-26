import { test } from "node:test";
import assert from "node:assert/strict";

import { pickImage } from "../scripts/image-picker.mjs";

class FakePicker {
  static instances = [];
  constructor(options) {
    this.options = options;
    FakePicker.instances.push(this);
  }
  browse() { this.browsed = true; }
}

function fakeInput(value = "") {
  const events = [];
  return {
    value,
    events,
    focus() { this.focused = true; },
    select() { this.selected = true; },
    dispatchEvent(event) { events.push(event.type); return true; }
  };
}

test("pickImage uses the v14 FilePicker implementation and fills the input", () => {
  globalThis.foundry = { applications: { apps: { FilePicker: { implementation: FakePicker } } } };
  const input = fakeInput("worlds/w/old.png");
  pickImage(input);
  const picker = FakePicker.instances.at(-1);
  assert.equal(picker.options.type, "image");
  assert.equal(picker.options.current, "worlds/w/old.png");
  assert.equal(picker.browsed, true);
  picker.options.callback("modules/fvtt-journalinator/assets/cork.webp");
  assert.equal(input.value, "modules/fvtt-journalinator/assets/cork.webp");
  assert.deepEqual(input.events, ["change"]);
  assert.equal(input.focused, true);
});

test("pickImage falls back to the legacy global FilePicker", () => {
  globalThis.foundry = {};
  globalThis.FilePicker = FakePicker;
  try {
    const input = fakeInput();
    pickImage(input);
    const picker = FakePicker.instances.at(-1);
    assert.equal(picker.options.type, "image");
    assert.equal(picker.browsed, true);
  } finally {
    delete globalThis.FilePicker;
  }
});

test("pickImage is a no-op when no picker exists or no input is given", () => {
  globalThis.foundry = {};
  assert.doesNotThrow(() => pickImage(fakeInput()));
  assert.doesNotThrow(() => pickImage(null));
});
