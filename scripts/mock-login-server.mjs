/**
 * Minimal mock EvoMedis login server for the smoke harness.
 *
 * The orchestrator's per-user login (UserSessionStore) always uses a real
 * FetchTransport, so the smoke test needs an HTTP endpoint that answers
 * `POST .../login/index` with a Set-Cookie. Run data itself uses fixtures
 * (source:"fixture"), so this server only has to handle login.
 *
 * Behaviour:
 *   - username "baduser" -> 200 but re-renders the login page (no cookie) so
 *     the client treats it as a failed login.
 *   - any other username -> 200 with Set-Cookie: ci_session=<n>.
 *
 * Usage: node scripts/mock-login-server.mjs <port>
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4799);
let n = 0;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const isLogin = req.url?.includes('/login/index');
    const bad = /username=baduser(&|$)/.test(body);
    if (isLogin && !bad) {
      n += 1;
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': `ci_session=mock${n}; Path=/; HttpOnly`,
      });
      res.end('<html><body>dashboard</body></html>');
      return;
    }
    if (isLogin && bad) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<form id="form-login"><input name="password"></form>');
      return;
    }
    // Anything else: pretend it is a logged-in page.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>ok</html>');
  });
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-evomedis] listening on http://127.0.0.1:${port}`);
});
