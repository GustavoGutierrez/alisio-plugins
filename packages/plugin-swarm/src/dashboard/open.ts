import { spawn } from "node:child_process";

/**
 * Open a URL in the default browser, best effort. The URL is built by the plugin (loopback host,
 * numeric port, hex token), the command is an argument array and every failure is swallowed:
 * the operator can always open the printed link by hand.
 */
export function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}
