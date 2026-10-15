// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Keeps one failing view from blanking the page: if its children throw while
 * rendering, it shows what failed and a button to try again; the rest of the
 * app keeps working. (Rendering errors would otherwise unmount the whole tree.)
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** What the boundary wraps, for the message: "the cross-section". */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for developers; nothing leaves the browser.
    console.warn(`Puckworks: ${this.props.name} failed to draw`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="run-error" role="alert">
        <p>
          Sorry, {this.props.name} could not be drawn: {error.message}
        </p>
        <button
          type="button"
          className="button button-small"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
