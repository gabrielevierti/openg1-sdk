/**
 * Everything a web page needs, in one bundle: the SDK, the simulator, and the
 * two transports that work in a browser. Built to dist/openg1.browser.js.
 *
 *     <script type="module">
 *       import { G1, WebBluetoothPairing, simulate } from "./openg1.browser.js";
 *     </script>
 */
export * from "./index.ts";
export * from "./sim/index.ts";
export * from "./transports/ws.ts";
export * from "./transports/web-bluetooth.ts";
