import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installTabSessionFetchPatch } from "./lib/tab-session";

// Per-tab session identity: two tabs in one browser profile stay connected to
// two different Deriv accounts with zero interference (see tab-session.ts).
installTabSessionFetchPatch();

createRoot(document.getElementById("root")!).render(<App />);
