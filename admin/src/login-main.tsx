import React from "react";
import ReactDOM from "react-dom/client";
import { LoginPage } from "./LoginPage";
import "./auggy.css";

const error = document.documentElement.dataset.auggyLoginError || undefined;
const action = `/console/login${window.location.search}`;

ReactDOM.createRoot(document.getElementById("login-root")!).render(
  <React.StrictMode>
    <LoginPage action={action} error={error} />
  </React.StrictMode>,
);
