import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { CodexAcpAgent } from "./agent.ts";
import { nodeToWebReadable, nodeToWebWritable } from "./stream.ts";

export function runAcp(): void {
  // stdout is ACP transport; route app logs to stderr
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((client) => new CodexAcpAgent(client), stream);
}
