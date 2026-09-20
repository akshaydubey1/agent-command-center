import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Command Center",
  description:
    "A supervised four-agent workspace: automatic model routing, an independent review pass, and an approval queue for every external action.",
  applicationName: "Agent Command Center",
  other: {
    // Hosting-platform preview marker; not an authorship field.
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
