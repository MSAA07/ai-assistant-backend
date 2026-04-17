import { spawn } from "node:child_process";

const target = process.argv[2];

const TARGETS = {
  server: "server.js",
  worker: "worker.js",
};

if (!TARGETS[target]) {
  console.error(
    `Usage: node scripts/run-with-prisma.js <${Object.keys(TARGETS).join("|")}>`,
  );
  process.exit(1);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const isWindowsCmd = process.platform === "win32" && command.endsWith(".cmd");
    const child = spawn(
      isWindowsCmd ? "cmd.exe" : command,
      isWindowsCmd ? ["/c", command, ...args] : args,
      {
        stdio: "inherit",
        env: process.env,
        shell: false,
        windowsHide: true,
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

const prismaCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const nodeCommand = process.platform === "win32" ? "node.exe" : "node";
const prismaArgs = ["prisma", "db", "push", "--accept-data-loss"];

try {
  const prismaExitCode = await run(prismaCommand, prismaArgs);
  if (prismaExitCode !== 0) {
    process.exit(prismaExitCode);
  }

  const targetExitCode = await run(nodeCommand, [TARGETS[target]]);
  process.exit(targetExitCode);
} catch (error) {
  console.error("[run-with-prisma] startup failed:", error);
  process.exit(1);
}
