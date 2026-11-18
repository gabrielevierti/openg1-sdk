/** Long text, a page at a time: right tap forward, left tap back, or on a timer. */
import { paginate } from "openg1";
import { untilAborted, type Activity } from "../activities.ts";

export interface TeleprompterControl {
  page: number;
  pages: number;
  /** Every page as it will appear, for a preview on the phone. */
  texts: string[];
  go(delta: number): void;
}

export function teleprompterActivity(options: {
  title: string;
  text: string;
  /** Seconds per page; 0 turns pages on taps only. */
  autoS: number;
  /** Text lines hidden at the top of this pair's panel, so each page is padded past them. */
  hiddenLines: number;
  /** Resume here instead of at the top. */
  startPage?: number;
  onControl(control: TeleprompterControl | null): void;
}): Activity {
  return {
    id: "teleprompter",
    title: options.title,
    async run({ g1, signal }) {
      const perScreen = Math.max(1, 5 - options.hiddenLines);
      const pages = paginate(options.text.replace(/\s*\n\s*/g, " ").trim() || " ", { linesPerScreen: perScreen });
      let page = Math.max(0, Math.min(pages.length - 1, options.startPage ?? 0));
      const texts = pages.map((lines) => lines.join(" "));
      let timer: ReturnType<typeof setTimeout> | null = null;

      const show = async () => {
        options.onControl({ page, pages: pages.length, texts, go });
        await g1.display.textPage("\n".repeat(options.hiddenLines) + pages[page]!.join("\n"), { page: page + 1, maxPage: pages.length });
        if (timer) clearTimeout(timer);
        if (options.autoS > 0 && page < pages.length - 1) timer = setTimeout(() => go(1), options.autoS * 1000);
      };
      const go = (delta: number) => {
        const next = Math.max(0, Math.min(pages.length - 1, page + delta));
        if (next === page || signal.aborted) return;
        page = next;
        void show().catch(() => {});
      };

      const off = g1.on("touch", (event) => {
        if (event.gesture === "single_tap") go(event.arm === "left" ? -1 : 1);
        if (event.gesture === "double_tap") go(-pages.length);
      });
      try {
        await show();
        await untilAborted(signal);
      } finally {
        off();
        if (timer) clearTimeout(timer);
        options.onControl(null);
      }
    },
  };
}
