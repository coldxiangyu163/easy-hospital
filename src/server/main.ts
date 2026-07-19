import { startApplicationFromEnvironment } from './runtime.js';

const application = await startApplicationFromEnvironment({
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'production',
});
console.log(`easy-hospital 已启动：${application.url}`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在停止 easy-hospital…`);
  try {
    await application.close();
  } catch (error) {
    console.error('easy-hospital 停止失败', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
