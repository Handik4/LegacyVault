import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LegacyVault: Trust-Minimized Digital Estate & Succession",
  description:
    "Inactivity bounds, staked claims, three-registry corroboration and a 30-day veto window, enforced by GenLayer validators.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
