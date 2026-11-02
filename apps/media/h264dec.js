'use strict';
/**
 * h264dec.js - an H.264 decoder for node 8 on the car (no decoder an app can use there): h264bsd,
 * compiled to WebAssembly by tinyh264 (./h264.wasm, Apache-2.0, see NOTICE.md). Baseline profile only -
 * what HLS's low variants use (avc1.42...). tinyh264's own glue wants a browser worker; this loads the
 * module directly: its two imports are emscripten's heap growth and memcpy.
 *
 *   const dec = H264Decoder.load();                // sync: the wasm is ~120 kB
 *   const pic = dec.decode(nal);                   // one NAL unit (with or without start code)
 *   if (pic) pic.w, pic.h, pic.i420                // a view into the decoder's memory: copy it to keep it
 */
const fs = require('fs');
const path = require('path');

const PIC_RDY = 1, HDRS_RDY = 2, ERROR = 3, PARAM_SET_ERROR = 4, MEMALLOC_ERROR = 5;
// the wasm's minified exports (tinyh264 0.0.7's glue: Module["asm"]["d"] = ___wasm_call_ctors ...)
const X = { ctors: 'd', init: 'e', malloc: 'f', free: 'g', decode: 'h', shutdown: 'i', alloc: 'j', release: 'k' };
const IN_MAX = 1024 * 1024;

class H264Decoder {
    constructor(instance) {
        const e = instance.exports;
        this.e = e;
        this.mem = e.c;
        e[X.ctors]();
        this.pStorage = e[X.alloc]();
        this.pW = e[X.malloc](4); this.pH = e[X.malloc](4); this.pPic = e[X.malloc](4);
        this.pIn = e[X.malloc](IN_MAX);
        e[X.init](this.pStorage, 0);
        this.errors = 0;
    }

    static load(file) {
        const bytes = fs.readFileSync(file || path.join(__dirname, 'h264.wasm'));
        const ref = { mem: null };              // (the imports run once the instance exists)
        const heap = () => new Uint8Array(ref.mem.buffer);
        const imports = { a: {
            // emscripten_resize_heap(requested): grow the memory, true when it now holds that many bytes
            a: (req) => {
                req >>>= 0;
                const have = ref.mem.buffer.byteLength;
                if (req <= have) return 1;
                try { ref.mem.grow(Math.ceil((req - have) / 65536)); return 1; } catch (e) { return 0; }
            },
            // emscripten_memcpy_big(dest, src, n)
            b: (dest, src, n) => { heap().copyWithin(dest, src, src + n); return dest; },
        } };
        const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
        ref.mem = inst.exports.c;
        return new H264Decoder(inst);
    }

    /** one NAL unit -> { w, h, i420 } when it finished a picture, else null */
    decode(nal) {
        if (!nal.length || nal.length > IN_MAX) return null;
        new Uint8Array(this.mem.buffer).set(nal, this.pIn);
        const r = this.e[X.decode](this.pStorage, this.pIn, nal.length, this.pPic, this.pW, this.pH);
        // (SPS / PPS answer an error code even when taken: pictures follow - not counted)
        if (r === ERROR || r === PARAM_SET_ERROR || r === MEMALLOC_ERROR) { if ((nal[0] & 31) !== 7 && (nal[0] & 31) !== 8) this.errors++; return null; }
        if (r !== PIC_RDY) return null;
        const v = new DataView(this.mem.buffer);
        const w = v.getInt32(this.pW, true), h = v.getInt32(this.pH, true), p = v.getUint32(this.pPic, true);
        return { w, h, i420: new Uint8Array(this.mem.buffer, p, w * h * 3 / 2) };
    }

    release() {
        if (!this.pStorage) return;
        this.e[X.shutdown](this.pStorage); this.e[X.release](this.pStorage);
        [this.pW, this.pH, this.pPic, this.pIn].forEach((p) => this.e[X.free](p));
        this.pStorage = 0;
    }
}
H264Decoder.HDRS_RDY = HDRS_RDY;

/**
 * I420 (Y, then U, then V planes) -> cluster-render's 4:2:0 atlas: Y, then each chroma row as U and V
 * side by side (w/2 each). out: a Buffer of w * h * 3/2.
 */
function i420ToAtlas(i420, w, h, out) {
    const ySize = w * h, cw = w >> 1, ch = h >> 1, cSize = cw * ch;
    out.set(i420.subarray(0, ySize), 0);
    for (let y = 0; y < ch; y++) {
        const o = ySize + y * w;
        out.set(i420.subarray(ySize + y * cw, ySize + (y + 1) * cw), o);
        out.set(i420.subarray(ySize + cSize + y * cw, ySize + cSize + (y + 1) * cw), o + cw);
    }
    return out;
}

module.exports = { H264Decoder, i420ToAtlas };
