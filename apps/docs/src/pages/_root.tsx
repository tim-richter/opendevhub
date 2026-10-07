import type { ReactNode } from "react";

import { Provider } from "@/components/provider";
import { basePath } from "@/lib/shared";

import "@/styles/globals.css";

export const RootElement = ({ children }: { children: ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      <link rel="icon" type="image/svg+xml" href={`${basePath}/favicon.svg`} />
    </head>
    <body data-version="1.0" className="flex min-h-screen flex-col">
      <Provider>{children}</Provider>
    </body>
  </html>
);

export default RootElement;

export const getConfig = () =>
  ({
    render: "static",
  }) as const;
