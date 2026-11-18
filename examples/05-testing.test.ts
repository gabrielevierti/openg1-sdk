/**
 * Testing an app without glasses, or a simulator process: the simulator is a
 * library, so a test creates one, drives it, and asserts on what it shows.
 *
 *   node --test examples/05-testing.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runApp } from "openg1";
import { simulate } from "openg1/sim";
import Timer from "./04-app.ts";

test("the timer starts on a tap and resets on a double tap", async () => {
  // This pair hides the top 23 rows; the simulator will complain if we draw there.
  const { g1, sim } = await simulate({ profile: { hiddenTop: 23 } });
  const app = new Timer();
  app.intervalMs = 10; // a fast clock for the test
  const stop = new AbortController();
  const done = runApp(app, g1, { signal: stop.signal });

  // Let handlers run, then wait until everything they sent has reached both arms.
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await g1.session.idle();
  };

  try {
    await settle();
    assert.equal(app.active, false);
    sim.assertReadable(); // nothing clipped, nothing in the hidden rows

    sim.tap("right");
    await settle();
    assert.equal(app.active, true);
    assert.ok(app.seconds < 25 * 60, "time is passing");

    sim.tap("right", 2);
    await settle();
    assert.equal(app.seconds, 25 * 60);
    assert.equal(sim.left.display.kind, "image");
    assert.equal(sim.armsInSync, true, "both lenses show the same frame");
    sim.assertReadable();
  } finally {
    stop.abort();
    await done;
    await g1.disconnect();
  }
});
