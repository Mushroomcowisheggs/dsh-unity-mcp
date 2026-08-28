import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../utils/logger.js';
export declare function registerUnityDashboardAppResource(server: McpServer, logger: Logger): void;
export declare function readUnityDashboardHtml(): {
    text: string;
    mimeType: string;
};
