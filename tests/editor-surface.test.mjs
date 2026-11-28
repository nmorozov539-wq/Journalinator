import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "CompositionEvent", "Range", "NodeFilter"
]) {
  globalThis[key] = dom.window[key];
}

const { SourceSurface, LARGE_PASTE_THRESHOLD } = await import("../scripts/editor/source-surface.mjs");
const { parseDocument } = await import("../scripts/document/parse.mjs");

function makeSurface(options = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const surface = new SourceSurface(options);
  surface.mount(host);
  return { host, surface, textarea: surface.textarea };
}

function clearBody() {
  document.body.replaceChildren();
}

function paste(text) {
  const event = new Event("paste", { bubbles: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text }
  });
  return event;
}

test("mounts, reads/writes value, selection, insert, replace and focusRange", () => {
  clearBody();
  const { surface, textarea } = makeSurface();
  surface.setValue("abc\ndef");
  assert.equal(surface.getValue(), "abc\ndef");

  surface.setSelection(1, 4);
  assert.deepEqual(surface.getSelection(), { start: 1, end: 4, direction: "none" });
  surface.focus();
  assert.equal(document.activeElement, textarea);

  surface.insertText("XY");
  assert.equal(surface.getValue(), "aXYdef");

  surface.replaceRange(0, 1, "Z");
  assert.equal(surface.getValue(), "ZXYdef");

  surface.focusRange(2, 4);
  assert.equal(textarea.selectionStart, 2);
  assert.equal(textarea.selectionEnd, 4);
  assert.equal(document.activeElement, textarea);
});

test("setValue preserves selection when asked", () => {
  clearBody();
  const { surface, textarea } = makeSurface();
  surface.setValue("abcdef");
  surface.focusRange(2, 4);
  surface.setValue("abcdefg", { preserveSelection: true });
  assert.deepEqual(surface.getSelection(), { start: 2, end: 4, direction: "none" });
  surface.setValue("xy", { preserveSelection: false });
  assert.equal(textarea.selectionStart, 0);
});

test("title line gets H1 styling and a faint legible marker", () => {
  clearBody();
  const { surface } = makeSurface();
  surface.setValue("# The river crossing\nMeet before sunrise.");
  surface.updateParsed(parseDocument(surface.getValue()));

  const lines = [...surface.mirrorInner.querySelectorAll(".jn-source-line")];
  assert.ok(lines[0].classList.contains("jn-source-title"));
  assert.equal(lines[0].style.fontSize, "26px");
  const marker = lines[0].querySelector(".jn-source-title-marker");
  assert.equal(marker.textContent, "# ");
  assert.equal(marker.style.opacity, "0.45");
  assert.equal(lines[1].classList.contains("jn-source-title"), false);
  assert.equal(lines[1].textContent, "Meet before sunrise.");
});

test("closing hashes are not confused with the title marker", () => {
  clearBody();
  const { surface } = makeSurface();
  surface.setValue("# Title ###\nbody");
  surface.updateParsed(parseDocument(surface.getValue()));
  const marker = surface.mirrorInner.querySelector(".jn-source-title-marker");
  assert.equal(marker.textContent, "# ");
  assert.equal(surface.mirrorInner.querySelector(".jn-source-title-text").textContent, "Title ###");
});

test("mirror uses text nodes and never injects HTML", () => {
  clearBody();
  const { surface } = makeSurface();
  const source = '<img src=x onerror="globalThis.pwned=1"> & <b>bold</b>';
  surface.setValue(source);
  surface.updateParsed(parseDocument(source));
  assert.equal(surface.mirrorInner.querySelector("img"), null);
  assert.equal(surface.mirrorInner.querySelector("b"), null);
  assert.equal(surface.mirrorInner.textContent, source);
  assert.equal(globalThis.pwned, undefined);
});

test("scroll position is mirrored as a translate", () => {
  clearBody();
  const { surface, textarea } = makeSurface();
  surface.setValue("one\ntwo\nthree");
  textarea.scrollTop = 25;
  textarea.scrollLeft = 3;
  textarea.dispatchEvent(new Event("scroll"));
  assert.match(surface.mirrorInner.style.transform, /translate\(-3px, -25px\)/);
});

test("composition suppresses the composing flag until compositionend", () => {
  clearBody();
  const events = [];
  let started = 0;
  let ended = null;
  const { surface, textarea } = makeSurface({
    onInput: event => events.push(event),
    onCompositionStart: () => { started += 1; },
    onCompositionEnd: value => { ended = value; }
  });

  textarea.dispatchEvent(new Event("compositionstart"));
  textarea.value = "に";
  textarea.dispatchEvent(new Event("input"));
  assert.equal(started, 1);
  assert.equal(events.at(-1).composing, true);
  assert.equal(surface.isComposing(), true);

  textarea.dispatchEvent(new Event("compositionend"));
  assert.equal(surface.isComposing(), false);
  assert.equal(ended, "に");
});

test("caret stays opaque ink while the textarea's own glyphs are transparent", () => {
  clearBody();
  const { textarea } = makeSurface();
  assert.equal(textarea.style.color, "transparent");
  assert.notEqual(textarea.style.caretColor, "currentColor");
  assert.match(textarea.style.caretColor, /--jn-paper-ink/);
});

test("IME composition hides the mirror and shows ink text until compositionend", () => {
  clearBody();
  const { surface, textarea } = makeSurface();
  surface.setValue("base");
  textarea.value = "baseに";
  textarea.setSelectionRange(2, 4, "backward");

  textarea.dispatchEvent(new Event("compositionstart"));
  assert.equal(surface.isComposing(), true);
  assert.equal(surface.mirror.style.opacity, "0");
  assert.match(textarea.style.color, /--jn-paper-ink/);
  assert.equal(textarea.value, "baseに");
  assert.deepEqual(surface.getSelection(), { start: 2, end: 4, direction: "backward" });

  textarea.dispatchEvent(new Event("compositionend"));
  assert.equal(surface.isComposing(), false);
  assert.equal(surface.mirror.style.opacity, "1");
  assert.equal(textarea.style.color, "transparent");
  assert.equal(textarea.value, "baseに");
  assert.deepEqual(surface.getSelection(), { start: 2, end: 4, direction: "backward" });
});

test("paste publishes a large-paste event id only at the code-point threshold", () => {
  clearBody();
  const pastes = [];
  const { textarea } = makeSurface({ onPaste: event => pastes.push(event) });

  textarea.dispatchEvent(paste("a".repeat(LARGE_PASTE_THRESHOLD - 1)));
  assert.equal(pastes.length, 0);

  textarea.dispatchEvent(paste("😀".repeat(LARGE_PASTE_THRESHOLD)));
  assert.equal(pastes.length, 1);
  assert.match(pastes[0].id, /^paste-large:/);
  assert.equal(pastes[0].length, LARGE_PASTE_THRESHOLD);
});

test("caret point mapping chooses the nearest line and proportional offset", () => {
  clearBody();
  const { surface } = makeSurface();
  surface.setValue("abcd\nef");
  surface.updateParsed(parseDocument(surface.getValue()));
  const lines = [...surface.mirrorInner.querySelectorAll(".jn-source-line")];
  lines[0].getBoundingClientRect = () => ({ left: 0, right: 100, width: 100, top: 0, bottom: 24, height: 24 });
  lines[1].getBoundingClientRect = () => ({ left: 0, right: 100, width: 100, top: 24, bottom: 48, height: 24 });

  assert.equal(surface.caretOffsetFromPoint(50, 12), 2);
  assert.equal(surface.caretOffsetFromPoint(95, 36), 7);
  assert.equal(surface.caretOffsetFromPoint(-20, 12), 0);
});
