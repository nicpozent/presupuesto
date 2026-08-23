import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import { App } from "./App.js";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
