import { PlusIcon, XIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";

import { MAX_VARIANTS } from "../../../shared/tasks";
import type { ModelsInfo, TaskVariantSpec } from "../../../shared/types";
import { Choice } from "../../components/choice";
import { modelFromKey, modelKey } from "./tasks";

/** One variant as the form holds it: keys into the project's model and agent lists, empty for the default. */
export interface VariantRow {
  model: string;
  variant: string;
  agent: string;
}
export const EMPTY_ROW: VariantRow = { agent: "", model: "", variant: "" };

/** The rows as a task request's variants, keeping only what the project's lists offer, so what's sent is what's shown. */
export const rowsToVariants = (
  rows: VariantRow[],
  models: ModelsInfo | undefined
): TaskVariantSpec[] =>
  rows.map((r) => {
    const chosen = models?.models.find((m) => modelKey(m) === r.model);
    const model = chosen ? modelFromKey(r.model) : undefined;
    const variant = chosen?.variants.includes(r.variant) ? r.variant : "";
    const agent = models?.agents.some((a) => a.id === r.agent) ? r.agent : "";
    return {
      ...(model
        ? { model: { ...model, ...(variant ? { variant } : {}) } }
        : {}),
      ...(agent ? { agent } : {}),
    };
  });

/** A model (with its reasoning effort) and agent per variant, with rows to add and remove. */
export const VariantRows = ({
  rows,
  setRows,
  models,
  canAdd,
}: {
  rows: VariantRow[];
  setRows: Dispatch<SetStateAction<VariantRow[]>>;
  models: ModelsInfo | undefined;
  /** Whether more than one variant is possible here. */
  canAdd: boolean;
}) => {
  const defaultModel = models?.default;
  const defaultName = defaultModel
    ? (models?.models.find(
        (m) =>
          m.id === defaultModel.id && m.providerID === defaultModel.providerID
      )?.name ?? defaultModel.id)
    : undefined;
  const setRow = (i: number, patch: Partial<VariantRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col items-start gap-2">
      {rows.map((row, i) => {
        const chosen = models?.models.find((m) => modelKey(m) === row.model);
        return (
          <div className="flex flex-wrap items-center gap-2" key={i}>
            <Choice
              label={`Model ${i + 1}`}
              value={row.model}
              onChange={(model) => setRow(i, { model, variant: "" })}
              options={[
                {
                  label: defaultName
                    ? `Default (${defaultName})`
                    : "Default model",
                  value: "",
                },
                ...(models?.models.map((m) => ({
                  label: m.name,
                  value: modelKey(m),
                })) ?? []),
              ]}
            />
            {chosen && chosen.variants.length > 0 && (
              <Choice
                label={`Reasoning ${i + 1}`}
                value={row.variant}
                onChange={(variant) => setRow(i, { variant })}
                options={[
                  { label: "Default effort", value: "" },
                  ...chosen.variants.map((v) => ({ label: v, value: v })),
                ]}
              />
            )}
            {models && models.agents.length > 1 && (
              <Choice
                label={`Agent ${i + 1}`}
                value={row.agent}
                onChange={(agent) => setRow(i, { agent })}
                options={[
                  { label: "Default agent", value: "" },
                  ...models.agents.map((a) => ({
                    label: a.name,
                    title: a.description,
                    value: a.id,
                  })),
                ]}
              />
            )}
            {rows.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={`Remove model ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            )}
          </div>
        );
      })}
      {canAdd && rows.length < MAX_VARIANTS && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => setRows((rs) => [...rs, EMPTY_ROW])}
        >
          <PlusIcon /> Compare with another model
        </Button>
      )}
    </div>
  );
};
