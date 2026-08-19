import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n";
import "./legacy-compat";
import App from "./App.tsx";
import { initTelemetry, telemetryError } from "./telemetry";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { hasError: boolean };

class ViewerErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    telemetryError(error, { component: "react_error_boundary", errorType: "render" }, true);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const portuguese = typeof navigator === "undefined" || navigator.language.startsWith("pt");
    return (
      <main className="console-shell console-shell--empty">
        <section
          className="viewer viewer--empty"
          role="alert"
          aria-labelledby="runtime-error-title"
        >
          <div className="viewer__message">
            <span className="viewer__message-code">
              {portuguese ? "ERRO DE INTERFACE" : "UI ERROR"}
            </span>
            <h1 id="runtime-error-title">
              {portuguese ? "O monitor encontrou um problema." : "The monitor found a problem."}
            </h1>
            <p>
              {portuguese
                ? "A transmissão pode continuar disponível. Tente carregar a interface novamente."
                : "The stream may still be available. Try loading the interface again."}
            </p>
            <button type="button" onClick={() => this.setState({ hasError: false })}>
              {portuguese ? "Tentar novamente / Try again" : "Try again / Tentar novamente"}
            </button>
          </div>
        </section>
      </main>
    );
  }
}

// Start collector loading before React mounts, but never await it on the boot path.
void initTelemetry();

createRoot(document.getElementById("root")!).render(
  <ViewerErrorBoundary>
    <App />
  </ViewerErrorBoundary>,
);
