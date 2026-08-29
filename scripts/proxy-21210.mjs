import http from "http";
import net from "net";

const TARGET_PORT = 5000;
const PROXY_PORT = 21210;

function waitForTarget(ms = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    function probe() {
      const sock = net.connect(TARGET_PORT, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() < deadline) setTimeout(probe, 300);
        else resolve();
      });
    }
    probe();
  });
}

async function main() {
  process.stdout.write(`[proxy] waiting for :${TARGET_PORT} ...\n`);
  await waitForTarget();
  process.stdout.write(`[proxy] :${TARGET_PORT} ready\n`);

  const server = http.createServer((req, res) => {
    const opts = {
      hostname: "127.0.0.1",
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${TARGET_PORT}` },
    };
    const upstream = http.request(opts, (pr) => {
      res.writeHead(pr.statusCode ?? 502, pr.headers);
      pr.pipe(res, { end: true });
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream, { end: true });
  });

  server.on("upgrade", (req, clientSocket, head) => {
    const conn = net.connect(TARGET_PORT, "127.0.0.1");
    conn.once("connect", () => {
      const raw =
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
        "\r\n\r\n";
      conn.write(raw);
      if (head && head.length) conn.write(head);
      conn.pipe(clientSocket, { end: true });
      clientSocket.pipe(conn, { end: true });
    });
    conn.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => conn.destroy());
  });

  server.listen(PROXY_PORT, "0.0.0.0", () => {
    process.stdout.write(`[proxy] :${PROXY_PORT} → :${TARGET_PORT}\n`);
  });
}

main();
