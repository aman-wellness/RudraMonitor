import type { CapacitorConfig } from "@capacitor/cli";

// Bundle id matches the iOS/Android app records we'll create on Apple
// Developer + Play Console. Don't change this without coordinating both
// stores; new ids = new apps + lost user data.
const config: CapacitorConfig = {
  appId: "com.wellnessextract.invoice",
  appName: "WE Invoice",
  webDir: "dist",
  ios: {
    contentInset: "always",
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: "#0f1115",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    Camera: {
      // Permission strings shown in iOS settings + first-run dialog.
      // Apple rejects apps with vague strings, so be specific.
      iosPermissionsRequest: true,
    },
  },
};

export default config;
