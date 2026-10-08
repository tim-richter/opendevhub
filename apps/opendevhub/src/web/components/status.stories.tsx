import preview from "../../../.storybook/preview";
import type { SessionStatus } from "../../shared/types";
import type { Tone } from "../derive";
import { Count, SessionBadge, StatusDot, TONE_LABEL } from "./status";

const TONES = Object.keys(TONE_LABEL) as Tone[];
const STATUSES: SessionStatus[] = [
  "needs-permission",
  "needs-answer",
  "running",
  "idle",
];

const meta = preview.meta({
  args: { tone: "running" as const },
  argTypes: { tone: { control: "select", options: TONES } },
  component: StatusDot,
  parameters: { layout: "centered" },
  title: "Components/Status",
});

export const Dot = meta.story();

export const AllTones = meta.story({
  render: () => (
    <ul className="flex flex-col gap-2 text-sm">
      {TONES.map((tone) => (
        <li key={tone} className="flex items-center gap-2">
          <StatusDot tone={tone} /> {TONE_LABEL[tone]}
        </li>
      ))}
    </ul>
  ),
});

export const SessionBadges = meta.story({
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((status) => (
        <SessionBadge key={status} status={status} />
      ))}
    </div>
  ),
});

export const Counts = meta.story({
  render: () => (
    <div className="flex items-center gap-2">
      <Count n={3} tone="attention" />
      <Count n={12} />
      <Count n={0} />
    </div>
  ),
});
