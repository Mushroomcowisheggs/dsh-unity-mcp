import { McpUnityError, ErrorType } from '../utils/errors.js';
import * as z from 'zod';
const toolName = 'get_play_mode_status';
const toolDescription = 'Gets Unity play mode status (isPlaying, isPaused).';
const paramsSchema = z.object({});
export function registerGetPlayModeStatusTool(server, mcpUnity, logger) {
    logger.info(`Registering tool: ${toolName}`);
    server.tool(toolName, toolDescription, paramsSchema.shape, async (params) => {
        try {
            logger.info(`Executing tool: ${toolName}`, params);
            const result = await toolHandler(mcpUnity, params);
            logger.info(`Tool execution successful: ${toolName}`);
            return result;
        }
        catch (error) {
            logger.error(`Tool execution failed: ${toolName}`, error);
            throw error;
        }
    });
}
async function toolHandler(mcpUnity, params) {
    const response = await mcpUnity.sendRequest({
        method: toolName,
        params
    });
    if (!response.success) {
        throw new McpUnityError(ErrorType.TOOL_EXECUTION, response.message || 'Failed to get play mode status');
    }
    const statusText = response.isPlaying
        ? (response.isPaused ? 'Play mode (paused)' : 'Play mode')
        : 'Edit mode';
    return {
        content: [
            {
                type: response.type,
                text: statusText
            }
        ],
        data: {
            isPlaying: response.isPlaying,
            isPaused: response.isPaused
        }
    };
}
