import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  GitSetup,
  SshHostView,
  SshKeyView,
  SshTestResult,
} from "../../../shared/git-setup";
import { fetchGitSetup, testSshHost } from "../../api";
import { Chip, Note } from "../../components/page";
import { SettingsBlock, SettingsHeader, SettingsList } from "./settings-layout";

/** Not persisted (see query-persistence): it describes this machine right now, and is cheap to read again. */
const GIT_SETUP_KEY = ["git-setup"] as const;

/** A line with a check or a warning in front. */
const Status = (props: { ok: boolean; children: ReactNode }) => {
  const Icon = props.ok ? CircleCheckIcon : CircleAlertIcon;
  return (
    <span className="inline-flex items-start gap-1.5 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          props.ok ? "text-ok" : "text-warn"
        )}
        aria-hidden
      />
      <span>{props.children}</span>
    </span>
  );
};

const Code = (props: { children: ReactNode }) => (
  <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
    {props.children}
  </code>
);

/** A label and its value, side by side in a grid. */
const Field = (props: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{props.label}</dt>
    <dd className="min-w-0 break-words">{props.children}</dd>
  </>
);

const Missing = () => <span className="text-warn">Not set</span>;

const Identity = ({ setup }: { setup: GitSetup }) => {
  const { identity, signing } = setup;
  const complete = !!identity.name && !!identity.email;
  return (
    <SettingsBlock
      title="Identity"
      hint="Who commits made on this machine are by. opendevhub copies it into task containers that have none of their own."
    >
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <Field label="Name">{identity.name ?? <Missing />}</Field>
        <Field label="Email">{identity.email ?? <Missing />}</Field>
        <Field label="Commit signing">
          {signing.enabled
            ? `On${signing.format ? ` (${signing.format})` : ""}`
            : "Off"}
        </Field>
        {signing.key && (
          <Field label="Signing key">
            <span className="font-mono text-xs">{signing.key}</span>
          </Field>
        )}
        <Field label="Git version">{setup.version ?? <Missing />}</Field>
      </dl>
      {!complete && (
        <Note warn>
          Commits from opendevhub need a name and email. Set them with{" "}
          <Code>git config --global user.name &quot;Your Name&quot;</Code> and{" "}
          <Code>git config --global user.email you@example.com</Code>.
        </Note>
      )}
      {setup.projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            These projects use another identity, from their own git config or an
            includeIf:
          </p>
          <SettingsList>
            {setup.projects.map((p) => (
              <li
                key={p.projectId}
                className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm"
              >
                <span className="font-medium">{p.project}</span>
                <span className="text-muted-foreground">
                  {[
                    p.identity.name,
                    p.identity.email && `<${p.identity.email}>`,
                  ]
                    .filter(Boolean)
                    .join(" ") || "No identity"}
                </span>
              </li>
            ))}
          </SettingsList>
        </div>
      )}
    </SettingsBlock>
  );
};

const KeyRow = (props: { k: SshKeyView; badge?: ReactNode }) => (
  <li className="flex items-center gap-3 px-4 py-2.5">
    <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm">
        {props.k.comment || props.k.path || "(no comment)"}
      </span>
      <span className="text-muted-foreground truncate font-mono text-xs">
        {props.k.type} · {props.k.fingerprint}
      </span>
    </div>
    {props.badge}
  </li>
);

const Agent = ({ setup }: { setup: GitSetup }) => {
  const { agent } = setup;
  let status: ReactNode = (
    <Status ok>
      Running with {agent.keys.length}{" "}
      {agent.keys.length === 1 ? "key" : "keys"}
    </Status>
  );
  if (!agent.running) {
    status = <Status ok={false}>{agent.error ?? "Not running"}</Status>;
  } else if (agent.keys.length === 0) {
    status = (
      <Status ok={false}>
        Running, but holds no keys. Add one with <Code>ssh-add</Code>.
      </Status>
    );
  }
  return (
    <SettingsBlock
      title="SSH agent"
      hint="Task containers reach your git hosts through this agent when ssh-agent forwarding is on, so the key a host needs must be loaded here."
    >
      {status}
      {agent.keys.length > 0 && (
        <SettingsList>
          {agent.keys.map((k) => (
            <KeyRow key={k.fingerprint} k={k} />
          ))}
        </SettingsList>
      )}
    </SettingsBlock>
  );
};

const KeyFiles = ({ setup }: { setup: GitSetup }) => {
  const loaded = new Set(setup.agent.keys.map((k) => k.fingerprint));
  return (
    <SettingsBlock title="SSH keys" hint="Public keys in ~/.ssh.">
      {setup.keyFiles.length > 0 ? (
        <SettingsList>
          {setup.keyFiles.map((k) => (
            <KeyRow
              key={k.path ?? k.fingerprint}
              k={{ ...k, comment: k.path ?? k.comment }}
              badge={
                loaded.has(k.fingerprint) ? (
                  <Chip className="text-ok">In agent</Chip>
                ) : (
                  <Chip>Not in agent</Chip>
                )
              }
            />
          ))}
        </SettingsList>
      ) : (
        <Status ok={false}>
          No keys in ~/.ssh. Create one with <Code>ssh-keygen -t ed25519</Code>{" "}
          and add its public key to your git host.
        </Status>
      )}
    </SettingsBlock>
  );
};

const hostKeyStatus = (host: SshHostView, agentKeys: number): ReactNode => {
  const inAgent = host.identityFiles.filter((f) => f.inAgent);
  if (inAgent.length > 0) {
    return (
      <Status ok>
        Uses {inAgent.map((f) => f.path).join(", ")}, loaded in the agent
      </Status>
    );
  }
  if (host.identityFiles.length > 0) {
    return (
      <Status ok={false}>
        Uses {host.identityFiles.map((f) => f.path).join(", ")}, not loaded in
        the agent
        {agentKeys > 0 ? "; containers offer the agent's keys instead" : ""}
      </Status>
    );
  }
  if (agentKeys > 0) {
    return <Status ok>Offers the agent&apos;s keys</Status>;
  }
  return <Status ok={false}>No key for this host</Status>;
};

const HostRow = ({
  host,
  agentKeys,
}: {
  host: SshHostView;
  agentKeys: number;
}) => {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SshTestResult>();
  const test = async () => {
    setTesting(true);
    setResult(undefined);
    try {
      setResult(await testSshHost(host.host));
    } catch (err) {
      setResult({
        message: err instanceof Error ? err.message : String(err),
        ok: false,
      });
    } finally {
      setTesting(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">
          {host.user ? `${host.user}@` : ""}
          {host.host}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
          {host.projects.join(", ")}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? "Testing…" : "Test"}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        {hostKeyStatus(host, agentKeys)}
        <Status ok={host.known}>
          {host.known
            ? "Host key in known_hosts"
            : "Not in known_hosts: connect once by hand to trust it"}
        </Status>
        {result && (
          <span role="status">
            <Status ok={result.ok}>
              {result.ok ? "Connected: " : "Failed: "}
              <span className="text-muted-foreground">{result.message}</span>
            </Status>
          </span>
        )}
      </div>
    </li>
  );
};

const Hosts = ({ setup }: { setup: GitSetup }) => (
  <SettingsBlock
    title="Git hosts"
    hint="The ssh hosts your projects' remotes point at, and the key ssh would use for each. Test connects as git would, without prompting."
  >
    {setup.hosts.length > 0 ? (
      <SettingsList>
        {setup.hosts.map((h) => (
          <HostRow key={h.host} host={h} agentKeys={setup.agent.keys.length} />
        ))}
      </SettingsList>
    ) : (
      <p className="text-muted-foreground text-sm">
        No project has an ssh remote. Remotes over HTTPS use git&apos;s
        credential helper instead.
      </p>
    )}
  </SettingsBlock>
);

export const GitSettings = () => {
  const query = useQuery({
    queryFn: fetchGitSetup,
    queryKey: GIT_SETUP_KEY,
    staleTime: 0,
  });
  const setup = query.data;
  return (
    <>
      <SettingsHeader
        title="Git"
        description="This machine's git identity and ssh keys, as task containers inherit them."
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCwIcon
              className={query.isFetching ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
        }
      />
      {query.error && (
        <div role="alert">
          <Note error>{query.error.message}</Note>
        </div>
      )}
      {!setup && query.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          Reading git and ssh setup…
        </p>
      )}
      {setup && (
        <>
          <Identity setup={setup} />
          <Agent setup={setup} />
          <KeyFiles setup={setup} />
          <Hosts setup={setup} />
        </>
      )}
    </>
  );
};
