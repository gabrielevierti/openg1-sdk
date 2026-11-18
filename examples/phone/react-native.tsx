/**
 * React Native (iPhone and Android), with react-native-ble-plx.
 *
 * Not runnable from this repository: drop it into a React Native app that has
 * `openg1` and `react-native-ble-plx` installed and Bluetooth permissions
 * declared. The adapter is tested against a stand-in for the library, not on
 * a phone — see docs/PLATFORMS.md.
 */
import React, { useEffect, useRef, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { BleManager } from "react-native-ble-plx";
import { G1 } from "openg1";
import { connectPair } from "openg1/transports/react-native";

const manager = new BleManager();

export default function App() {
  const g1 = useRef<G1 | null>(null);
  const [status, setStatus] = useState("Not connected");
  const [message, setMessage] = useState("ciao");

  const connect = async () => {
    try {
      setStatus("Scanning for both arms…");
      const glasses = await G1.connect(connectPair(manager));
      g1.current = glasses;
      const battery = await glasses.info.battery();
      setStatus(`Connected · left ${battery.left}% · right ${battery.right}%`);
      glasses.on("touch", (event) => setStatus(`${event.arm} arm: ${event.gesture}`));
      glasses.on("disconnect", () => setStatus("Disconnected"));
    } catch (error) {
      setStatus((error as Error).message);
    }
  };

  useEffect(() => () => void g1.current?.disconnect(), []);

  return (
    <View style={{ padding: 24, gap: 12, marginTop: 60 }}>
      <Text>{status}</Text>
      <Button title="Connect glasses" onPress={connect} />
      <TextInput value={message} onChangeText={setMessage} style={{ borderWidth: 1, padding: 8 }} />
      <Button title="Show on the glasses" onPress={() => g1.current?.display.text(message)} />
      <Button
        title="Draw a screen"
        onPress={() =>
          g1.current?.display.draw((c) => {
            c.text("42", c.width / 2, c.safe.y + 10, { font: "xl", align: "center" });
            c.text("drawn on the phone", c.width / 2, c.safe.y + 96, { font: "md", align: "center" });
          })
        }
      />
    </View>
  );
}
