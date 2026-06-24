import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.myraa.hologram",
  appName: "Remix: Myraa AI Assistant",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
