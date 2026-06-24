// central configuration for dynamic API base URL resolution to support Android (Capacitor) and Web
export const getBaseUrl = (): string => {
  // Check if there is a saved override in localStorage
  try {
    const saved = localStorage.getItem("myraa_bridge_url");
    if (saved) return saved.trim();
  } catch (e) {}

  // Check if we are running in a standard web context
  if (typeof window !== "undefined" && window.location && window.location.protocol && window.location.protocol.startsWith("http")) {
    // Standard web browser deployment
    return `${window.location.protocol}//${window.location.host}`;
  }

  // Fallback default production / dev hosted URL for Capacitor/Android native contexts
  // Points to the hosted Cloud Run server instance
  return "https://ais-pre-dqkwovkp6bzexpjjqswm7r-934758721115.asia-east1.run.app";
};

export const getWebSocketUrl = (): string => {
  const baseUrl = getBaseUrl();
  const rawUrl = baseUrl.replace(/^http/, "ws");
  // Ensure we append '/live'
  return rawUrl.endsWith("/") ? `${rawUrl}live` : `${rawUrl}/live`;
};

export const setStoredBridgeUrl = (url: string) => {
  try {
    if (!url) {
      localStorage.removeItem("myraa_bridge_url");
    } else {
      localStorage.setItem("myraa_bridge_url", url);
    }
  } catch (e) {}
};
