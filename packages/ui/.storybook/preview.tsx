import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";

import "../src/styles.css";

export default definePreview({
  addons: [addonDocs(), addonA11y()],
  parameters: { layout: "fullscreen" },
});
