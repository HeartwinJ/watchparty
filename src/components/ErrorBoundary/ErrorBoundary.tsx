import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@mantine/core";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { StatusPage, statusStyles } from "../StatusPage/StatusPage";

/**
 * Catches errors thrown while rendering a page, so one broken component shows a "Something went wrong" card with a
 * reload button instead of unmounting everything and leaving a blank page. React still logs the error to the console.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Page crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <StatusPage
        icon={<IconAlertTriangle size={22} />}
        title="Something went wrong"
        actions={
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        }
      >
        <p className={statusStyles.text}>
          This page hit an unexpected error. Reloading usually fixes it.
        </p>
      </StatusPage>
    );
  }
}
