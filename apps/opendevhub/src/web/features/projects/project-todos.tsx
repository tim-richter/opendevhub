import { Button } from "@opendevhub/ui/button";
import { Checkbox } from "@opendevhub/ui/checkbox";
import { Input } from "@opendevhub/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListTodoIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { cn } from "@/lib/utils";

import type { ProjectTodo } from "../../../shared/types";
import { addTodo, fetchTodos, removeTodo, updateTodo } from "../../api";
import { Empty, muted, PageHeader, Section } from "../../components/page";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import { useNavigate } from "../../routing";
import { useCurrentProject } from "../../shell/current-project";
import { chatStartHref } from "../chat/chat";
import { useProjectView } from "./project-layout";

/** The project's To-do page. */
export const projectTodosHref = (projectId: string) =>
  `/p/${encodeURIComponent(projectId)}/todos`;

const todosKey = (projectId: string) => ["todos", projectId] as const;

const useTodosQuery = (projectId: string | undefined) =>
  useQuery({
    enabled: projectId !== undefined,
    queryFn: ({ signal }) => fetchTodos(projectId ?? "", signal),
    queryKey: todosKey(projectId ?? ""),
  });

/** How many of the project's to-dos are still open; 0 while they load. */
export const useOpenTodoCount = (projectId: string | undefined): number =>
  useTodosQuery(projectId).data?.todos.filter((t) => !t.done).length ?? 0;

const useTodos = (projectId: string) => {
  const queryClient = useQueryClient();
  const query = useTodosQuery(projectId);
  const set = (fn: (todos: ProjectTodo[]) => ProjectTodo[]) =>
    queryClient.setQueryData(
      todosKey(projectId),
      (old: { todos: ProjectTodo[] } | undefined) =>
        old ? { todos: fn(old.todos) } : old
    );
  const add = useMutation({
    mutationFn: (text: string) => addTodo(projectId, text),
    onSuccess: (todo) => set((todos) => [...todos, todo]),
  });
  const update = useMutation({
    mutationFn: (v: { id: number; done: boolean }) =>
      updateTodo(projectId, v.id, { done: v.done }),
    onSuccess: (todo) =>
      set((todos) => todos.map((t) => (t.id === todo.id ? todo : t))),
  });
  const remove = useMutation({
    mutationFn: (id: number) => removeTodo(projectId, id),
    onSuccess: (_, id) => set((todos) => todos.filter((t) => t.id !== id)),
  });
  const error = query.error ?? add.error ?? update.error ?? remove.error;
  return { add, error, query, remove, update };
};

const TodoRow = (props: {
  todo: ProjectTodo;
  onDone: (done: boolean) => void;
  onStartChat: () => void;
  onStartTask: () => void;
  onDelete: () => void;
}) => {
  const { todo } = props;
  return (
    <li className="group hover:bg-muted/50 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <Checkbox
        id={`todo-${todo.id}`}
        checked={todo.done}
        onCheckedChange={(checked) => props.onDone(checked === true)}
      />
      <label
        htmlFor={`todo-${todo.id}`}
        className={cn(
          "min-w-0 flex-1 text-sm break-words",
          todo.done && "text-muted-foreground line-through"
        )}
      >
        {todo.text}
      </label>
      <div className="flex items-center gap-1 max-sm:basis-full max-sm:pl-7">
        <Button variant="ghost" size="sm" onClick={props.onStartChat}>
          <SquarePenIcon /> Start chat
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onStartTask}>
          <ListTodoIcon /> Start task
        </Button>
        <Tip label="Delete">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={`Delete “${todo.text}”`}
            onClick={props.onDelete}
          >
            <Trash2Icon />
          </Button>
        </Tip>
      </div>
    </li>
  );
};

/**
 * A project's to-do list: an add field, then the open to-dos and the done ones. Each one can start a chat
 * (Chat's start page, its text in the composer) or a task (New task, its text as the prompt).
 */
export const ProjectTodos = () => {
  const view = useProjectView();
  const projectId = view.project.id;
  const [draft, setDraft] = useState("");
  const { add, error, query, remove, update } = useTodos(projectId);
  const { newTask } = useDash();
  const { choose } = useCurrentProject();
  const navigate = useNavigate();
  const todos = query.data?.todos ?? [];
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    add.mutate(text, { onSuccess: () => setDraft("") });
  };

  const row = (todo: ProjectTodo) => (
    <TodoRow
      key={todo.id}
      todo={todo}
      onDone={(isDone) => update.mutate({ done: isDone, id: todo.id })}
      onStartChat={() => {
        choose(projectId);
        void navigate(chatStartHref(todo.text));
      }}
      onStartTask={() => newTask(projectId, { prompt: todo.text })}
      onDelete={() => remove.mutate(todo.id)}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader title="To-do" description={view.project.name} />
      <form onSubmit={submit} className="flex gap-2">
        <Input
          autoFocus
          placeholder="Add a to-do"
          aria-label="New to-do"
          maxLength={500}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!draft.trim() || add.isPending}
        >
          <PlusIcon /> Add
        </Button>
      </form>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      )}
      {query.isSuccess && todos.length === 0 && (
        <Empty title="Nothing to do yet">
          <p className={muted}>
            Note what needs doing here, then start a chat or a task from it.
          </p>
        </Empty>
      )}
      {open.length > 0 && (
        <Section title="Open" hint={open.length}>
          <ul className="divide-y">{open.map(row)}</ul>
        </Section>
      )}
      {done.length > 0 && (
        <Section title="Done" hint={done.length}>
          <ul className="divide-y">{done.map(row)}</ul>
        </Section>
      )}
    </div>
  );
};
