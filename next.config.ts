import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["better-sqlite3"],
  // Next 16 开发模式默认在终端记录 Server Function 名称与参数值；我们的
  // action 会接收原著正文与改写指令，必须关闭，避免正文进入日志。
  logging: {
    serverFunctions: false,
  },
};

export default nextConfig;
