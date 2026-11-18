// Bundle the simulator page into one self-contained dist/web/index.html, and
// the browser build of the SDK into dist/openg1.browser.js.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root).pathname;

const page = await build({
  entryPoints: [path("src/web/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});
const script = page.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(path("src/web/index.html"), "utf8").replace("/*OPENG1_BUNDLE*/", () => script);
mkdirSync(path("dist/web"), { recursive: true });
writeFileSync(path("dist/web/index.html"), html);

await build({
  entryPoints: [path("src/browser.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: path("dist/openg1.browser.js"),
  legalComments: "none",
});

const kb = (n) => `${Math.round(n / 1024)} kB`;
console.log(`dist/web/index.html        ${kb(html.length)}`);
console.log(`dist/openg1.browser.js     ${kb(readFileSync(path("dist/openg1.browser.js")).length)}`);
