import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./context/AuthContext";
import { LogProvider } from "./context/LogContext";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LogProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </LogProvider>
  </React.StrictMode>
);
