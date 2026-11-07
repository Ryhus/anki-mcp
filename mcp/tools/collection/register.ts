import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { cancelCollectionOperation, cancelCollectionOperationConfig } from "./cancel-collection-operation.js";
import {
  checkCollectionIntegrity, checkCollectionIntegrityConfig, syncCollection, syncCollectionConfig,
  undoCollectionAction, undoCollectionActionConfig,
} from "./guarded-tools.js";
import { CollectionOperationRegistry } from "./operation-registry.js";
import {
  getCollectionInfo, getCollectionInfoConfig, getCollectionOperation, getCollectionOperationConfig,
  refreshCollection, refreshCollectionConfig,
} from "./read-tools.js";

export function registerCollectionTools(server: McpServer): void {
  const registry = new CollectionOperationRegistry();
  server.registerTool("get-collection-info", getCollectionInfoConfig, withToolErrorHandling(getCollectionInfo));
  server.registerTool("refresh-collection", refreshCollectionConfig, withToolErrorHandling((input) => refreshCollection(registry, input)));
  server.registerTool("sync-collection", syncCollectionConfig, withToolErrorHandling((input) => syncCollection(registry, input)));
  server.registerTool("check-collection-integrity", checkCollectionIntegrityConfig, withToolErrorHandling((input) => checkCollectionIntegrity(registry, input)));
  server.registerTool("undo-collection-action", undoCollectionActionConfig, withToolErrorHandling((input) => undoCollectionAction(registry, input)));
  server.registerTool("get-collection-operation", getCollectionOperationConfig, withToolErrorHandling((input) => getCollectionOperation(registry, input)));
  server.registerTool("cancel-collection-operation", cancelCollectionOperationConfig, withToolErrorHandling((input) => cancelCollectionOperation(registry, input)));
}
