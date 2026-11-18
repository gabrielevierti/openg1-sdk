/**
 * The TypeScript SDK must produce what the Python SDK produces. The fixture
 * is generated from the Python implementation — the one that has been run
 * against real glasses — by tools/gen_parity.py.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Bitmap, bmpCrc, commands as c, fromUtf8, text, toHex, transferPackets, utf8 } from "../src/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/python-parity.json", import.meta.url), "utf8"));
const show = (o: c.Outbound) => `${o.command}:${toHex(o.body)}`;

test("command builders match Python byte for byte", () => {
  const ours: Record<string, string> = {
    "set_brightness(30,True)": show(c.setBrightness(30, true)),
    "set_brightness(0)": show(c.setBrightness(0)),
    get_brightness: show(c.getBrightness()),
    clear_screen: show(c.clearScreen()),
    bmp_end: show(c.bmpEnd()),
    "bmp_crc(0xDEADBEEF)": show(c.bmpCrcPacket(0xdeadbeef)),
    "bmp_packet(0,first)": show(c.bmpPacket(0, Uint8Array.from({ length: 10 }, (_, i) => i), true)),
    "bmp_packet(7)": show(c.bmpPacket(7, Uint8Array.from({ length: 10 }, (_, i) => i))),
    "set_display_settings(4,5,preview)": show(c.setDisplaySettings(4, 5, true)),
    "set_display_settings(8,9,commit)": show(c.setDisplaySettings(8, 9, false)),
    "display_power(True)": show(c.displayPower(true)),
    "heartbeat(42)": show(c.heartbeat(42)),
    seq_sync: show(c.seqSync()),
    init: show(c.init()),
    hard_reset: show(c.hardReset()),
    get_firmware_info: show(c.getFirmwareInfo()),
    get_battery: show(c.getBattery()),
    get_uptime: show(c.getUptime()),
    "mic_control(True)": show(c.micControl(true)),
    "set_silent_mode(True)": show(c.setSilentMode(true)),
    "set_silent_mode(False)": show(c.setSilentMode(false)),
    "set_headup_angle(35)": show(c.setHeadupAngle(35)),
    "set_wear_detection(True)": show(c.setWearDetection(true)),
    "set_button_config(3)": show(c.setButtonConfig(3)),
    "set_gesture_config(4)": show(c.setGestureConfig(4)),
    reset_zero_degree: show(c.resetZeroDegree()),
    "calibration(2,0100)": show(c.calibration(2, [1, 0])),
    "set_language(2)": show(c.setLanguage(2)),
    "set_debug_mode(True)": show(c.setDebugMode(true)),
    time_weather: show(
      c.setTimeAndWeather({ epochMs: 1_763_424_000_123, icon: 0x10, temperatureC: -7, fahrenheit: true, twelveHour: true }),
    ),
    "dashboard_layout(0,3)": show(c.setDashboardLayout(0, 3)),
    "dashboard_lock(True)": show(c.dashboardLock(true)),
    clear_notification: show(c.clearNotification()),
    send_text: show(
      c.sendText(utf8("ciao"), { seq: 9, totalPackages: 3, packageIndex: 1, newCharPos: 0x1234, page: 2, maxPage: 4 }),
    ),
    notification_packet: show(c.notificationPacket(utf8("{}"), 1, 3)),
    notification_config_packet: show(c.notificationConfigPacket(utf8("{}"), 0, 1)),
    set_navigation: show(c.setNavigation([1, 2, 3])),
  };
  assert.deepEqual(ours, fixture.builders);
});

for (const [i, layout] of (fixture.layouts as any[]).entries()) {
  test(`text layout ${i} matches Python: ${JSON.stringify(layout.text.slice(0, 30))}`, () => {
    assert.deepEqual(text.wrap(layout.text), layout.wrap);
    assert.deepEqual(text.wrap(layout.text, { widthPx: 200 }), layout.wrap_200);
    assert.ok(Math.abs(text.measure(layout.text) - layout.measure) < 0.001);
    const pages = text.textPackets(layout.text, { seq: 5, maxData: 60 });
    assert.deepEqual(
      pages.map((page) => page.map((p) => toHex(p.body))),
      layout.packets,
    );
  });
}

test("dithering, BMP encoding and transfer chunking match Python", () => {
  const width = 576;
  const height = 136;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = (x * 7 + y * 13 + ((x * y) % 31)) % 256;

  const dithered = Bitmap.fromGray(gray, width, height);
  const file = dithered.toBmp();
  assert.equal(toHex(file), fixture.images.dithered_bmp);
  assert.equal(bmpCrc(dithered.toBmp(true)).toString(16).padStart(8, "0"), fixture.images.dithered_top_down_crc);

  const thresholded = Bitmap.fromGray(gray, width, height, { dither: false, threshold: 100 });
  assert.equal(bmpCrc(thresholded.toBmp()).toString(16).padStart(8, "0"), fixture.images.thresholded_crc);

  const transfer = transferPackets(file);
  assert.equal(transfer.data.length, fixture.images.packet_count);
  assert.equal(toHex(transfer.data[0]!.body), fixture.images.first_packet);
  assert.equal(toHex(transfer.data.at(-1)!.body), fixture.images.last_packet);
  assert.equal(toHex(transfer.end.body), fixture.images.end);
  assert.equal(toHex(transfer.crc.body), fixture.images.crc);

  const smallGray = Uint8Array.from({ length: 60 }, (_, i) => (i % 20) * 10);
  const small = Bitmap.fromGray(smallGray, 20, 3, { dither: false });
  assert.equal(toHex(small.toBmp()), fixture.images.small_bmp);
  assert.deepEqual(small.shiftRows(1).contentBounds(), fixture.images.content_bounds);
  assert.deepEqual(Bitmap.fromBmp(small.toBmp()).bits, small.bits);
});

test("notification JSON matches Python", () => {
  const ours = JSON.parse(
    fromUtf8(
      c.notificationJson({
        appId: "com.example",
        appName: "Esempio",
        title: "Titolo è",
        subtitle: "s",
        message: "m",
        timestamp: 1_763_424_000,
        msgId: 1,
      }),
    ),
  );
  const theirs = JSON.parse(fixture.notification_json);
  theirs.ncs_notification.msg_id = 1; // the one field that is a clock reading
  assert.deepEqual(ours, theirs);
  assert.deepEqual(Object.keys(ours.ncs_notification), Object.keys(theirs.ncs_notification));
  assert.equal(
    fromUtf8(c.notificationConfigJson({ apps: [{ id: "com.a", name: "A" }, { id: "com.b", name: "B" }], calendar: false })),
    fixture.notification_config_json,
  );
});
