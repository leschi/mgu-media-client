'use strict';
/**
 * id3.js - an ID3v2.3 tag: title, artist, album and cover in front of a sound file, where BMW's media player
 * reads what it shows (currentItemMetadata: TITLE, ARTIST, ALBUM, COVER_FILE).
 *
 *   id3({ title, artist, album, jpeg }) -> Buffer
 */
function frame(id, body) {
    const h = Buffer.alloc(10);
    h.write(id, 0, 4, 'latin1');
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
}

/** UTF-16 with its byte order mark (v2.3's only Unicode) */
const text = (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(String(s), 'utf16le')]);

function id3(o) {
    const f = [];
    if (o.title) f.push(frame('TIT2', text(o.title)));
    if (o.artist) f.push(frame('TPE1', text(o.artist)));
    if (o.album) f.push(frame('TALB', text(o.album)));
    // latin1 mime, 3: the front cover, an empty description
    if (o.jpeg && o.jpeg[0] === 0xff && o.jpeg[1] === 0xd8) f.push(frame('APIC', Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0', 'latin1'), o.jpeg])));
    if (!f.length) return Buffer.alloc(0);
    const body = Buffer.concat(f), n = body.length;
    return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]), body]);
}

module.exports = { id3 };
