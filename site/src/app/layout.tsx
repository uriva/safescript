import type { Metadata } from "next";
import { JetBrains_Mono, DM_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "safescript -- a programming language for AI agents",
  description:
    "Static DAGs, closed instruction sets, formal data-flow tracking, and resource bounds you can inspect before anything runs.",
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => (
  <html
    lang="en"
    className={`${dmSans.variable} ${jetbrainsMono.variable} h-full`}
    suppressHydrationWarning
  >
    <body className="min-h-full flex flex-col antialiased">
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        disableTransitionOnChange
      >
        {children}
      </ThemeProvider>
    </body>
  </html>
);

export { RootLayout as default };
