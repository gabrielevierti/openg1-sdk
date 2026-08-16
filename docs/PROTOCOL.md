# The Even Realities G1 BLE protocol

This is a reverse-engineered description. Nothing here comes from Even
Realities, and the company has neither reviewed nor endorsed it. It was
assembled from packet captures, the behaviour of open-source clients, and a
good deal of trying things and watching what happened.

The machine-readable version is [`protocol/openg1.protocol.yaml`](../protocol/openg1.protocol.yaml),
which every binding is generated from. If the two disagree, the YAML is right
and this document is stale.

## Confidence

Every command carries a confidence marker, because a reverse-engineered
protocol where everything looks equally certain is a trap. Of the 49 commands:

| Marker | Count | Means |
| --- | --- | --- |
| `confirmed` | 23 | Observed on the wire, and the response matched the model. Safe to build on. |
| `observed` | 12 | Seen working, but some fields are not fully understood. |
| `guessed` | 14 | The opcode is known; the payload layout is inference. May do nothing, or something unexpected. |

`guessed` commands are shipped rather than hidden, because a wrong guess you
can see is more useful than a gap you cannot. They are marked in every
language, so an application can check before relying on one.

## Transport

Each arm is a separate BLE peripheral running a Nordic UART service.

| | |
| --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (app writes) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (notifications) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |
| Advertised name | `Even G1_<channel>_<L\|R>_<serial>` |

Both arms of a pair share the channel number, which is how you match a left to
its right. Connect to both: neither arm is a proxy for the other, and several
commands only take effect on one side.

Writes use write-without-response. The default ATT payload is 20 bytes; after
MTU negotiation you typically get around 244, which image transfer requires.
The SDK never assumes the larger figure — it asks the transport and says so
plainly when a command will not fit.

**Idle timeout is 32 seconds.** Send nothing for that long and the firmware
drops the link. A heartbeat every 28 seconds keeps it alive.

## Framing

Two packet families share the one characteristic:

```
raw     [opcode, ...payload]
framed  [opcode, len_lo, len_hi, seq, ...payload]
```

The framed length **counts its own four header bytes**. This is the single
most useful thing in this document, because most published opcode tables read
the second byte as a "sub-command" and are therefore wrong in a way that
usually works. The heartbeat is the clearest example:

```
25 06 00 03 04 03
^^ opcode 0x25
   ^^ ^^ length 6, little endian
         ^^ sequence 3
            ^^ ^^ payload
```

Read as command-plus-sub-command, that is "0x25 0x06", which is stable only
because the heartbeat payload never changes length. `SET_DASHBOARD` has a
variable length and the illusion collapses immediately.

Whether an opcode is framed is a property of the command, not something you
can detect reliably from the bytes. The tables in each binding carry the flag.

### Replies

Two quirks, both of which will waste an afternoon if you do not know them:

1. **Replies are zero-padded** out to the ATT payload size. The declared length
   is the only marker of where the useful bytes stop. Trim by length, not by
   scanning for zeros — a legitimate payload may contain them.
2. **Framed replies append their result past the declared length.** A heartbeat
   reply is `25 06 00 03 04 03 c9`: seven bytes, of which the length field
   claims six. The `c9` is real and sits outside the frame. Every binding
   surfaces it as `trailer`.

Status bytes: `0xC9` success, `0xCA` failure, `0xCB` continue.

### One reply at a time

Framed packets carry a sequence byte that the reply echoes, which is the only
correlation the protocol offers. Raw commands echo nothing but their opcode. So
the session keeps exactly one command outstanding — with two commands in flight
sharing an opcode, a reply cannot be attributed.

One command has no header at all: `GET_FIRMWARE_INFO` answers with bare ASCII,
zero-padded, with no opcode. It can only be matched positionally, which is safe
precisely because sends are serialised.

## Arms

| Target | Commands |
| --- | --- |
| Right only | brightness, head-up angle, microphone, dashboard lock, sequence sync |
| Left only | notification whitelist, notifications, ANCS, calendar, init |
| Both | display, text, images, heartbeat, silent mode, wear detection |

For a both-arms command, **send left, wait for the acknowledgement, then send
right**. Skipping the wait tears the display: the two halves of the panel are
driven independently and update when each arm receives its packet.

## Display

| | |
| --- | --- |
| Panel | 576 × 136, one bit per pixel |
| Usable text width | 488 px |
| Default font | 21 px, about 5 lines per screen |
| Bitmap format | Windows BMP, 1 bpp, 62-byte header, 72-byte stride |
| Bitmap chunk | 194 bytes |
| Storage address | `00 1C 00 00` |

### Text — `0x4E`

Eight header bytes follow the opcode:

| Offset | Field |
| --- | --- |
| 0 | sequence |
| 1 | total packages |
| 2 | package index |
| 3 | screen status |
| 4–5 | new character position, **big endian** |
| 6 | current page |
| 7 | page count |

Offsets 4–5 are the only big-endian field in the protocol apart from the bitmap
CRC. The screen status byte is two nibbles: the high nibble is the mode
(`0x30` AI displaying, `0x40` AI complete, `0x50` AI manual, `0x60` AI network
error, `0x70` plain text), the low nibble `0x01` means new content.

Split long text on UTF-8 boundaries. A torn multi-byte sequence reaches the
panel as a replacement glyph and cannot be recovered downstream.

### Images — `0x15`, `0x16`, `0x20`

Send the BMP in 194-byte chunks (`0x15`), where the first chunk carries the
four-byte storage address after the chunk index. Then send the end marker
(`0x20 0x0D 0x0E`), wait for its acknowledgement, and only then the CRC
(`0x16`). Earlier revisions of this page had those last two the other way
round; the SDK has always sent end-then-CRC, which is what the glasses
accept.

**The chunk index is a single byte.** A 576x136 image is 9854 bytes, so a
chunk below 39 bytes needs more than 256 chunks and the index wraps. Chunk
size follows the negotiated MTU, so this is really a warning about MTU
negotiation: the 23-byte default leaves 14-byte chunks and 704 of them.
`openg1.bmp.check_transfer_budget` refuses rather than sending a transfer the
firmware cannot reassemble.

**The BMP is bottom-up**, so the tail of the byte stream is the top of the
picture. A transfer that loses its end renders as a blank band across the
*top* of the panel. Flipping to a top-down BMP (negative height) moves that
band to the bottom, which is how you tell a truncated transfer apart from a
panel you cannot fully see.

The CRC is CRC-32/ISO-HDLC — what Even's documentation calls "Crc32Xz", and
what zlib, PNG and `java.util.zip.CRC32` compute — **over the storage address
followed by the file**. A CRC over the file alone is rejected, which is the
single most common reason an image transfer silently fails.

## Events

Three opcodes arrive unsolicited.

**`0xF5` state change** carries a sub-code:

| Sub-code | Meaning |
| --- | --- |
| `0x00` / `0x01` | double tap / single tap |
| `0x02` / `0x03` | head up / head down |
| `0x04` / `0x05` | triple tap |
| `0x06` / `0x07` | glasses worn / removed |
| `0x08` / `0x0B` | case lid open / closed |
| `0x09` | charging state |
| `0x0E` / `0x0F` | case charging / case battery |
| `0x11` | BLE paired |
| `0x17` / `0x18` | hold start / hold end |
| `0x1E` / `0x1F` | dashboard opened / closed |
| `0x20` | translate toggled |

A **hold on the left arm is the Even AI trigger**; on the right it is an
ordinary hold. Every binding distinguishes them.

**`0xF1` microphone data** is a sequence byte followed by an LC3 frame. The
sequence wraps at 256, which matters for reassembly on any recording longer
than a few seconds.

**`0x2C` battery report** is both a reply to `GET_BATTERY` and an unsolicited
push. A packet can legitimately be both at once, so the session resolves the
pending request *and then* dispatches the event. Handling only one of those is
a bug that shows up as either a hung promise or a missing event, depending on
which half you got wrong.

Unknown sub-codes are surfaced rather than dropped, in every binding. That is
how this table grows: run the monitor, do something the SDK has never seen, and
read the sub-code off the screen.

## Commands

The full table with fields, ranges and confidence is in the YAML. A summary of
the ones most people want:

| Opcode | Command | Notes |
| --- | --- | --- |
| `0x01` | set brightness | 0–42, **not** 0–100. Right arm. |
| `0x03` | silent mode | `0x0C` on, `0x0A` off |
| `0x0B` | head-up angle | 0–60 degrees, right arm |
| `0x0E` | microphone | right arm only |
| `0x15/16/20` | bitmap data / CRC / end | see above |
| `0x18` | clear screen | |
| `0x22` | sequence sync | framed, right arm, part of the handshake |
| `0x23 0x74` | firmware info | headerless ASCII reply |
| `0x25` | heartbeat | framed; its counter is **separate** from the sequence counter |
| `0x2C 0x01` | battery | also arrives unsolicited |
| `0x4B` | send notification | chunked JSON, ≤180 bytes per chunk, left arm |
| `0x4D 0xFB` | init | left arm, first thing after connecting |
| `0x4E` | send text | see above |

## What is not known

Honest gaps, so nobody wastes a weekend rediscovering them:

- **Navigation (`0x0A`)** — the opcode is right and the glasses accept it, but
  the payload layout is a guess. `SET_NAVIGATION` is where to look; the
  navigation helpers fall back to formatted text, which works today.
- **Teleprompter (`0x09`)** — same situation.
- **`GET_DEVICE_INFO`, MAC, serials, ESB (`0x2C 0x02`, `0x2D`, `0x33`–`0x36`)**
  — replies come back but the field layouts are partially inferred.
- **Firmware update** — deliberately not implemented. Getting it wrong bricks
  hardware that is no longer sold, and a mistake is unrecoverable.
- **LC3 parameters** — the frame size is consistent with 16 kHz, 10 ms frames,
  but the exact encoder configuration has not been confirmed against a decoder.

## Sources

Work by other people that made this possible: `even-realities/EvenDemoApp`,
`JohnRThomas/EvenDemoApp` and its wiki, `binarythinktank/eveng1_python_sdk`,
`emingenc/even_glasses`, `emingenc/g1_flutter_blue_plus`, `hqrrr/EvenComfort`,
`lohmuller/even-g1-java-sdk`, `FJiangArthur/Helix-iOS`, `radioegor146/even-utils`
and `Mentra-Community/MentraOS`. Where they disagreed, packet captures decided.
