import type { Metadata, Viewport } from "next";
import { DM_Sans, IBM_Plex_Mono } from "next/font/google";
import { preconnect } from "react-dom";
import "./globals.css";
import { BASEMAP_HOSTS } from "@/components/map/basemaps";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/shell/ThemeProvider";

// The workbench design's two faces, self-hosted by next/font (downloaded at build time, served
// from our own origin, no CDN link in the page): DM Sans for the interface, IBM Plex Mono for
// labels, coordinates, ids and the attribute table.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-ui",
  display: "swap",
});

const TITLE = "Erdfeld AI — Geospatial analysis with evidence";
const DESCRIPTION =
  "Draw an area on the map and ask a question. Erdfeld AI fetches open satellite and map data, runs the analysis, and answers with the source, date and uncertainty attached.";

export const metadata: Metadata = {
  // Absolute base for the social-card URLs; set SITE_URL to the public origin when building.
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: { default: TITLE, template: "%s | Erdfeld AI" },
  description: DESCRIPTION,
  applicationName: "Erdfeld AI",
  keywords: ["Erdfeld AI", "geospatial", "satellite", "Earth observation", "NDVI", "mapping", "evidence"],
  authors: [{ name: "Erdfeld AI" }],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/favicon-bars.svg", type: "image/svg+xml" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  openGraph: {
    type: "website",
    siteName: "Erdfeld AI",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/brand/og-image.png", width: 1200, height: 630, alt: "Erdfeld AI" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/brand/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#090b0c" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The basemap's style and tiles come from CARTO; on a slow link the handshake alone is seconds.
  // Open the connections now, before the map script has even loaded. Tiles are fetched with CORS.
  for (const host of BASEMAP_HOSTS) preconnect(host, { crossOrigin: "anonymous" });

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${dmSans.variable} ${plexMono.variable} font-sans antialiased bg-background text-foreground overflow-hidden`}
      >
        <ThemeProvider>
          {children}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
