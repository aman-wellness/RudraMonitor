import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";

// Use HashRouter everywhere — no nginx SPA fallback needed when served
// from a subpath, and works fine inside Capacitor's file:// webview.
// URLs look like /m/#/recent on web, which is acceptable for a tiny
// utility app.
const Router = ({ children }: { children: React.ReactNode }) => <HashRouter>{children}</HashRouter>;
void BrowserRouter;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>,
);
