import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createModelGesture } = await jiti.import(new URL("./gesture.ts", import.meta.url).pathname);
const press = "\x1b[46;5u", repeat = "\x1b[46;5:2u", release = "\x1b[46;5:3u";

function harness() {
  let callback, opens = 0, focused = true, supported = true, time = 0;
  const gesture = createModelGesture({
    canStart: () => supported && focused,
    stillFocused: () => focused,
    open: () => { opens++; },
    setTimer: (fn, delay) => { assert.equal(delay, 200); callback = fn; return 1; },
    clearTimer: () => { callback = undefined; },
    now: () => time,
  });
  gesture.input("\x1b[97;1:3u"); // any release proves event reporting
  return { gesture, fire: () => { const fn = callback; callback = undefined; fn?.(); },
    opens: () => opens, focus: (value) => { focused = value; }, support: (value) => { supported = value; }, time: (value) => { time = value; } };
}

test("taps dispatch exactly one native press on release; rapid taps work", () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(h.gesture.input(press), { consume: true });
    assert.deepEqual(h.gesture.input(release), { data: press });
    h.fire();
  }
  assert.equal(h.opens(), 0);
});

test("hold opens once, consumes repeats and release, even after closing", () => {
  const h = harness();
  h.gesture.input(press);
  assert.deepEqual(h.gesture.input(repeat), { consume: true });
  h.fire();
  assert.equal(h.opens(), 1);
  assert.deepEqual(h.gesture.input(repeat), { consume: true });
  assert.deepEqual(h.gesture.input(release), { consume: true });
  h.fire();
  assert.equal(h.opens(), 1);
});

test("press before any observed release keeps native cycling", () => {
  let opened = 0;
  const gesture = createModelGesture({ canStart: () => true, stillFocused: () => true, open: () => { opened++; },
    setTimer: () => 1, clearTimer() {} });
  assert.equal(gesture.input(press), undefined);
  assert.equal(gesture.input(release), undefined);
  assert.deepEqual(gesture.input(press), { consume: true });
  assert.equal(opened, 0);
});

test("legacy, unsupported, unrelated keys, backward and paste pass through", () => {
  const h = harness();
  h.support(false);
  assert.equal(h.gesture.input(press), undefined);
  h.fire();
  h.support(true);
  for (const data of [".", "\x1b[46;6u", "\x1b[200~\x1b[46;5u\x1b[201~", repeat, release]) {
    assert.equal(h.gesture.input(data), undefined, JSON.stringify(data));
  }
  assert.equal(h.opens(), 0);
});

test("release at the threshold opens once even when timer is delayed", () => {
  const h = harness();
  h.gesture.input(press);
  h.time(200);
  assert.deepEqual(h.gesture.input(release), { consume: true });
  h.fire();
  assert.equal(h.opens(), 1);
});

test("period release still ends the gesture if Ctrl was released first", () => {
  const h = harness();
  h.gesture.input(press);
  assert.deepEqual(h.gesture.input("\x1b[46;1:3u"), { data: press });
  h.gesture.input(press);
  h.fire();
  assert.deepEqual(h.gesture.input("\x1b[46;1:3u"), { consume: true });
});

test("focus loss and shutdown cancel effects", () => {
  const h = harness();
  h.gesture.input(press);
  h.focus(false);
  h.fire();
  assert.equal(h.opens(), 0);
  assert.deepEqual(h.gesture.input(release), { consume: true });
  h.focus(true);
  h.gesture.input(press);
  h.gesture.reset();
  h.fire();
  assert.equal(h.opens(), 0);
});
