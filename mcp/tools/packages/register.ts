import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { exportDeckPackage, exportDeckPackageConfig } from "./export-deck-package.js";
import { importDeckPackage, importDeckPackageConfig } from "./import-deck-package.js";

export function registerPackageTools(server: McpServer): void {
  server.registerTool("export-deck-package", exportDeckPackageConfig, withToolErrorHandling(exportDeckPackage));
  server.registerTool("import-deck-package", importDeckPackageConfig, withToolErrorHandling(importDeckPackage));
}
