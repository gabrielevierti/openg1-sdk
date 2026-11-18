/**
 * Hello: connect, show text, react to gestures.
 *
 *   npx openg1 sim                 # in one terminal
 *   node examples/01-hello.ts      # in another
 *
 * To run this on real glasses from a computer, swap the two transport lines
 * for noble (see docs/PLATFORMS.md). Nothing else changes.
 */
import { G1 } from "openg1";
import { connectSimulator } from "openg1/transports/ws";

const g1 = await G1.connect(connectSimulator());

await g1.display.text("Hello from openg1\nTap a touch bar, or look up.");
console.log("battery", await g1.info.battery());

g1.on("touch", async (event) => {
  console.log(`${event.arm} ${event.gesture}`);
  await g1.display.text(`${event.arm} arm: ${event.gesture.replace("_", " ")}`);
});
g1.on("head", (event) => console.log(event.up ? "looked up" : "looked down"));
g1.on("disconnect", () => process.exit(0));

console.log("Open http://127.0.0.1:8765 and use the touch bars. Ctrl-C to quit.");
process.on("SIGINT", async () => {
  await g1.display.clear();
  await g1.disconnect();
  process.exit(0);
});
