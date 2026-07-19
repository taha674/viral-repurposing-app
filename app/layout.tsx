import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viral Repurposing — Cyrus Amin",
  description: "Instagram reel discovery, transcript, and red-line-compliance adaptation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">Viral Repurposing</div>
          <nav>
            <Link href="/">Review Queue</Link>
            <Link href="/accounts">Tracked Accounts</Link>
            <Link href="/settings">Settings</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
