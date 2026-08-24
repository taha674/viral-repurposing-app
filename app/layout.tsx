import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { hasAppPassword } from "@/lib/config";
import { LogoutButton } from "./LogoutButton";

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
            <Link href="/">Board</Link>
            <Link href="/discovery">Discovery Sources</Link>
            <Link href="/settings">Settings</Link>
          </nav>
          {hasAppPassword() && <LogoutButton />}
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
