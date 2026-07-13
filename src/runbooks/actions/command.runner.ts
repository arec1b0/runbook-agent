import { execFile } from "node:child_process";

/**
 * Result of an external command invocation.
 */
export interface CommandResult {
  /** Process exit code; -1 when the process failed to spawn. */
  readonly exitCode: number;

  /** Captured stdout, trimmed. */
  readonly stdout: string;

  /** Captured stderr, trimmed. */
  readonly stderr: string;
}

/**
 * Abstraction over external command execution.
 *
 * Actions depend on this interface, never on child_process directly:
 * unit tests inject a fake runner; production uses ExecFileRunner.
 * Commands are passed as an argv array — never as a shell string —
 * which eliminates shell injection by construction.
 */
export interface CommandRunner {
  /**
   * Runs a command with arguments.
   *
   * @param command - Executable name, e.g. "kubectl".
   * @param args - Argument vector.
   * @param timeoutMs - Hard timeout; the process is killed on expiry.
   * @returns Command result; never throws.
   */
  run(
    command: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<CommandResult>;
}

/**
 * Production CommandRunner based on child_process.execFile.
 * execFile (not exec) is used deliberately: no shell interpretation,
 * therefore no injection surface. Works on Windows 11 for kubectl,
 * which is a native executable.
 */
export class ExecFileRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          // error.code is string | number | undefined in Node types:
          // a string (e.g. "ENOENT") means spawn failure, a number is
          // the process exit code. Normalize explicitly so the type
          // is provably number on every path.
          const numericCode =
            error !== null && typeof error.code === "number"
              ? error.code
              : null;

          if (error !== null && numericCode === null) {
            // Spawn failure or timeout kill: no numeric exit code.
            resolve({
              exitCode: -1,
              stdout: stdout.trim(),
              stderr: `${stderr.trim()} ${error.message}`.trim(),
            });
            return;
          }

          resolve({
            exitCode: numericCode ?? 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      );
    });
  }
}