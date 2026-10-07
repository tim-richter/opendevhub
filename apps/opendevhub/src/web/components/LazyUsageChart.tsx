import { lazy, Suspense } from "react";

import type UsageChartComponent from "./UsageChart";

// The chart library is only needed on the Usage page; load it there rather than with the dashboard.
const Loaded = lazy(() => import("./UsageChart"));

export const UsageChart = (
  props: Parameters<typeof UsageChartComponent>[0]
) => (
  <Suspense fallback={<div className="h-[220px]" />}>
    <Loaded {...props} />
  </Suspense>
);
