// Classify driver errors internally; never return raw messages, URLs or stacks.
function testDatabaseDiagnostic(error, stage) {
    const stages = new Set(['configuration', 'client setup', 'connection', 'ping', 'topology', 'close']);
    const safeStage = stages.has(stage) ? stage : 'unknown';
    const nodes = [], pending = [error], seen = new Set();
    while (pending.length && nodes.length < 24) {
        const node = pending.shift();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node); nodes.push(node);
        pending.push(node.cause, node.reason, node.error);
        if (node.servers instanceof Map) {
            for (const server of [...node.servers.values()].slice(0, 10)) pending.push(server.error);
        }
    }
    const has = (check) => nodes.some(check);
    const message = (node) => typeof node.message === 'string' ? node.message.slice(0, 4096) : '';
    let code = 'UNKNOWN', guidance = 'Share this diagnostic code and stage, not your password or connection string.';
    if (safeStage === 'configuration' || has((n) => n.name === 'MongoParseError')) {
        code = 'CONFIGURATION'; guidance = 'The test connection format was rejected. Use the local test runner with the real test password, not a placeholder.';
    } else if (has((n) => n.code === 18 || n.codeName === 'AuthenticationFailed' || /authentication failed|bad auth|auth failed/i.test(message(n)))) {
        code = 'AUTHENTICATION'; guidance = 'Check the database username and NEW database-user password in the NaijaGo Testing project. This is not your Atlas website login password.';
    } else if (has((n) => n.code === 13 || n.codeName === 'Unauthorized')) {
        code = 'PERMISSION'; guidance = 'The database user lacks permission for this check. Review access to naijago_integration_tests in the TEST project only.';
    } else if (has((n) => ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN'].includes(n.code) || /querySrv|queryTxt|getaddrinfo/i.test(message(n)))) {
        code = 'DNS'; guidance = 'The cluster name could not be resolved. Check internet/DNS and that the test cluster is available; no password reset is indicated by this error.';
    } else if (has((n) => /CERT|TLS|SSL/.test(String(n.code || '')) || /certificate|TLS handshake|SSL routines/i.test(message(n)))) {
        code = 'TLS'; guidance = 'A secure connection failed. Check the computer clock, Node version and VPN/security software. Do not disable certificate validation.';
    } else if (has((n) => n.code === 'NAIJAGO_TEST_TOPOLOGY')) {
        code = 'TOPOLOGY'; guidance = 'The connected test server did not report the replica-set/session support required by these tests.';
    } else if (has((n) => ['MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError'].includes(n.name) || ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(n.code))) {
        code = 'NETWORK_OR_ACCESS'; guidance = 'The database could not be reached. In the TEST project, check cluster availability and your current IP access; also check VPN/firewall connectivity. This alone does not prove the password is wrong.';
    }
    return { code: `TEST_DATABASE_${code}`, stage: safeStage, guidance };
}
module.exports = { testDatabaseDiagnostic };
