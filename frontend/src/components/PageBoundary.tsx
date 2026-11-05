// Every app page renders inside this boundary. While a page's code downloads it shows a loading state (inside the
// page area, so the page transition completes normally), and if a page throws while rendering it shows the error
// with "Try again" instead of unmounting the whole app (which left a black screen with no navigation).
import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorBox, Spinner } from "./ui";

class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page failed to render:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid gap-3" data-testid="page-error">
        <ErrorBox message={`This page could not be displayed: ${this.state.error.message}`} onRetry={() => this.setState({ error: null })} />
        <p className="text-[0.85rem] text-text-3">The rest of What-if still works. <Link to="/app" className="underline">Go to the dashboard</Link> or use the menu.</p>
      </div>
    );
  }
}

export function PageLoading() {
  return <div className="grid min-h-[40vh] place-items-center text-text-3" role="status" aria-label="Loading page"><Spinner size={22} /></div>;
}

export function PageBoundary({ children }: { children: ReactNode }) {
  return <Catch><Suspense fallback={<PageLoading />}>{children}</Suspense></Catch>;
}
