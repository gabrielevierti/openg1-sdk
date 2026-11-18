import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.openg1.app",
  appName: "OpenG1",
  webDir: "www",
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: "Looking for your glasses…",
        cancel: "Cancel",
        availableDevices: "Glasses in range",
        noDeviceFound: "No glasses found",
      },
    },
  },
};

export default config;
