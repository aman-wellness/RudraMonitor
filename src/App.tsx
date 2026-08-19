import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./router";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider } from "./context/AuthContext";
import ErrorBoundary from "./components/feature/ErrorBoundary";
import DialogHost from "./components/DialogHost";

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <I18nextProvider i18n={i18n}>
            <BrowserRouter basename={__BASE_PATH__}>
              <AppRoutes />
            </BrowserRouter>
            {/* Toast surface + the modal backing confirmDialog()/promptDialog().
                Inside ThemeProvider so toasts follow the theme; outside the
                router so navigation can't unmount an open dialog. */}
            <DialogHost />
          </I18nextProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
