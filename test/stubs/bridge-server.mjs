// 测试替身：一个最小的 Unity 网桥（http 层 WebSocket 握手 + Basic 认证）。
//
// 只实现测试需要的部分：校验 Basic 凭据，成功时回 101（带正确的
// Sec-WebSocket-Accept），失败时回 401/501。不实现数据帧——需要帧的用例
// （真实 ws 客户端连接）也只断言连接是否建立。
import net from "node:net";
import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function parseHandshakeRequest(request) {
  const lines = request.split("\r\n");
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { requestLine: lines[0] ?? "", headers };
}

/** 从 Authorization 头里取出 Basic 密码（即项目 token）。 */
export function tokenFromHeaders(headers) {
  const authorization = headers["authorization"];
  if (!authorization || !/^basic /i.test(authorization)) return undefined;
  const decoded = Buffer.from(authorization.replace(/^basic /i, ""), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 ? decoded.slice(separator + 1) : decoded;
}

/**
 * 启动一个假网桥。
 * options.acceptedTokens: 允许的 token 集合（空集合 = 不校验认证）；
 * options.path: 期望的请求路径（默认 /McpUnity）。
 */
export async function startBridgeStub(options = {}) {
  const acceptedTokens = new Set(options.acceptedTokens ?? []);
  const expectedPath = options.path ?? "/McpUnity";
  const handshakes = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      const raw = chunk.toString("latin1");
      const { requestLine, headers } = parseHandshakeRequest(raw);
      const path = requestLine.split(" ")[1];
      const token = tokenFromHeaders(headers);
      handshakes.push({ path, token, headers, raw });

      if (path !== expectedPath) {
        socket.end("HTTP/1.1 501 Not Implemented\r\nServer: bridge-stub\r\n\r\n");
        return;
      }
      if (acceptedTokens.size > 0 && !acceptedTokens.has(token)) {
        socket.end(
          "HTTP/1.1 401 Unauthorized\r\nServer: bridge-stub\r\n" +
            'WWW-Authenticate: Basic realm="MCP Unity"\r\n\r\n'
        );
        return;
      }
      const key = headers["sec-websocket-key"] ?? "";
      const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      if (typeof options.onOpen === "function") options.onOpen(socket, { path, token, headers });
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    handshakes,
    // 可变集合：用例可以在运行中轮换"项目 token"来模拟切换项目/重新生成 token
    acceptedTokens,
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
