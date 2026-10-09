import { lazy, Suspense } from "react";

import type UsageChartComponent from "./usage-chart";

// The chart library is only needed on the Usage page; load it there rather than with the dashboard.
const Loaded = lazy(() => import("./usage-chart"));

export const UsageChart = (
  props: Parameters<typeof UsageChartComponent>[0]
) => (
  <Suspense fallback={<div className="h-[220px]" />}>
    <Loaded {...props} />
  </Suspense>
);
