"use client";
import { RootProvider } from "fumadocs-ui/provider/waku";
import type { ReactNode } from "react";

import SearchDialog from "@/components/search";

export const Provider = ({ children }: { children: ReactNode }) => (
  <RootProvider search={{ SearchDialog }}>{children}</RootProvider>
);
