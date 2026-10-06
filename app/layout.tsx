import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Repo Analysis Tool",
  description: "Git repository metrics dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
