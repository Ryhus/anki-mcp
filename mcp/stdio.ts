import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { createServer } from "./create-server.js";

// A 25 MiB media file needs about 33.4 MiB in base64, plus JSON overhead.
export const STDIO_MAX_BUFFER_SIZE = 40 * 1024 * 1024;

interface StdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  onerror?: (error: Error) => void;
}

/** Serves modern and legacy clients with a bounded, media-sized input buffer. */
export function startStdioServer({
  stdin = process.stdin,
  stdout = process.stdout,
  onerror = (error) => console.error("MCP stdio error:", error),
}: StdioOptions = {}): StdioServerHandle {
  const transport = new StdioServerTransport(stdin, stdout, {
    maxBufferSize: STDIO_MAX_BUFFER_SIZE,
  });

  return serveStdio(createServer, { transport, legacy: "serve", onerror });
}
