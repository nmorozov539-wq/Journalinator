// Runs tests/ui/smoke.mjs when jsdom is installed (`npm install`); skips otherwise, so
// `node --test tests/` works on a bare checkout.
import { test } from "node:test";

let hasJsdom = true;
try { await import("jsdom"); } catch { hasJsdom = false; }

if (hasJsdom) await import("./ui/smoke.mjs");
else test("UI smoke test (run `npm install` to enable)", { skip: true }, () => {});
