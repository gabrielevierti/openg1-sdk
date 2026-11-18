/** Phone notifications forwarded to the glasses. */
import type { Bytes } from "../bytes.ts";
import * as cmd from "../commands.ts";
import type { Session } from "../session.ts";

export const CHUNK_LIMIT = 180;

/** Split a JSON document for transport. Bytes, not characters — the firmware counts bytes. */
export function chunkJson(document: Bytes, limit: number = CHUNK_LIMIT): Bytes[] {
  const out: Bytes[] = [];
  for (let i = 0; i < document.length; i += limit) out.push(document.subarray(i, i + limit));
  return out.length ? out : [new Uint8Array(0)];
}

export interface NotifyOptions {
  title: string;
  message?: string;
  subtitle?: string;
  appId?: string;
  appName?: string;
  /** Unix seconds. */
  timestamp?: number;
}

export class Notifications {
  readonly #s: Session;
  constructor(session: Session) {
    this.#s = session;
  }

  /** Set the allow-list of apps whose notifications get through. */
  async configure(config: cmd.NotificationConfig = {}): Promise<void> {
    const chunks = chunkJson(cmd.notificationConfigJson(config), this.#limit());
    await this.#s.sendAll(chunks.map((c, i) => cmd.notificationConfigPacket(c, i, chunks.length)));
  }

  /** Push one notification card to the glasses. */
  async notify(o: NotifyOptions): Promise<void> {
    const document = cmd.notificationJson({
      appId: o.appId ?? "dev.openg1.sdk",
      appName: o.appName ?? "OpenG1",
      title: o.title,
      subtitle: o.subtitle,
      message: o.message,
      timestamp: o.timestamp,
    });
    const chunks = chunkJson(document, this.#limit());
    await this.#s.sendAll(chunks.map((c, i) => cmd.notificationPacket(c, i, chunks.length)));
  }

  async clear(): Promise<void> {
    await this.#s.send(cmd.clearNotification());
  }

  #limit(): number {
    return Math.max(32, Math.min(CHUNK_LIMIT, this.#s.maxData({ extraHeader: 2 })));
  }
}
