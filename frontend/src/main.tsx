import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./extras.css";
import "./theme-dark.css";
import { initTheme } from "./theme";

initTheme();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
