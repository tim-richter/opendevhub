import { Skeleton } from "@opendevhub/ui/skeleton";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { Empty, muted } from "../../components/page";
import { CheckoutProvider } from "../checkouts/checkout-context";
import { CheckoutRuntime } from "../checkouts/checkout-page";
import { checkoutOf } from "../checkouts/checkouts";
import { useTaskPage } from "./task-context";
import { startStepLabel } from "./tasks";

/** Gives a tab the selected variant's checkout, or says why it has none: still being set up, or removed. */
export const VariantCheckout = (props: { children: ReactNode }) => {
  const { view, variant } = useTaskPage();
  if (!variant.directory) {
    return (
      <Empty title="Not ready yet">
        <p className={muted}>
          {variant.step === "failed"
            ? "This variant failed to start, so it has no worktree."
            : `${startStepLabel(variant.step)}…`}
        </p>
      </Empty>
    );
  }
  const checkout = checkoutOf(view, variant.directory);
  if (!checkout) {
    return (
      <Empty title="Worktree removed">
        <p className={muted}>
          This variant&apos;s worktree is gone, so there are no changes,
          terminal or runtime to show.
        </p>
      </Empty>
    );
  }
  return (
    <CheckoutProvider
      value={{
        checkout,
        view,
        ...(variant.sessionId ? { sessionId: variant.sessionId } : {}),
      }}
    >
      {props.children}
    </CheckoutProvider>
  );
};

export const TaskRuntime = () => (
  <VariantCheckout>
    <CheckoutRuntime />
  </VariantCheckout>
);

const CheckoutTerminal = lazy(() =>
  import("../checkouts/checkout-terminal").then((module) => ({
    default: module.CheckoutTerminal,
  }))
);

/** The selected variant's terminal, filling the tab. */
export const TaskTerminal = () => (
  <VariantCheckout>
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <CheckoutTerminal fill />
      </Suspense>
    </div>
  </VariantCheckout>
);
