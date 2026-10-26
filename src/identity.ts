import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
type Ancestor = { pid: number; executable: string };
type NativeAgent = { pid: number; sessionId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ancestralClaudeIdentity(
  ancestors: Ancestor[],
  agents: NativeAgent[],
) {
  for (const ancestor of ancestors) {
    const matches = agents.filter(
      (agent) => agent.pid === ancestor.pid && uuid.test(agent.sessionId),
    );
    if (matches.length > 1)
      throw new Error(
        "Claude returned ambiguous identity for the owning process",
      );
    if (matches.length === 1) return matches[0]!.sessionId;
  }
  return undefined;
}

// Resolve only the MCP process's actual owner, using provider-native PID/UUID
// discovery. Never infer an identity from a title, cwd or file timestamp.
export async function discoverOwningClaude() {
  let ancestors: Ancestor[] = [];
  if (process.platform === "win32") {
    const command = `$ancestorId=${process.ppid}; $rows=@(); for($i=0;$i -lt 16 -and $ancestorId -gt 0;$i++){ $entry=Get-CimInstance Win32_Process -Filter "ProcessId=$ancestorId"; if(!$entry){break}; $rows+=@{pid=[int]$entry.ProcessId; executable=[string]$entry.ExecutablePath}; $ancestorId=[int]$entry.ParentProcessId }; ConvertTo-Json -InputObject @($rows) -Compress`;
    const result = await exec(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 3000, windowsHide: true, maxBuffer: 32768 },
    );
    ancestors = JSON.parse(result.stdout) as Ancestor[];
  } else {
    let pid = process.ppid;
    for (let n = 0; n < 16 && pid > 1; n++) {
      ancestors.push({ pid, executable: "" });
      const result = await exec("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
        timeout: 500,
        maxBuffer: 4096,
      });
      pid = Number(result.stdout.trim());
    }
  }
  const executable =
    process.platform === "win32"
      ? ancestors.find((item) =>
          /[\\/]claude-code[\\/][0-9.]+[\\/].*[\\/]claude\.exe$/i.test(
            item.executable,
          ),
        )?.executable
      : join(homedir(), ".local/bin/claude");
  if (!executable) return undefined;
  const result = await exec(executable, ["agents", "--json"], {
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  const agents = JSON.parse(result.stdout) as NativeAgent[];
  if (!Array.isArray(agents))
    throw new Error("Claude native discovery did not return an agent list");
  const nativeId = ancestralClaudeIdentity(ancestors, agents);
  return nativeId ? { nativeId, executable } : undefined;
}
