import preview from "../../../../.storybook/preview";
import { Badge } from "./badge";

const meta = preview.meta({
  args: { children: "opencode healthy" },
  argTypes: {
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
  component: Badge,
  parameters: { layout: "centered" },
  title: "UI/Badge",
});

export const Default = meta.story();

export const Variants = meta.story({
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge {...args}>Default</Badge>
      <Badge {...args} variant="secondary">
        Secondary
      </Badge>
      <Badge {...args} variant="outline">
        Outline
      </Badge>
      <Badge {...args} variant="destructive">
        Destructive
      </Badge>
    </div>
  ),
});
