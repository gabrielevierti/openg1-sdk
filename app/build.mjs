// Bundle the app into www/index.html: one file, which is what Capacitor wraps
// and what any static host can serve. `--serve` rebuilds on request for development.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const here = (p) => new URL(p, import.meta.url).pathname;

async function bundle() {
  const result = await build({
    entryPoints: [here("src/main.tsx")],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: {
      "openg1/sim": here("../src/sim/index.ts"),
      "openg1/transports/capacitor": here("../src/transports/capacitor.ts"),
      "openg1/transports/web-bluetooth": here("../src/transports/web-bluetooth.ts"),
      "openg1/transports/ws": here("../src/transports/ws.ts"),
      openg1: here("../src/index.ts"),
    },
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  return readFileSync(here("index.html"), "utf8").replace("/*APP_BUNDLE*/", () => script);
}

if (process.argv.includes("--serve")) {
  const port = 5173;
  createServer(async (_req, res) => {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(await bundle());
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error.message ?? error));
    }
  }).listen(port, () => console.log(`OpenG1 app on http://localhost:${port} (rebuilt on every reload)`));
} else {
  const html = await bundle();
  mkdirSync(here("www"), { recursive: true });
  writeFileSync(here("www/index.html"), html);
  console.log(`www/index.html  ${Math.round(html.length / 1024)} kB`);
}
