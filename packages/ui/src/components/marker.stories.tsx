import { HistoryIcon } from "lucide-react";
import { fn } from "storybook/test";

import preview from "../../.storybook/preview";
import { Button } from "./button";
import { Marker, MarkerContent, MarkerIcon } from "./marker";

const meta = preview.meta({
  component: Marker,
  title: "Chat/Marker",
  args: { onClick: fn() },
  render: () => (
    <div className="bg-background flex max-w-xl flex-col gap-6 p-8">
      <Marker>
        <MarkerIcon>
          <HistoryIcon />
        </MarkerIcon>
        <MarkerContent>Conversation compacted</MarkerContent>
      </Marker>
      <Marker variant="border">
        <MarkerContent>Older messages are left out</MarkerContent>
      </Marker>
    </div>
  ),
});

export const Default = meta.story({});

/** A checkpoint, as the AI Elements docs build it: a separator Marker with a Restore button. */
export const Checkpoint = meta.story({
  render: ({ onClick }) => (
    <div className="bg-background max-w-xl p-8">
      <Marker variant="separator">
        <MarkerContent className="inline-flex items-center gap-2">
          <MarkerIcon>
            <HistoryIcon />
          </MarkerIcon>
          Checkpoint
          <Button size="xs" variant="outline" onClick={onClick as () => void}>
            Restore checkpoint
          </Button>
        </MarkerContent>
      </Marker>
    </div>
  ),
});
