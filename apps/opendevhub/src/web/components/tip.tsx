import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@opendevhub/ui/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";

/**
 * A tooltip on any element; the child must take a ref (a DOM element or a forwarding component). `delay` (ms)
 * holds it back for elements whose label is usually visible already.
 */
export const Tip = ({
  label,
  side,
  delay,
  children,
}: {
  label: ReactNode;
  side?: ComponentProps<typeof TooltipContent>["side"];
  delay?: number;
  children: ReactElement;
}) => (
  <Tooltip delayDuration={delay}>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>{label}</TooltipContent>
  </Tooltip>
);
