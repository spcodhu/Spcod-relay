import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { sendWithBackpressure } from "../src/index.js";

function socket(bufferedAmount: number): WebSocket {
  return {
    readyState: 1,
    bufferedAmount,
    send: vi.fn(),
    terminate: vi.fn(),
  } as unknown as WebSocket;
}

describe("WebSocket 发送背压", () => {
  it("超过缓冲预算直接终止，不再继续写入", () => {
    const ws = socket(1025);
    sendWithBackpressure(ws, "frame", 1024);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("预算内正常发送；发送回调错误也终止", () => {
    const ws = socket(10);
    sendWithBackpressure(ws, "frame", 1024);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.terminate).not.toHaveBeenCalled();
    const callback = vi.mocked(ws.send).mock.calls[0]?.[1];
    if (typeof callback === "function") callback(new Error("broken pipe"));
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});
