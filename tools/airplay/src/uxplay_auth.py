#!/usr/bin/env python3
"""uxplay_auth.py LIBDIR - changes UxPlay's password check (GPL-3.0, lib/raop_handlers.h, lib/pairing.c), Media Client 2026-11:
 - the nonce stays the same while the receiver runs. UxPlay frees it after a sign-in; a phone that comes back with that
   sign-in on another connection then ended the receiver (strcmp with NULL), and a second connection's 401 made the
   first one's sign-in wrong,
 - a phone (its address) that signed in once is not asked again while the receiver runs,
 - the parts of the Authorization line are found in any order, a missing one is a wrong sign-in (it was a crash)."""
import sys
d = sys.argv[1]


def sub(f, pairs):
    s = open(d + '/' + f).read()
    for a, b in pairs:
        if s.count(a) != 1:
            sys.exit('uxplay_auth: %s has changed: %r' % (f, a[:60]))
        s = s.replace(a, b)
    open(d + '/' + f, 'w').write(s)


sub('raop_handlers.h', [
    ("static void\nraop_handler_setup(raop_conn_t *conn,", """/* the phones that signed in (addresses), the latest ones */
static unsigned char mgu_known[16][16];
static int mgu_known_len[16], mgu_known_n;
static bool mgu_is_known(raop_conn_t *conn) {
    for (int i = 0; i < 16; i++)
        if (mgu_known_len[i] && mgu_known_len[i] == conn->remotelen && !memcmp(mgu_known[i], conn->remote, conn->remotelen)) return true;
    return false;
}
static void mgu_remember(raop_conn_t *conn) {
    if (conn->remotelen <= 0 || conn->remotelen > 16 || mgu_is_known(conn)) return;
    memcpy(mgu_known[mgu_known_n], conn->remote, conn->remotelen);
    mgu_known_len[mgu_known_n] = conn->remotelen;
    mgu_known_n = (mgu_known_n + 1) % 16;
}

static void
raop_handler_setup(raop_conn_t *conn,"""),
    ("        if (!conn->authenticated && raop->callbacks.passwd) {\n", """        if (!conn->authenticated && mgu_is_known(conn)) {
            conn->authenticated = true;
            logger_log(raop->logger, LOGGER_INFO, "sign-in: this phone signed in before");
        }
        if (!conn->authenticated && raop->callbacks.passwd) {
"""),
    ("""                    const char *ptr = strstr(authorization, "nonce=\\"") +  strlen("nonce=\\"");
                    strncpy(nonce_string, ptr, 32);
""", """                    const char *ptr = strstr(authorization, "nonce=\\"");
                    if (ptr) strncpy(nonce_string, ptr + strlen("nonce=\\""), 32);
"""),
    ("conn->authenticated && !strcmp(nonce_string, raop->nonce);", "conn->authenticated && raop->nonce && !strcmp(nonce_string, raop->nonce);"),
    ("nonce_string, raop->nonce);\n                        }", "nonce_string, raop->nonce ? raop->nonce : \"-\");\n                        }"),
    ("""                    if (raop->nonce) {
                        free(raop->nonce);
                        raop->nonce = NULL;
                    }
                    logger_log(raop->logger, LOGGER_INFO, "Client authentication""", """                    if (conn->authenticated) mgu_remember(conn);
                    logger_log(raop->logger, LOGGER_INFO, "Client authentication"""),
    ("""                    assert (!pairing_session_make_nonce(conn->session, &now, url, nonce, len));
                    if (raop->nonce) {
                        free(raop->nonce);
                    }
                    raop->nonce = utils_hex_to_string(nonce, len);
""", """                    if (!raop->nonce) {
                        int rc = pairing_session_make_nonce(conn->session, &now, url, nonce, len);
                        assert (!rc);
                        raop->nonce = utils_hex_to_string(nonce, len);
                    }
                    logger_log(raop->logger, LOGGER_INFO, "sign-in: the phone is asked for the code");
"""),
])
s = open(d + '/pairing.c').read()
for t in ['username', 'realm', 'nonce', 'uri', 'response']:
    a = [l for l in s.split('\n') if l.strip().startswith(t + ' = get_token(&cursor,')]
    if len(a) != 1:
        sys.exit('uxplay_auth: pairing.c has changed: ' + t)
    s = s.replace(a[0], "    cursor = strdup(authorization);\n    " + t + " = get_token(&cursor, \"" + t + "=\", '\\\"', '\\\"');")
a = "    /* H1 = H(username : realm : password ) */\n"
if s.count(a) != 1:
    sys.exit('uxplay_auth: pairing.c has changed')
s = s.replace(a, "    if (!username || !realm || !nonce || !uri || !response || (qop && (!nc || !cnonce))) return false;\n" + a)
open(d + '/pairing.c', 'w').write(s)
