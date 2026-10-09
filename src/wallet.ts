/**
 * `node dist/main.js new-wallet`: gives the bot its own wallet for live trading.
 *
 * Makes a fresh random key and writes it into .env as PRIVATE_KEY, printing only
 * the address. The key is never shown, so it can't end up in a chat, a log or a
 * screenshot. It never replaces a key that is already there.
 *
 * This wallet only ever needs gas money: your own wallet owns the ArbExecutor and
 * withdraws profits from it, and authorises this one as its operator.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

export interface NewWalletResult {
  created: boolean;
  /** The bot wallet's address (the existing one when nothing was created). */
  address: string;
  reason?: string;
  /** BOT_ADDRESS pointed at another wallet and was changed to match. */
  botAddressUpdated?: boolean;
}

const valueOf = (line: string): string =>
  line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");

export function addBotWalletToEnv(envPath = ".env", make: () => { address: string; privateKey: string } = () => Wallet.createRandom()): NewWalletResult {
  const file = resolve(envPath);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const keyAt = lines.findIndex((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  if (keyAt >= 0 && valueOf(lines[keyAt]!)) {
    let address = "";
    try {
      address = new Wallet(valueOf(lines[keyAt]!)).address;
    } catch {
      /* not a valid key: still refuse to touch it */
    }
    return { created: false, address, reason: "PRIVATE_KEY is already set in .env" };
  }
  const w = make();
  const keyLine = `PRIVATE_KEY=${w.privateKey}`;
  if (keyAt >= 0) lines[keyAt] = keyLine;
  else if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, keyLine);
  else lines.push(keyLine, "");
  // A BOT_ADDRESS for some other wallet would make the dashboard fund and authorise the wrong one.
  let botAddressUpdated = false;
  const botAt = lines.findIndex((l) => /^\s*BOT_ADDRESS\s*=/.test(l));
  if (botAt >= 0 && valueOf(lines[botAt]!) && valueOf(lines[botAt]!).toLowerCase() !== w.address.toLowerCase()) {
    lines[botAt] = `BOT_ADDRESS=${w.address}`;
    botAddressUpdated = true;
  }
  writeFileSync(file, lines.join(eol));
  return { created: true, address: w.address, botAddressUpdated };
}
