import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type React from "react";

/**
 * App-wide toasts (top-centre, max 3; <Notifications> is mounted in index.tsx).
 * Use this instead of calling @mantine/notifications directly so styling and timing stay consistent.
 */
export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  tone?: ToastTone;
  /** Optional title line above the message */
  title?: string;
  /** Auto-close delay in ms. Defaults to 4500, or 7000 when there is an action. */
  duration?: number;
  /** Stable id so repeated toasts replace each other instead of stacking */
  id?: string;
  action?: ToastAction;
  /** More than one button (shown after `action`) */
  actions?: ToastAction[];
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

const toneColor: Record<ToastTone, string | undefined> = {
  neutral: undefined,
  success: "var(--wp-success)",
  warning: "var(--wp-warning)",
  danger: "var(--wp-danger)",
};

export function toast(message: React.ReactNode, opts: ToastOptions = {}) {
  const id = opts.id ?? `toast-${Math.random().toString(36).slice(2)}`;
  if (opts.id) {
    notifications.hide(opts.id);
  }
  const actions = [
    ...(opts.action ? [opts.action] : []),
    ...(opts.actions ?? []),
  ];
  const button = (action: ToastAction) => (
    <Button
      key={action.label}
      size="compact-sm"
      variant="light"
      onClick={() => {
        notifications.hide(id);
        action.onClick();
      }}
    >
      {action.label}
    </Button>
  );
  return notifications.show({
    id,
    title: opts.title,
    color: toneColor[opts.tone ?? "neutral"],
    autoClose: opts.duration ?? (actions.length ? 7000 : 4500),
    withBorder: true,
    message:
      actions.length === 1 ? (
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">{message}</Text>
          {button(actions[0])}
        </Group>
      ) : actions.length > 1 ? (
        <>
          <Text size="sm">{message}</Text>
          <Group gap="xs" mt={6}>
            {actions.map(button)}
          </Group>
        </>
      ) : (
        message
      ),
  });
}
