/**
 * Encrypted operator-key store.
 *
 * The bot's hot key can be kept as a passphrase-encrypted scrypt keystore (the Web3 Secret
 * Storage format ethers reads) instead of PRIVATE_KEY in plaintext in .env — so the raw key
 * never exists at rest, in a backup, a screenshot or shell history. This is defence-in-depth:
 * the real protection is still the owner/operator contract model (this key can trade through the
 * executor but can never withdraw, so a leak costs gas, not principal). It's primarily for a
 * remote send-path box (the Ashburn move); the home PC can keep PRIVATE_KEY unchanged.
 *
 * `encrypt-wallet` writes data/keystore.json from the current PRIVATE_KEY (or a fresh key) and
 * prints only the address — it NEVER edits .env (that's yours). At boot, if KEYSTORE_FILE is set
 * and PRIVATE_KEY is absent, the key is decrypted into process.env.PRIVATE_KEY in memory only, so
 * config.ts and executor.ts are untouched. There is no silent plaintext fallback: a KEYSTORE_FILE
 * that fails to decrypt stops the bot.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Wallet, encryptKeystoreJson } from "ethers";

export interface EncryptResult {
  address: string;
  path: string;
  /** A fresh key was generated because neither a key argument nor PRIVATE_KEY was present. */
  createdKey: boolean;
}

/**
 * Encrypt an operator key into a scrypt keystore. Uses the current PRIVATE_KEY (or the one passed,
 * or a fresh random key). Never touches .env. `scryptN` lowers the work factor for tests only.
 */
export async function encryptWalletToKeystore(opts: {
  path?: string;
  privateKey?: string;
  passphrase: string;
  scryptN?: number;
  overwrite?: boolean;
}): Promise<EncryptResult> {
  if (!opts.passphrase) throw new Error("a passphrase is required");
  const path = resolve(opts.path ?? "data/keystore.json");
  if (existsSync(path) && !opts.overwrite) throw new Error(`keystore already exists at ${path} (pass --force to overwrite)`);
  let createdKey = false;
  let pk = opts.privateKey ?? process.env.PRIVATE_KEY;
  if (!pk) {
    pk = Wallet.createRandom().privateKey;
    createdKey = true;
  }
  const w = new Wallet(pk);
  const json = await encryptKeystoreJson(
    { address: w.address, privateKey: w.privateKey },
    opts.passphrase,
    opts.scryptN ? { scrypt: { N: opts.scryptN, r: 8, p: 1 } } : undefined,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, { mode: 0o600 });
  return { address: w.address, path, createdKey };
}

/**
 * At boot: decrypt the keystore and inject the key into process.env.PRIVATE_KEY (memory only, never
 * logged — the same discipline the plaintext key already lives under). Throws on any failure, so a
 * configured keystore never silently falls back to a plaintext path.
 */
export async function loadKeystoreIntoEnv(opts: { keystoreFile: string; passphrase: string }): Promise<boolean> {
  const file = resolve(opts.keystoreFile);
  if (!existsSync(file)) throw new Error(`KEYSTORE_FILE is set but no keystore was found at ${file}`);
  const json = readFileSync(file, "utf8");
  const w = await Wallet.fromEncryptedJson(json, opts.passphrase);
  process.env.PRIVATE_KEY = w.privateKey;
  return true;
}

/**
 * Passphrase for an EXISTING keystore, in order of preference: KEYSTORE_PASSPHRASE (env),
 * KEYSTORE_PASSPHRASE_FILE (a path — e.g. a systemd `LoadCredentialEncrypted` credential), then a
 * muted interactive prompt. This is how an unattended box (systemd) boots without a prompt.
 */
export async function resolvePassphrase(prompt = "Keystore passphrase: "): Promise<string> {
  if (process.env.KEYSTORE_PASSPHRASE) return process.env.KEYSTORE_PASSPHRASE;
  const f = process.env.KEYSTORE_PASSPHRASE_FILE;
  if (f && existsSync(resolve(f))) return readFileSync(resolve(f), "utf8").replace(/\r?\n$/, "");
  return readSecret(prompt);
}

/** Passphrase for a NEW keystore: KEYSTORE_PASSPHRASE if scripted, else prompt twice and confirm. */
export async function newPassphrase(): Promise<string> {
  if (process.env.KEYSTORE_PASSPHRASE) return process.env.KEYSTORE_PASSPHRASE;
  const a = await readSecret("Choose a keystore passphrase: ");
  if (a.length < 8) throw new Error("passphrase too short — use at least 8 characters");
  const b = await readSecret("Confirm passphrase: ");
  if (a !== b) throw new Error("passphrases did not match");
  return a;
}

/** Read a line without echoing it (for a TTY); read a piped line plainly otherwise. */
function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise<string>((res) => {
      let buf = "";
      input.setEncoding("utf8");
      const onData = (c: string): void => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          input.off("data", onData);
          res(buf.slice(0, nl).replace(/\r$/, ""));
        }
      };
      input.on("data", onData);
    });
  }
  return new Promise<string>((res) => {
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const orig = asMutable._writeToOutput?.bind(rl);
    let muted = false;
    asMutable._writeToOutput = (s: string): void => {
      if (!muted || s.includes("\n")) orig?.(s);
    };
    process.stdout.write(prompt);
    muted = true;
    rl.question("", (ans) => {
      muted = false;
      process.stdout.write("\n");
      rl.close();
      res(ans);
    });
  });
}
