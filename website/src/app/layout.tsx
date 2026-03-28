import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "The State Champion | Championship Gymnastics T-Shirts",
  description:
    "Celebrate your gymnast's championship achievements with an official t-shirt featuring their name alongside all the winners.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased light`} style={{ colorScheme: "light" }}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
