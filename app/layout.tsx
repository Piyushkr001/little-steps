import type { Metadata } from "next";
import { Exo_2 } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import Navbar from "./_shared/Navbar";
import Footer from "./_shared/Footer";
import { PublicChromeGuard } from "./_shared/PublicChromeGuard";
import { ThemeProvider } from "@/components/theme-provider";

const exo2 = Exo_2({
  variable: "--font-exo2",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Little Steps",
  description: "Little Steps - Trusted 24×7 Childcare Platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${exo2.className} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Suspense fallback={null}>
            <Navbar />
          </Suspense>
          <div className="flex flex-1 flex-col">{children}</div>
          <Suspense fallback={null}>
            <PublicChromeGuard>
              <Footer />
            </PublicChromeGuard>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
