import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import { Label } from "@opendevhub/ui/label";
import { Textarea } from "@opendevhub/ui/textarea";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { FEATURES_MAX } from "../../../shared/personalization";
import { muted } from "../../components/page";
import {
  featureDraft,
  featureIdError,
  optionsError,
} from "./personalization-draft";
import type {
  FeatureDraft,
  PersonalizationDraft,
} from "./personalization-draft";

const FeatureRow = (props: {
  id: string;
  feature: FeatureDraft;
  onChange: (feature: FeatureDraft) => void;
  onRemove: () => void;
}) => {
  const { feature } = props;
  const idProblem = feature.id.trim() ? featureIdError(feature.id) : undefined;
  const optionsProblem = optionsError(feature.options);
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${props.id}-id`} className="sr-only">
            Feature id
          </Label>
          <Input
            id={`${props.id}-id`}
            className="font-mono"
            placeholder="ghcr.io/owner/repo/feature:1"
            spellCheck={false}
            value={feature.id}
            aria-invalid={idProblem ? true : undefined}
            onChange={(e) =>
              props.onChange({ ...feature, id: e.currentTarget.value })
            }
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${feature.id.trim() || "feature"}`}
          onClick={props.onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <Label htmlFor={`${props.id}-options`} className="sr-only">
        Options for {feature.id.trim() || "this feature"}
      </Label>
      <Textarea
        id={`${props.id}-options`}
        className="min-h-9 font-mono text-xs"
        placeholder='Options as JSON, e.g. {"version": "latest"} — leave empty for the defaults'
        spellCheck={false}
        value={feature.options}
        aria-invalid={optionsProblem ? true : undefined}
        onChange={(e) =>
          props.onChange({ ...feature, options: e.currentTarget.value })
        }
      />
      {(idProblem ?? optionsProblem) && (
        <p className="text-destructive text-xs">
          {idProblem ?? optionsProblem}
        </p>
      )}
    </li>
  );
};

/** Features, a setup command and a dotfiles repository; used for the global settings and each project's. */
export const PersonalizationFields = (props: {
  id: string;
  draft: PersonalizationDraft;
  onChange: (draft: PersonalizationDraft) => void;
}) => {
  const { draft, id } = props;
  const set = (change: Partial<PersonalizationDraft>) =>
    props.onChange({ ...draft, ...change });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Features</h3>
          <p className={muted}>
            Dev container Features built into the image on top of the
            repository&apos;s own. Find them at{" "}
            <a
              className="underline underline-offset-2"
              href="https://containers.dev/features"
              target="_blank"
              rel="noopener noreferrer"
            >
              containers.dev/features
            </a>
            .
          </p>
        </div>
        {draft.features.length > 0 && (
          <ul className="bg-card flex flex-col divide-y rounded-lg border">
            {draft.features.map((f) => (
              <FeatureRow
                key={f.key}
                id={`${id}-feature-${f.key}`}
                feature={f}
                onChange={(next) =>
                  set({
                    features: draft.features.map((o) =>
                      o.key === f.key ? next : o
                    ),
                  })
                }
                onRemove={() =>
                  set({
                    features: draft.features.filter((o) => o.key !== f.key),
                  })
                }
              />
            ))}
          </ul>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.features.length >= FEATURES_MAX}
            onClick={() =>
              set({ features: [...draft.features, featureDraft()] })
            }
          >
            <PlusIcon /> Add feature
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${id}-setup`}>Setup command</Label>
          <p className={muted}>
            A shell script run in the container as its user once it starts. It
            runs once per container, and again after you change it.
          </p>
        </div>
        <Textarea
          id={`${id}-setup`}
          className="min-h-24 font-mono text-xs"
          placeholder="curl -fsSL https://example.com/install.sh | sh"
          spellCheck={false}
          value={draft.setupCommand}
          onChange={(e) => set({ setupCommand: e.currentTarget.value })}
        />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Dotfiles</h3>
          <p className={muted}>
            A repository the dev container CLI clones into each new container,
            then runs its install script.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-repository`}>Repository</Label>
          <Input
            id={`${id}-repository`}
            placeholder="owner/dotfiles or https://example.com/dotfiles.git"
            spellCheck={false}
            value={draft.repository}
            onChange={(e) => set({ repository: e.currentTarget.value })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-install`}>Install command</Label>
            <Input
              id={`${id}-install`}
              placeholder="install.sh, setup.sh… found first"
              spellCheck={false}
              disabled={!draft.repository.trim()}
              value={draft.installCommand}
              onChange={(e) => set({ installCommand: e.currentTarget.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-target`}>Clone to</Label>
            <Input
              id={`${id}-target`}
              placeholder="~/dotfiles"
              spellCheck={false}
              disabled={!draft.repository.trim()}
              value={draft.targetPath}
              onChange={(e) => set({ targetPath: e.currentTarget.value })}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
