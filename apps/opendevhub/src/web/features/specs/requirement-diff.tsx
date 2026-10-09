import { MultiFileDiff } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";

import { BASE_OPTIONS } from "../review/patch-view";

const OPTIONS: FileDiffOptions<undefined, undefined> = {
  ...BASE_OPTIONS,
  diffStyle: "unified",
  disableFileHeader: true,
  expandUnchanged: true,
};

/** A requirement's current text against the change's. Import it lazily: it loads the diff highlighter. */
export default function RequirementDiff(props: {
  name: string;
  before: string;
  after: string;
}) {
  return (
    <MultiFileDiff<undefined, undefined>
      oldFile={{ contents: `${props.before}\n`, name: props.name }}
      newFile={{ contents: `${props.after}\n`, name: props.name }}
      options={OPTIONS}
    />
  );
}
