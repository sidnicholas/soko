import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "../components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Opportunity OS — Operator Console",
  description: "Demand-first economic coordination console: discover, score, and act on opportunities.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="oos-shell">
          <Sidebar />
          <main className="oos-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
