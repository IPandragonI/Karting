import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";

const rubik = Rubik({
  subsets: ["latin"],
  variable: "--font-rubik",
  weight: ["400", "500", "700", "800"],
});

export const metadata: Metadata = {
  title: "Low-Poly Karting",
  description: "A small browser karting game with drifting, time trials and a track editor.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#1f2329",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="paddock">
      <body className={`${rubik.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
