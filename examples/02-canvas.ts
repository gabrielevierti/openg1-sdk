/**
 * Canvas: anything beyond five lines of text is a bitmap you draw.
 *
 *   npx openg1 sim
 *   node examples/02-canvas.ts
 */
import { G1 } from "openg1";
import { connectSimulator } from "openg1/transports/ws";

const g1 = await G1.connect(connectSimulator());
const battery = await g1.info.battery();

const result = await g1.display.draw((c) => {
  // c.safe is the band of the panel this pair can actually show.
  const { y, height } = c.safe;
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  c.text(time, 16, y + (height - 76) / 2, { font: "xl" });
  c.line(236, y + 8, 236, y + height - 8);

  c.text("Next: stand-up", 252, y + 10, { font: "md" });
  c.text("in 12 minutes · Room 4", 252, y + 38, { font: "sm" });
  c.progress(252, y + 66, 260, 14, 0.8);

  c.battery(c.width - 44, y + 12, battery.lowest);
  c.text(`${battery.lowest}%`, c.width - 50, y + 10, { font: "sm", align: "right" });
  c.arrow(c.width - 30, y + height - 30, 36, 45);
});

console.log(`${result.bytesSent} bytes in ${result.packets} packets per arm, confirmed: ${result.ok}`);
await g1.disconnect();
