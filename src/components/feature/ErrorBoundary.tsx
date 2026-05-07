import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches render-phase errors anywhere below it. We don't try to recover — just show a clear
// message and a "Reload" affordance instead of a white screen.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Surface to the console for the dev tools / log forwarders to pick up.
    // eslint-disable-next-line no-console
    console.error('[trackforce] render error:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-dark-900 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-dark-800 border border-dark-700 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center">
              <i className="ri-error-warning-line text-red-400 text-lg" />
            </span>
            <h1 className="text-base font-semibold text-white">Something went wrong</h1>
          </div>
          <p className="text-sm text-gray-400 mb-2">
            The dashboard hit an unexpected error. Reloading usually fixes it.
          </p>
          <pre className="text-[11px] text-gray-500 bg-dark-900 border border-dark-700 rounded p-2 mb-4 overflow-auto max-h-32">
            {this.state.error.message}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={this.reload}
              className="flex-1 px-3 py-2 rounded-lg bg-emerald-500 text-dark-900 text-xs font-medium hover:bg-emerald-400 transition-colors"
            >
              Reload
            </button>
            <button
              onClick={this.reset}
              className="px-3 py-2 rounded-lg border border-dark-700 text-gray-400 text-xs font-medium hover:bg-dark-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
