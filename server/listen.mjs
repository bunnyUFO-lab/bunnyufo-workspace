// Listening on port 0 and keeping clear of the ports a browser will not connect to.
//
// Windows hands out any port from 1024 up when a server asks for port 0, so now and then a test
// server lands on a port that fetch and Chromium refuse ("bad port"): the client fails with an
// error or an HTTP 500. listenOnGoodPort listens on port 0 and, when the port it got is one of
// those, closes and listens again.

/**
 * The ports the Fetch standard blocks ("bad ports"); Chromium blocks the same list and a few more.
 * Source: https://fetch.spec.whatwg.org/#port-blocking (the "bad port" list).
 */
export const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isBadPort = port => BAD_PORTS.has(port);

const listenOnce = (server, host) => new Promise((resolve, reject) => {
  const failed = error => reject(error);
  server.once('error', failed);
  server.listen(0, host, () => { server.off('error', failed); resolve(server.address().port); });
});
const closeOnce = server => new Promise(resolve => server.close(() => resolve()));

/**
 * Listen on a random port that a browser will connect to. Resolves to { server, port }; with
 * `tries` bad ports in a row it throws instead of handing one out.
 */
export async function listenOnGoodPort(server, host = '127.0.0.1', { tries = 20, bad = isBadPort } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const port = await listenOnce(server, host);
    if (!bad(port)) return { server, port };
    await closeOnce(server);
  }
  throw new Error(`Got a port a browser refuses ${tries} times in a row`);
}
