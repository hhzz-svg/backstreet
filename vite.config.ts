import { defineConfig, type Plugin } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 开发期截图落盘端点。
 *
 * 这个项目的画面是主要交付物之一，但开发过程中不一定有可见的浏览器窗口
 * （隐藏面板 / 无头环境下 canvas 根本不合成帧，截图工具拿不到画面）。
 * 页面里强制渲染一帧后把 canvas 转成 dataURL POST 到这里，直接落到
 * shots/ 目录，就能脱离窗口可见性做视觉验证。
 *
 * 仅 dev server 生效，不进生产构建。
 */
function screenshotEndpoint(): Plugin {
  return {
    name: 'backstreet-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const name = (req.headers['x-shot-name'] as string) || 'shot';
            const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(body.trim());
            if (!m) {
              res.statusCode = 400;
              res.end('expected a data:image/(png|jpeg);base64 payload');
              return;
            }
            const dir = resolve(server.config.root, 'shots');
            mkdirSync(dir, { recursive: true });
            const file = resolve(dir, `${name.replace(/[^\w.-]/g, '_')}.${m[1] === 'png' ? 'png' : 'jpg'}`);
            writeFileSync(file, Buffer.from(m[2], 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file, bytes: m[2].length }));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotEndpoint()],
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
});
