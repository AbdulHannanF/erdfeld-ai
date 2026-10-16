import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Erdfeld AI",
    short_name: "Erdfeld",
    description: "Geospatial analysis on open Earth observation data, with the evidence attached.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f6f5",
    theme_color: "#25705f",
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
      { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
