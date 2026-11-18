/** Every error the SDK throws on purpose derives from OpenG1Error. */

export class OpenG1Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A packet that cannot be built or parsed. */
export class ProtocolError extends OpenG1Error {}

/** The radio (or socket) failed. */
export class TransportError extends OpenG1Error {}

export class NotConnectedError extends TransportError {}

export class DiscoveryError extends TransportError {}

export class PacketTooLargeError extends TransportError {
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number) {
    super(
      `packet of ${size} bytes exceeds the ${limit}-byte write limit of this link. ` +
        `The limit is the negotiated MTU minus 3; a default 23-byte MTU leaves 20.`,
    );
    this.size = size;
    this.limit = limit;
  }
}

/** An arm did not acknowledge in time. */
export class CommandTimeout extends OpenG1Error {
  readonly command: string;
  readonly arm: string;
  readonly timeoutMs: number;
  constructor(command: string, timeoutMs: number, arm: string) {
    super(`${command}: no reply from the ${arm} arm within ${timeoutMs} ms`);
    this.command = command;
    this.arm = arm;
    this.timeoutMs = timeoutMs;
  }
}

/** An arm answered with FAILURE (0xCA). */
export class CommandError extends OpenG1Error {
  readonly command: string;
  readonly arm: string;
  readonly status: number;
  constructor(command: string, status: number, arm: string) {
    super(`${command}: the ${arm} arm answered 0x${status.toString(16)} (failure)`);
    this.command = command;
    this.arm = arm;
    this.status = status;
  }
}

/** Something this platform cannot do (for example decoding LC3 without a codec). */
export class UnsupportedFeature extends OpenG1Error {}
