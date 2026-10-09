/**
 * Compiles contracts/ArbExecutor.sol and contracts/RouteExecutor.sol with
 * solc 0.8.26 (optimizer 1000 runs, evm cancun) and writes the bytecode the
 * bot and the dashboard use:
 *
 *   src/simBytecode.ts       ArbExecutor runtime: eth_call state-override simulation,
 *                            and the code the live readiness check expects at EXECUTOR_ADDRESS
 *   src/simBytecodeRoute.ts  RouteExecutor runtime: state-override simulation of routes
 *   src/deployBytecode.ts    creation bytecode for the dashboard's Deploy buttons
 *   build/*.json             abi + bytecode, for Remix / Foundry
 *
 * Either compiler works and gives identical output:
 *   SOLC=/path/to/solc-0.8.26 node scripts/build-bytecode.cjs      (native binary)
 *   npm install --no-save solc@0.8.26 && node scripts/build-bytecode.cjs   (solc-js)
 * Then: npm run build
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const WANT = "0.8.26";
const root = path.join(__dirname, "..");
const names = ["ArbExecutor", "RouteExecutor", "LiquidationExecutor"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(names.map((n) => [`${n}.sol`, { content: fs.readFileSync(path.join(root, "contracts", `${n}.sol`), "utf8") }])),
  settings: {
    optimizer: { enabled: true, runs: 1000 },
    evmVersion: "cancun",
    outputSelection: Object.fromEntries(names.map((n) => [`${n}.sol`, { [n]: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] }])),
  },
};

let output;
let version;
if (process.env.SOLC) {
  version = execFileSync(process.env.SOLC, ["--version"], { encoding: "utf8" }).match(/Version: (\S+)/)[1];
  output = execFileSync(process.env.SOLC, ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 << 20 });
} else {
  let solc;
  try {
    solc = require("solc");
  } catch {
    console.error(`No compiler. Either set SOLC to a solc ${WANT} binary, or run:  npm install --no-save solc@${WANT}`);
    process.exit(1);
  }
  version = solc.version();
  output = solc.compile(JSON.stringify(input));
}
// "0.8.26+commit.8a97fa7a.Linux.g++" / "...Emscripten.clang" -> "0.8.26+commit.8a97fa7a" (the bytecode is the same)
version = version.split(".").slice(0, 4).join(".").replace(/\.(Linux|Emscripten|Darwin|Windows).*$/, "");
if (!version.startsWith(WANT + "+")) {
  console.error(`Expected solc ${WANT}, got ${version}: the bytecode would not match the committed files.`);
  process.exit(1);
}
const out = JSON.parse(output);
for (const e of out.errors || []) if (e.severity === "error" || process.env.VERBOSE) console.error(e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === "error")) process.exit(1);

const art = (n) => {
  const c = out.contracts[`${n}.sol`][n];
  return { abi: c.abi, creation: "0x" + c.evm.bytecode.object, runtime: "0x" + c.evm.deployedBytecode.object };
};
const arb = art("ArbExecutor");
const route = art("RouteExecutor");
const liq = art("LiquidationExecutor");
const settings = `solc ${version}, optimizer 1000 runs, evm cancun`;
const bytes = (hex) => (hex.length - 2) / 2;

fs.writeFileSync(
  path.join(root, "src", "simBytecode.ts"),
  `/**
 * ArbExecutor runtime bytecode. Used for eth_call state-override simulation
 * (injected at an address with no code, so paper trading needs no deployment),
 * and by the live readiness check, which only trades through a contract whose
 * code is exactly this.
 * Generated from contracts/ArbExecutor.sol with ${settings}.
 * Do not edit by hand; rebuild with scripts/build-bytecode.cjs.
 */
export const SIM_EXECUTOR_RUNTIME = "${arb.runtime}";
export const SIM_EXECUTOR_BYTES = ${bytes(arb.runtime)};
`,
);
fs.writeFileSync(
  path.join(root, "src", "simBytecodeRoute.ts"),
  `/**
 * RouteExecutor runtime bytecode for eth_call state-override simulation.
 * Generated from contracts/RouteExecutor.sol with ${settings}.
 * Do not edit by hand; rebuild with scripts/build-bytecode.cjs.
 */
export const ROUTE_EXECUTOR_RUNTIME = "${route.runtime}";
`,
);
fs.writeFileSync(
  path.join(root, "src", "simBytecodeLiquidation.ts"),
  `/**
 * LiquidationExecutor runtime bytecode for eth_call state-override simulation,
 * and the code the live readiness check expects at LIQ_EXECUTOR_ADDRESS.
 * Generated from contracts/LiquidationExecutor.sol with ${settings}.
 * Do not edit by hand; rebuild with scripts/build-bytecode.cjs.
 */
export const LIQ_EXECUTOR_RUNTIME = "${liq.runtime}";
`,
);
fs.writeFileSync(
  path.join(root, "src", "deployBytecode.ts"),
  `/**
 * Creation bytecode for the dashboard's Deploy buttons: your wallet sends it as
 * a contract-creation transaction and becomes the contract's owner.
 * Generated from contracts/*.sol with ${settings},
 * together with src/simBytecode.ts, src/simBytecodeRoute.ts and src/simBytecodeLiquidation.ts.
 * Rebuild with scripts/build-bytecode.cjs.
 */
export const ROUTE_EXECUTOR_CREATION = "${route.creation}";
export const ROUTE_EXECUTOR_COMPILER = "${settings}";
export const ARB_EXECUTOR_CREATION = "${arb.creation}";
export const ARB_EXECUTOR_COMPILER = "${settings}";
export const LIQ_EXECUTOR_CREATION = "${liq.creation}";
export const LIQ_EXECUTOR_COMPILER = "${settings}";
`,
);
fs.mkdirSync(path.join(root, "build"), { recursive: true });
for (const [n, a] of [["ArbExecutor", arb], ["RouteExecutor", route], ["LiquidationExecutor", liq]]) {
  fs.writeFileSync(path.join(root, "build", `${n}.json`), JSON.stringify({ compiler: settings, abi: a.abi, bytecode: a.creation, deployedBytecode: a.runtime }, null, 2));
}
console.log(`${settings}`);
console.log(`ArbExecutor: runtime ${bytes(arb.runtime)} bytes, creation ${bytes(arb.creation)} bytes`);
console.log(`RouteExecutor: runtime ${bytes(route.runtime)} bytes, creation ${bytes(route.creation)} bytes`);
console.log(`LiquidationExecutor: runtime ${bytes(liq.runtime)} bytes, creation ${bytes(liq.creation)} bytes`);
console.log("wrote src/simBytecode*.ts, src/deployBytecode.ts and build/*.json; now run: npm run build");
