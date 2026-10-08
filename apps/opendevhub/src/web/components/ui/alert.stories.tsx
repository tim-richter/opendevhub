import { CircleAlertIcon, InfoIcon } from "lucide-react";

import preview from "../../../../.storybook/preview";
import { Alert, AlertDescription, AlertTitle } from "./alert";

const meta = preview.meta({
  component: Alert,
  parameters: { layout: "padded" },
  title: "UI/Alert",
});

export const Default = meta.story({
  render: (args) => (
    <Alert {...args}>
      <InfoIcon />
      <AlertTitle>Rebuild needed</AlertTitle>
      <AlertDescription>
        The container was created without the worktrees mount. Rebuild it to
        give worktrees their own checkout.
      </AlertDescription>
    </Alert>
  ),
});

export const Destructive = meta.story({
  args: { variant: "destructive" },
  render: (args) => (
    <Alert {...args}>
      <CircleAlertIcon />
      <AlertTitle>Container failed to start</AlertTitle>
      <AlertDescription>
        devcontainer up failed: features/cuda: unsupported architecture arm64
      </AlertDescription>
    </Alert>
  ),
});
