import { spawn } from "node:child_process";

const [, , target] = process.argv;

if (!target || (target !== "server" && target !== "worker")) {
  console.error('Usage: node scripts/run-with-prisma.js <server|worker>');
  process.exit(1);
}

const prismaArgs = ["prisma", "migrate", "deploy"];

const targetFile = target === "worker" ? "worker.js" : "server.js";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  console.log(
    `[startup] prisma strategy=migrate deploy target=${target}`,
  );

  await runCommand("npx", prismaArgs);
  await runCommand("node", [targetFile]);
}

main().catch((error) => {
  console.error("[startup] failed:", error);
  process.exit(1);
});
