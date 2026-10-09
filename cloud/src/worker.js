/**
 * Cloudflare entry point. The dashboard page is the same file the bot serves
 * locally (ui/dashboard.html), bundled in as text at deploy time, so the
 * online copy and the local one never drift apart.
 */
import html from "../../ui/dashboard.html";
import { createApp, BotMirror } from "./app.js";

export { BotMirror };
export default createApp({ html });
