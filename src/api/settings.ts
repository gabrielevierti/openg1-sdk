/** Persistent device configuration. */
import { ButtonAction } from "../generated.ts";
import { sleep } from "../bytes.ts";
import * as cmd from "../commands.ts";
import { ProtocolError } from "../errors.ts";
import type { Response, Session } from "../session.ts";

export class Settings {
  readonly #s: Session;
  constructor(session: Session) {
    this.#s = session;
  }

  silentMode(enabled: boolean): Promise<Response> {
    return this.#s.send(cmd.setSilentMode(enabled));
  }
  async getSilentMode(): Promise<boolean> {
    const body = (await this.#s.send(cmd.getSilentMode())).payload;
    if (body.length < 2) throw new ProtocolError("short silent-mode reply");
    return body[1] === 0x0c;
  }

  /** Tilt at which the display wakes, 0..60 degrees. */
  headupAngle(degrees: number): Promise<Response> {
    return this.#s.send(cmd.setHeadupAngle(degrees));
  }
  async getHeadupAngle(): Promise<number> {
    const body = (await this.#s.send(cmd.getHeadupAngle())).payload;
    if (body.length < 3) throw new ProtocolError("short head-up reply");
    return body[2]!;
  }

  /** When on, the glasses emit `wear` events as they go on and off. */
  wearDetection(enabled: boolean): Promise<Response> {
    return this.#s.send(cmd.setWearDetection(enabled));
  }
  async getWearDetection(): Promise<boolean> {
    const body = (await this.#s.send(cmd.getWearDetection())).payload;
    if (body.length < 2) throw new ProtocolError("short wear-detection reply");
    return body[1] !== 0;
  }

  /** What looking up does. See ButtonAction. */
  headupAction(action: number = ButtonAction.DASHBOARD): Promise<Response> {
    return this.#s.send(cmd.setButtonConfig(action));
  }
  /** What a double tap does. */
  doubleTapAction(action: number = ButtonAction.DASHBOARD): Promise<Response> {
    return this.#s.send(cmd.setGestureConfig(action));
  }

  /** Re-zero head tracking. Keep still and level while this runs. */
  async calibrate(settleMs = 1000): Promise<void> {
    await this.#s.send(cmd.resetZeroDegree());
    await sleep(settleMs);
    await this.#s.send(cmd.calibration(0x02, [0x01, 0x00]));
  }

  language(code: number): Promise<Response> {
    return this.#s.send(cmd.setLanguage(code));
  }
  debugMode(enabled: boolean): Promise<Response> {
    return this.#s.send(cmd.setDebugMode(enabled));
  }

  /** Reboot both arms. The link drops; reconnect afterwards. */
  async reboot(): Promise<void> {
    await this.#s.send(cmd.hardReset(), { strict: false });
  }
}
