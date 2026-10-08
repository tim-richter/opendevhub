import { PlusIcon, TrashIcon } from "lucide-react";
import { fn } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { Button } from "./button";

const meta = preview.meta({
  args: { children: "New task", onClick: fn() },
  argTypes: {
    size: {
      control: "select",
      options: [
        "default",
        "xs",
        "sm",
        "lg",
        "icon",
        "icon-xs",
        "icon-sm",
        "icon-lg",
      ],
    },
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "outline",
        "ghost",
        "link",
        "destructive",
      ],
    },
  },
  component: Button,
  parameters: { layout: "centered" },
  title: "UI/Button",
});

export const Default = meta.story();

export const Variants = meta.story({
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button {...args}>Default</Button>
      <Button {...args} variant="secondary">
        Secondary
      </Button>
      <Button {...args} variant="outline">
        Outline
      </Button>
      <Button {...args} variant="ghost">
        Ghost
      </Button>
      <Button {...args} variant="link">
        Link
      </Button>
      <Button {...args} variant="destructive">
        Destructive
      </Button>
    </div>
  ),
});

export const Sizes = meta.story({
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button {...args} size="xs">
        Extra small
      </Button>
      <Button {...args} size="sm">
        Small
      </Button>
      <Button {...args}>Default</Button>
      <Button {...args} size="lg">
        Large
      </Button>
    </div>
  ),
});

export const WithIcon = meta.story({
  args: {
    children: (
      <>
        <PlusIcon /> New task
      </>
    ),
  },
});

export const IconOnly = meta.story({
  args: {
    "aria-label": "Remove",
    children: <TrashIcon />,
    size: "icon",
    variant: "ghost",
  },
});

export const Disabled = meta.story({ args: { disabled: true } });
