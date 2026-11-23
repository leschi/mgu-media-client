/* SPDX-License-Identifier: GPL-3.0-or-later
 * receiver.c - Media Client's AirPlay receiver (a process of its own, run by apps/media/backend.js).
 *
 * The AirPlay protocol is UxPlay's library (https://github.com/FDH2/UxPlay, lib/; see build.sh). Around it:
 *   - mirroring: H.264 -> I420 frames in a /dev/shm file (MGVF, what the MGU's GPU renderer reads),
 *   - sound (AAC-ELD, AAC, ALAC) -> BMW's SmartX ALSA sink, 8 channels,
 *   - video by URL (YouTube's AirPlay button): HLS / MP4 fetched here,
 * decoded with FFmpeg, no GStreamer. Its own name lookup: the uplink's name servers (-l), not /etc/resolv.conf.
 *
 *   mgu-airplay -n NAME -m aa:bb:.. -w PASSWORD -f /dev/shm/mgu-video-.. -p 7110 [-u] [-l LEASE] [-t DIR] [-k KEYFILE]
 *
 * stdout, a line each: connected 0|1, mode none|mirror|video|audio, loading, playing, error TEXT.
 * stdin: size W H (a URL video's largest size), end (end the URL video); its end: quit.
 *
 *   mgu-airplay sound     plays a film's sound (see sound_main)
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <netdb.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#include "dnssd.h"
#include "raop.h"
#include "logger.h"

#define MS 1000000LL
#define DELAY_NS (200 * MS)        /* picture and sound of a mirrored screen: this long after they came */
#define RATE 48000
#define CH 8

/* ---------------- small things ---------------- */
static pthread_mutex_t say_mx = PTHREAD_MUTEX_INITIALIZER;
static void say(const char *fmt, ...)
{
    va_list ap;
    pthread_mutex_lock(&say_mx);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
    pthread_mutex_unlock(&say_mx);
}
static int64_t now_ns(void)
{
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);      /* (the library's clock) */
    return t.tv_sec * 1000000000LL + t.tv_nsec;
}
static void nap(int64_t ns)
{
    if (ns <= 0) return;
    struct timespec t = { ns / 1000000000LL, ns % 1000000000LL };
    nanosleep(&t, NULL);
}

static atomic_int mode;                     /* 0 none, 1 mirror, 2 video (URL), 3 audio */
static void set_mode(int m)
{
    static const char *const name[] = { "none", "mirror", "video", "audio" };
    if (atomic_exchange(&mode, m) != m) say("mode %s", name[m]);
}

/* ---------------- frames: the MGVF file ---------------- */
#define SLOTS 3
static char frame_path[128];
static struct { int fd; uint8_t *map; size_t size; int w, h, full; uint32_t seq, slot; } mg = { .fd = -1 };
static pthread_mutex_t mg_mx = PTHREAD_MUTEX_INITIALIZER;

static void mg_close(void)
{
    pthread_mutex_lock(&mg_mx);
    if (mg.fd >= 0) {
        munmap(mg.map, mg.size);
        close(mg.fd);
        unlink(frame_path);
        mg.fd = -1;
        mg.w = mg.h = 0;
    }
    pthread_mutex_unlock(&mg_mx);
}

static struct SwsContext *sws;              /* (one thread writes frames at a time: mg_mx) */
/* the frame into the next slot, at dw x dh (0: its own size) */
static void mg_put(const AVFrame *f, int dw, int dh)
{
    pthread_mutex_lock(&mg_mx);
    if (!dw || !dh) { dw = f->width & ~1; dh = f->height & ~1; }
    if (dw < 16 || dh < 16 || dw > 2048 || dh > 2048) goto out;
    if (mg.fd >= 0 && (mg.w != dw || mg.h != dh)) {
        munmap(mg.map, mg.size);
        close(mg.fd);
        unlink(frame_path);
        mg.fd = -1;
    }
    const size_t fsize = (size_t)dw * dh * 3 / 2;
    if (mg.fd < 0) {
        mg.size = 64 + SLOTS * fsize;
        mg.fd = open(frame_path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (mg.fd < 0) goto out;
        if (ftruncate(mg.fd, mg.size) || (mg.map = mmap(NULL, mg.size, PROT_READ | PROT_WRITE, MAP_SHARED, mg.fd, 0)) == MAP_FAILED) {
            close(mg.fd);
            unlink(frame_path);
            mg.fd = -1;
            goto out;
        }
        mg.w = dw; mg.h = dh; mg.seq = 0; mg.slot = 0;
    }
    const uint32_t next = (mg.slot + 1) % SLOTS;
    uint8_t *d[4] = { mg.map + 64 + next * fsize, 0, 0, 0 };
    int ls[4] = { dw, dw / 2, dw / 2, 0 };
    d[1] = d[0] + (size_t)dw * dh;
    d[2] = d[1] + (size_t)dw * dh / 4;
    if ((f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P) && f->width >= dw && f->width < dw + 2 && f->height >= dh && f->height < dh + 2) {
        av_image_copy_plane(d[0], ls[0], f->data[0], f->linesize[0], dw, dh);
        av_image_copy_plane(d[1], ls[1], f->data[1], f->linesize[1], dw / 2, dh / 2);
        av_image_copy_plane(d[2], ls[2], f->data[2], f->linesize[2], dw / 2, dh / 2);
    } else {
        sws = sws_getCachedContext(sws, f->width, f->height, f->format, dw, dh, AV_PIX_FMT_YUV420P, SWS_FAST_BILINEAR, NULL, NULL, NULL);
        if (!sws) goto out;
        sws_scale(sws, (const uint8_t *const *)f->data, f->linesize, 0, f->height, d, ls);
    }
    uint32_t *h = (uint32_t *)mg.map;
    h[0] = 0x4656474d; h[1] = 1; h[2] = dw; h[3] = dh; h[6] = SLOTS;
    h[7] = f->colorspace == AVCOL_SPC_SMPTE170M || f->colorspace == AVCOL_SPC_BT470BG ? 0 : 1;
    h[8] = f->color_range == AVCOL_RANGE_JPEG || f->format == AV_PIX_FMT_YUVJ420P;
    __atomic_store_n(&h[5], next, __ATOMIC_RELEASE);
    mg.slot = next;
    __atomic_store_n(&h[4], ++mg.seq, __ATOMIC_RELEASE);
out:
    pthread_mutex_unlock(&mg_mx);
}

/* ---------------- packets between threads ---------------- */
typedef struct pkt { struct pkt *next; AVPacket *av; uint8_t *data; int len; int64_t pts; int ct; } pkt_t;
typedef struct { pthread_mutex_t mx; pthread_cond_t cv; pkt_t *head, **tail; int n; size_t bytes; bool eof, stop; } queue_t;
static void q_init(queue_t *q)
{
    memset(q, 0, sizeof *q);
    pthread_mutex_init(&q->mx, NULL);
    pthread_cond_init(&q->cv, NULL);
    q->tail = &q->head;
}
static void p_free(pkt_t *p) { if (p) { av_packet_free(&p->av); free(p->data); free(p); } }
static void q_flush(queue_t *q)
{
    pthread_mutex_lock(&q->mx);
    while (q->head) { pkt_t *p = q->head; q->head = p->next; p_free(p); }
    q->tail = &q->head;
    q->n = 0; q->bytes = 0; q->eof = false;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mx);
}
static void q_push(queue_t *q, pkt_t *p, int len)
{
    p->next = NULL;
    p->len = len;
    pthread_mutex_lock(&q->mx);
    *q->tail = p;
    q->tail = &p->next;
    q->n++; q->bytes += len;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mx);
}
/* the next packet; NULL: none within ms, stopped, or (with *end) the end */
static pkt_t *q_pop(queue_t *q, int ms, bool *end)
{
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    t.tv_nsec += (long)(ms % 1000) * 1000000;
    t.tv_sec += ms / 1000 + t.tv_nsec / 1000000000;
    t.tv_nsec %= 1000000000;
    pkt_t *p = NULL;
    pthread_mutex_lock(&q->mx);
    while (!q->head && !q->stop && !q->eof)
        if (pthread_cond_timedwait(&q->cv, &q->mx, &t)) break;
    if (q->head && !q->stop) {
        p = q->head;
        if (!(q->head = p->next)) q->tail = &q->head;
        q->n--; q->bytes -= p->len;
        pthread_cond_broadcast(&q->cv);
    }
    if (end) *end = !p && q->eof;
    pthread_mutex_unlock(&q->mx);
    return p;
}
static void q_set(queue_t *q, bool stop, bool eof)
{
    pthread_mutex_lock(&q->mx);
    q->stop = stop; q->eof = eof;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mx);
}

/* ---------------- the sink (ALSA, the unit's own library: its SmartX plugin belongs to it) ---------------- */
static struct {
    void *lib, *pcm;
    int (*open)(void **, const char *, int, int);
    int (*params)(void *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(void *, const void *, unsigned long);
    int (*recover)(void *, int, int);
    int (*delay)(void *, long *);
    int (*drop)(void *);
    int (*prepare)(void *);
    int (*close)(void *);
    int64_t retry;
    FILE *file;                             /* (tests: MGU_AIRPLAY_PCM, stereo S16, as fast as real time) */
    int64_t file_end;
} snd;
static pthread_mutex_t snd_mx = PTHREAD_MUTEX_INITIALIZER;
static _Atomic float gain = 1.0f;

static bool snd_up(void)
{
    if (snd.pcm || snd.file) return true;
    const char *f = getenv("MGU_AIRPLAY_PCM");
    if (f) { snd.file = fopen(f, "wb"); snd.file_end = now_ns(); return snd.file != NULL; }
    if (now_ns() < snd.retry) return false;
    snd.retry = now_ns() + 2000 * MS;
    if (!snd.lib) {
        if (!(snd.lib = dlopen("libasound.so.2", RTLD_NOW | RTLD_GLOBAL))) { say("error no sound: %s", dlerror()); return false; }
        snd.open = dlsym(snd.lib, "snd_pcm_open");
        snd.params = dlsym(snd.lib, "snd_pcm_set_params");
        snd.writei = dlsym(snd.lib, "snd_pcm_writei");
        snd.recover = dlsym(snd.lib, "snd_pcm_recover");
        snd.delay = dlsym(snd.lib, "snd_pcm_delay");
        snd.drop = dlsym(snd.lib, "snd_pcm_drop");
        snd.prepare = dlsym(snd.lib, "snd_pcm_prepare");
        snd.close = dlsym(snd.lib, "snd_pcm_close");
    }
    if (!snd.open || !snd.params || !snd.writei || !snd.recover || !snd.delay || !snd.drop || !snd.prepare || !snd.close) return false;
    const char *dev = getenv("MGU_AIRPLAY_ALSA");
    if (!dev) dev = "smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL";
    int e = snd.open(&snd.pcm, dev, 0 /* playback */, 0);
    if (e < 0) { snd.pcm = NULL; say("error no sound: the sink does not open (%d)", e); return false; }
    if ((e = snd.params(snd.pcm, 2 /* S16_LE */, 3 /* interleaved */, CH, RATE, 0, 160000)) < 0) {
        snd.close(snd.pcm);
        snd.pcm = NULL;
        say("error no sound: the sink takes no 8 x 48 kHz (%d)", e);
        return false;
    }
    return true;
}
static void snd_down(void)
{
    pthread_mutex_lock(&snd_mx);
    if (snd.pcm) { snd.drop(snd.pcm); snd.close(snd.pcm); snd.pcm = NULL; }
    if (snd.file) { fclose(snd.file); snd.file = NULL; }
    pthread_mutex_unlock(&snd_mx);
}
static void snd_flush(void)
{
    pthread_mutex_lock(&snd_mx);
    if (snd.pcm) { snd.drop(snd.pcm); snd.prepare(snd.pcm); }
    snd.file_end = now_ns();
    pthread_mutex_unlock(&snd_mx);
}
/* how long what is in the sink still plays */
static int64_t snd_delay(void)
{
    int64_t d = 0;
    pthread_mutex_lock(&snd_mx);
    if (snd.file) { d = snd.file_end - now_ns(); if (d < 0) d = 0; }
    else if (snd.pcm) { long n = 0; if (snd.delay(snd.pcm, &n) == 0 && n > 0) d = (int64_t)n * 1000000000LL / RATE; }
    pthread_mutex_unlock(&snd_mx);
    return d;
}
/* stereo S16 at 48 kHz (NULL: silence) on every pair of the sink; blocks while it is full */
static bool snd_write(const int16_t *s, int n)
{
    static int16_t out[1024 * CH];
    pthread_mutex_lock(&snd_mx);
    if (!snd_up()) { pthread_mutex_unlock(&snd_mx); return false; }
    const float g = atomic_load(&gain);
    while (n > 0) {
        const int k = n > 1024 ? 1024 : n;
        for (int i = 0; i < k; i++) {
            const int16_t l = s ? (int16_t)(s[2 * i] * g) : 0, r = s ? (int16_t)(s[2 * i + 1] * g) : 0;
            for (int c = 0; c < CH; c += 2) { out[i * CH + c] = l; out[i * CH + c + 1] = r; }
        }
        if (snd.file) {
            for (int i = 0; i < k; i++) fwrite(out + i * CH, 4, 1, snd.file);
            if (snd.file_end < now_ns()) snd.file_end = now_ns();
            snd.file_end += (int64_t)k * 1000000000LL / RATE;
            const int64_t ahead = snd.file_end - now_ns() - 160 * MS;
            if (ahead > 0) { pthread_mutex_unlock(&snd_mx); nap(ahead); pthread_mutex_lock(&snd_mx); if (!snd.file) break; }
        } else {
            const int16_t *p = out;
            int left = k, tries = 0;
            while (left > 0) {
                void *pcm = snd.pcm;
                pthread_mutex_unlock(&snd_mx);
                const long w = snd.writei(pcm, p, left);
                pthread_mutex_lock(&snd_mx);
                if (snd.pcm != pcm) { pthread_mutex_unlock(&snd_mx); return false; }
                if (w >= 0) { p += w * CH; left -= w; continue; }
                if (++tries > 3 || snd.recover(snd.pcm, (int)w, 1) < 0) {
                    snd.close(snd.pcm);
                    snd.pcm = NULL;
                    pthread_mutex_unlock(&snd_mx);
                    return false;
                }
            }
        }
        if (s) s += 2 * k;
        n -= k;
    }
    pthread_mutex_unlock(&snd_mx);
    return true;
}

/* any decoded sound -> stereo S16 at 48 kHz; the count, *buf grown as needed */
static int to_s16(SwrContext **swr, const AVFrame *f, int16_t **buf, int *cap)
{
    if (!*swr) {
        AVChannelLayout st = AV_CHANNEL_LAYOUT_STEREO;
        if (swr_alloc_set_opts2(swr, &st, AV_SAMPLE_FMT_S16, RATE, &f->ch_layout, f->format, f->sample_rate, 0, NULL) < 0 || swr_init(*swr) < 0) { swr_free(swr); return 0; }
    }
    const int want = (int)av_rescale_rnd(swr_get_delay(*swr, f->sample_rate) + f->nb_samples, RATE, f->sample_rate, AV_ROUND_UP) + 32;
    if (want > *cap) {
        int16_t *b = realloc(*buf, (size_t)want * 4);
        if (!b) return 0;
        *buf = b; *cap = want;
    }
    uint8_t *o = (uint8_t *)*buf;
    const int n = swr_convert(*swr, &o, want, (const uint8_t **)f->extended_data, f->nb_samples);
    return n > 0 ? n : 0;
}

/* ---------------- mirroring: picture ---------------- */
static queue_t vq, aq;                      /* from the phone's streams */
static atomic_bool want_key, vreset, areset;
static _Atomic int64_t offset;              /* the phone's clock -> ours (0: not known) */
static atomic_int aformat;                  /* compression type of the sound: 2 ALAC, 4 AAC-LC, 8 AAC-ELD */

static AVCodecContext *h264(int threads, bool low)
{
    const AVCodec *c = avcodec_find_decoder(AV_CODEC_ID_H264);
    AVCodecContext *x = avcodec_alloc_context3(c);
    if (!x) return NULL;
    x->thread_count = threads;
    x->thread_type = low ? FF_THREAD_SLICE : FF_THREAD_FRAME | FF_THREAD_SLICE;
    if (low) x->flags |= AV_CODEC_FLAG_LOW_DELAY;
    if (avcodec_open2(x, c, NULL) < 0) avcodec_free_context(&x);
    return x;
}
static void *mirror_video(void *arg)
{
    AVCodecContext *x = NULL;
    AVFrame *f = av_frame_alloc();
    AVPacket *a = av_packet_alloc();
    (void)arg;
    for (;;) {
        pkt_t *p = q_pop(&vq, 500, NULL);
        if (atomic_exchange(&vreset, false) && x) avcodec_free_context(&x);
        if (!p) continue;
        if (!x) x = h264(2, true);
        if (x && atomic_load(&mode) != 2) {
            a->data = p->data; a->size = p->len; a->pts = p->pts;
            if (avcodec_send_packet(x, a) >= 0)
                while (avcodec_receive_frame(x, f) >= 0) {
                    const int64_t at = f->pts + DELAY_NS - now_ns();
                    if (at > 0 && at < 2 * DELAY_NS) nap(at);
                    if (atomic_load(&mode) == 1) mg_put(f, 0, 0);
                }
        }
        p_free(p);
    }
    return NULL;
}

/* ---------------- mirroring and music: sound ---------------- */
static const uint8_t cookie_alac[36] = { 0, 0, 0, 0x24, 'a', 'l', 'a', 'c', 0, 0, 0, 0, 0, 0, 1, 0x60, 0, 0x10, 0x28, 0x0a, 0x0e, 2, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xac, 0x44 };
static const uint8_t cookie_lc[2] = { 0x12, 0x10 }, cookie_eld[4] = { 0xf8, 0xe8, 0x50, 0x00 };
static AVCodecContext *sound(int ct)
{
    const uint8_t *e = ct == 2 ? cookie_alac : ct == 4 ? cookie_lc : cookie_eld;
    const int n = ct == 2 ? 36 : ct == 4 ? 2 : 4;
    const AVCodec *c = avcodec_find_decoder(ct == 2 ? AV_CODEC_ID_ALAC : AV_CODEC_ID_AAC);
    AVCodecContext *x = avcodec_alloc_context3(c);
    if (!x) return NULL;
    x->extradata = av_mallocz(n + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(x->extradata, e, n);
    x->extradata_size = n;
    x->sample_rate = 44100;
    av_channel_layout_default(&x->ch_layout, 2);
    if (avcodec_open2(x, c, NULL) < 0) avcodec_free_context(&x);
    return x;
}
static void *mirror_audio(void *arg)
{
    AVCodecContext *x = NULL;
    SwrContext *swr = NULL;
    AVFrame *f = av_frame_alloc();
    AVPacket *a = av_packet_alloc();
    int16_t *buf = NULL;
    int cap = 0, ct = 0;
    int64_t idle = 0;
    (void)arg;
    for (;;) {
        pkt_t *p = q_pop(&aq, 500, NULL);
        const int m = atomic_load(&mode);
        if (atomic_exchange(&areset, false)) { avcodec_free_context(&x); swr_free(&swr); if (m != 2) snd_flush(); }
        if (!p) {
            /* nothing for a while: the sink is BMW's again */
            if (!idle) idle = now_ns();
            else if (m != 2 && now_ns() - idle > 5000 * MS) { snd_down(); idle = now_ns(); }
            continue;
        }
        idle = 0;
        if (m == 2) { p_free(p); continue; }            /* (the URL video has the sink) */
        if (!x || p->ct != ct) { avcodec_free_context(&x); swr_free(&swr); ct = p->ct; x = sound(ct); }
        if (x) {
            a->data = p->data; a->size = p->len;
            if (avcodec_send_packet(x, a) >= 0)
                while (avcodec_receive_frame(x, f) >= 0) {
                    const int n = to_s16(&swr, f, &buf, &cap);
                    if (n <= 0) continue;
                    /* due at pts + the delay; what is in the sink plays first */
                    const int64_t late = now_ns() + snd_delay() - (p->pts + DELAY_NS);
                    if (late > 120 * MS && ct == 8) continue;                           /* behind the picture: left out */
                    if (late < -60 * MS && late > -3000 * MS) snd_write(NULL, (int)(-late * RATE / 1000000000LL));
                    snd_write(buf, n);
                }
        }
        p_free(p);
    }
    return NULL;
}

/* ---------------- a video by URL ---------------- */
static struct {
    pthread_mutex_t mx;
    char *url;                              /* to be played next */
    double start, seek;                     /* seek: < 0 none */
    bool paused, on;
    atomic_bool stop, finished;
    double pos, dur;
} pl = { .mx = PTHREAD_MUTEX_INITIALIZER, .seek = -1 };
static atomic_int view_w = 1280, view_h = 720;
static char tmp_dir[128] = "/tmp";
static pthread_cond_t pl_cv = PTHREAD_COND_INITIALIZER;

static int cut(void *o) { (void)o; return atomic_load(&pl.stop); }

typedef struct {
    AVFormatContext *fmt;
    AVCodecContext *vx, *ax;
    AVStream *vs, *as;
    queue_t vq, aq;
    pthread_mutex_t mx;
    int64_t clock0, frozen;                 /* our time at media time 0 (ns); frozen: media time while paused, -1 running */
    atomic_int serial;
    atomic_bool vend, aend, started;
} play_t;

static int64_t media_now(play_t *p)
{
    pthread_mutex_lock(&p->mx);
    const int64_t t = p->frozen >= 0 ? p->frozen : p->clock0 ? now_ns() - p->clock0 : -1;
    pthread_mutex_unlock(&p->mx);
    return t;
}
static void set_clock(play_t *p, int64_t media)
{
    pthread_mutex_lock(&p->mx);
    if (p->frozen < 0) p->clock0 = now_ns() - media;
    pthread_mutex_unlock(&p->mx);
}
static bool held(play_t *p) { pthread_mutex_lock(&p->mx); const bool h = p->frozen >= 0; pthread_mutex_unlock(&p->mx); return h; }

static void *url_audio(void *arg)
{
    play_t *p = arg;
    AVFrame *f = av_frame_alloc();
    SwrContext *swr = NULL;
    int16_t *buf = NULL;
    int cap = 0, serial = atomic_load(&p->serial);
    bool end = false;
    while (!atomic_load(&pl.stop)) {
        if (held(p)) { nap(20 * MS); continue; }
        pkt_t *k = q_pop(&p->aq, 100, &end);
        if (!k) { if (end) { atomic_store(&p->aend, true); nap(20 * MS); } continue; }
        if (serial != atomic_load(&p->serial)) { serial = atomic_load(&p->serial); avcodec_flush_buffers(p->ax); swr_free(&swr); }
        atomic_store(&p->aend, false);
        if (k->ct == serial && avcodec_send_packet(p->ax, k->av) >= 0)
            while (!atomic_load(&pl.stop) && avcodec_receive_frame(p->ax, f) >= 0) {
                const int n = to_s16(&swr, f, &buf, &cap);
                if (n <= 0) continue;
                while (held(p) && !atomic_load(&pl.stop)) nap(20 * MS);
                if (k->ct != atomic_load(&p->serial)) break;
                if (!snd_write(buf, n)) nap((int64_t)n * 1000000000LL / RATE);           /* no sink: in time all the same */
                const int64_t pts = f->best_effort_timestamp;
                if (pts != AV_NOPTS_VALUE) set_clock(p, av_rescale_q(pts, p->as->time_base, (AVRational){ 1, 1000000000 }) + (int64_t)f->nb_samples * 1000000000LL / f->sample_rate - snd_delay());
            }
        p_free(k);
    }
    av_frame_free(&f);
    swr_free(&swr);
    free(buf);
    return NULL;
}
static void *url_video(void *arg)
{
    play_t *p = arg;
    AVFrame *f = av_frame_alloc();
    int serial = atomic_load(&p->serial);
    bool end = false;
    while (!atomic_load(&pl.stop)) {
        pkt_t *k = q_pop(&p->vq, 100, &end);
        if (!k && !end) continue;
        if (serial != atomic_load(&p->serial)) { serial = atomic_load(&p->serial); avcodec_flush_buffers(p->vx); atomic_store(&p->vend, false); }
        if (k && k->ct != serial) { p_free(k); continue; }
        if (!k && atomic_load(&p->vend)) { nap(20 * MS); continue; }
        const int e = avcodec_send_packet(p->vx, k ? k->av : NULL);
        while ((e >= 0 || !k) && !atomic_load(&pl.stop)) {
            const int r = avcodec_receive_frame(p->vx, f);
            if (r < 0) { if (r == AVERROR_EOF) atomic_store(&p->vend, true); break; }
            const int64_t pts = f->best_effort_timestamp == AV_NOPTS_VALUE ? 0 : av_rescale_q(f->best_effort_timestamp, p->vs->time_base, (AVRational){ 1, 1000000000 });
            if (!p->as && media_now(p) < 0) set_clock(p, pts);                          /* no sound: our own clock */
            for (;;) {
                if (atomic_load(&pl.stop) || serial != atomic_load(&p->serial)) break;
                const int64_t t = media_now(p), d = t < 0 ? 50 * MS : pts - t;
                if (held(p)) { nap(20 * MS); if (!atomic_load(&p->started)) break; continue; }
                if (t >= 0 && d <= 5 * MS) break;
                nap(d > 50 * MS ? 50 * MS : d);
            }
            if (atomic_load(&pl.stop) || serial != atomic_load(&p->serial)) break;
            if (media_now(p) - pts > 150 * MS) continue;                                /* late: not shown */
            double s = fmin(1.0, fmin((double)atomic_load(&view_w) / f->width, (double)atomic_load(&view_h) / f->height));
            mg_put(f, (int)(f->width * s + 0.5) & ~1, (int)(f->height * s + 0.5) & ~1);
            if (!atomic_exchange(&p->started, true)) say("playing");
        }
        p_free(k);
    }
    av_frame_free(&f);
    return NULL;
}

/* an HLS master with one variant: H.264 up to 720 lines (what the decoder keeps up with) and its sound */
static char *line_attr(const char *line, const char *key, char *out, size_t n)
{
    char k[40];
    snprintf(k, sizeof k, "%s=", key);
    for (const char *s = strstr(line, k); s; s = strstr(s + 1, k)) {
        if (s != line && s[-1] != ',' && s[-1] != ':') continue;
        s += strlen(k);
        const char q = *s == '"' ? *s++ : 0;
        size_t i = 0;
        while (*s && i + 1 < n && (q ? *s != '"' : *s != ',')) out[i++] = *s++;
        out[i] = 0;
        return out;
    }
    out[0] = 0;
    return NULL;
}
static void absolute(const char *base, const char *u, char *out, size_t n)
{
    if (strstr(u, "://")) { snprintf(out, n, "%s", u); return; }
    const char *host = strstr(base, "://");
    const char *path = host ? strchr(host + 3, '/') : NULL;
    if (u[0] == '/' && path) { snprintf(out, n, "%.*s%s", (int)(path - base), base, u); return; }
    const char *q = strchr(base, '?');
    size_t l = q ? (size_t)(q - base) : strlen(base);
    while (l && base[l - 1] != '/') l--;
    snprintf(out, n, "%.*s%s", (int)l, base, u);
}
static char *reduce_master(const char *url, char *text)
{
    static char file[256];
    char *lines[4096];
    int n = 0, best = -1, best_h = 0;
    for (char *s = strtok(text, "\r\n"); s && n < 4096; s = strtok(NULL, "\r\n")) lines[n++] = s;
    char a[256], b[256], u[8192];
    for (int i = 0; i + 1 < n; i++) {
        if (strncmp(lines[i], "#EXT-X-STREAM-INF:", 18)) continue;
        if (line_attr(lines[i], "CODECS", a, sizeof a) && !strstr(a, "avc1")) continue;
        int h = 1;
        if (line_attr(lines[i], "RESOLUTION", a, sizeof a) && strchr(a, 'x')) h = atoi(strchr(a, 'x') + 1);
        /* the largest up to 720 lines, else the smallest there is */
        if (best < 0 || (h <= 720 ? best_h > 720 || h > best_h : best_h > 720 && h < best_h)) { best = i; best_h = h; }
    }
    if (best < 0 || lines[best + 1][0] == '#') return NULL;
    snprintf(file, sizeof file, "%s/play.m3u8", tmp_dir);
    FILE *f = fopen(file, "w");
    if (!f) return NULL;
    fputs("#EXTM3U\n#EXT-X-VERSION:6\n", f);
    char group[256];
    if (line_attr(lines[best], "AUDIO", group, sizeof group)) {
        int pick = -1;
        for (int i = 0; i < n; i++) {
            if (strncmp(lines[i], "#EXT-X-MEDIA:", 13) || !line_attr(lines[i], "TYPE", a, sizeof a) || strcmp(a, "AUDIO")) continue;
            if (!line_attr(lines[i], "GROUP-ID", a, sizeof a) || strcmp(a, group)) continue;
            if (pick < 0 || (line_attr(lines[i], "DEFAULT", b, sizeof b) && !strcmp(b, "YES"))) pick = i;
        }
        if (pick >= 0 && line_attr(lines[pick], "URI", u, sizeof u)) {
            char v[8192];
            absolute(url, u, v, sizeof v);
            fprintf(f, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"a\",DEFAULT=YES,AUTOSELECT=YES,URI=\"%s\"\n", v);
        }
    }
    absolute(url, lines[best + 1], u, sizeof u);
    fprintf(f, "#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"a\"\n%s\n", u);
    fclose(f);
    return file;
}
static char *fetch(const char *url)
{
    AVIOContext *io = NULL;
    AVIOInterruptCB cb = { cut, NULL };
    if (avio_open2(&io, url, AVIO_FLAG_READ, &cb, NULL) < 0) return NULL;
    const int max = 2 << 20;
    char *b = malloc(max + 1);
    int n = 0, r;
    while (b && n < max && (r = avio_read_partial(io, (uint8_t *)b + n, max - n)) > 0) n += r;
    avio_closep(&io);
    if (b) b[n] = 0;
    return b;
}

static const char *play_open(play_t *p, const char *url)
{
    const char *src = url;
    if (strstr(url, ".m3u8")) {
        char *t = fetch(url);
        if (!t) return "the video's list does not load";
        if (strstr(t, "#EXT-X-STREAM-INF")) { const char *m = reduce_master(url, t); if (m) src = m; }
        free(t);
    }
    p->fmt = avformat_alloc_context();
    p->fmt->interrupt_callback = (AVIOInterruptCB){ cut, NULL };
    p->fmt->probesize = 1 << 20;
    p->fmt->max_analyze_duration = 3000000;
    AVDictionary *o = NULL;
    av_dict_set(&o, "protocol_whitelist", "file,http,https,tcp,tls,crypto,data", 0);
    av_dict_set(&o, "allowed_extensions", "ALL", 0);
    av_dict_set(&o, "extension_picky", "0", 0);
    av_dict_set(&o, "rw_timeout", "15000000", 0);
    av_dict_set(&o, "http_persistent", "0", 0);
    const int e = avformat_open_input(&p->fmt, src, NULL, &o);
    av_dict_free(&o);
    if (e < 0) return "the video does not open";
    if (avformat_find_stream_info(p->fmt, NULL) < 0) return "the video is not readable";
    const AVCodec *vc = NULL, *ac = NULL;
    const int vi = av_find_best_stream(p->fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &vc, 0), ai = av_find_best_stream(p->fmt, AVMEDIA_TYPE_AUDIO, -1, vi, &ac, 0);
    if (vi < 0 && ai < 0) return "no picture or sound this receiver can play";
    for (unsigned i = 0; i < p->fmt->nb_streams; i++) if ((int)i != vi && (int)i != ai) p->fmt->streams[i]->discard = AVDISCARD_ALL;
    if (vi >= 0) {
        p->vs = p->fmt->streams[vi];
        p->vx = avcodec_alloc_context3(vc);
        avcodec_parameters_to_context(p->vx, p->vs->codecpar);
        p->vx->thread_count = 3;
        if (avcodec_open2(p->vx, vc, NULL) < 0) return "the picture does not decode";
    }
    if (ai >= 0) {
        p->as = p->fmt->streams[ai];
        p->ax = avcodec_alloc_context3(ac);
        avcodec_parameters_to_context(p->ax, p->as->codecpar);
        if (avcodec_open2(p->ax, ac, NULL) < 0) { avcodec_free_context(&p->ax); p->as = NULL; }
    }
    return NULL;
}

/* the player thread: one URL after the other */
static void *player(void *arg)
{
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&pl.mx);
        while (!pl.url) pthread_cond_wait(&pl_cv, &pl.mx);
        char *url = pl.url;
        pl.url = NULL;
        const double start = pl.start;
        pl.on = true; pl.pos = start; pl.dur = 0; pl.seek = -1;
        pl.paused = false;
        atomic_store(&pl.stop, false);
        atomic_store(&pl.finished, false);
        pthread_mutex_unlock(&pl.mx);

        play_t p;
        memset(&p, 0, sizeof p);
        p.frozen = -1;
        pthread_mutex_init(&p.mx, NULL);
        q_init(&p.vq);
        q_init(&p.aq);
        set_mode(2);
        say("loading");
        snd_flush();
        const char *why = play_open(&p, url);
        pthread_t vt = 0, at = 0;
        bool ended = false;
        if (!why) {
            const int64_t t0 = p.fmt->start_time == AV_NOPTS_VALUE ? 0 : p.fmt->start_time;
            pthread_mutex_lock(&pl.mx);
            pl.dur = p.fmt->duration > 0 ? p.fmt->duration / 1e6 : 0;
            if (start > 0.5 && pl.seek < 0) pl.seek = start;
            pthread_mutex_unlock(&pl.mx);
            if (p.vs) pthread_create(&vt, NULL, url_video, &p);
            if (p.as) pthread_create(&at, NULL, url_audio, &p);
            AVPacket *k = av_packet_alloc();
            bool eof = false;
            while (!atomic_load(&pl.stop)) {
                pthread_mutex_lock(&pl.mx);
                const double seek = pl.seek;
                const bool paused = pl.paused;
                pl.seek = -1;
                pthread_mutex_unlock(&pl.mx);
                const int64_t m = media_now(&p);
                if (m >= 0) { pthread_mutex_lock(&pl.mx); pl.pos = (m - t0 * 1000) / 1e9; pthread_mutex_unlock(&pl.mx); }
                pthread_mutex_lock(&p.mx);
                if (paused && p.frozen < 0 && p.clock0) { p.frozen = now_ns() - p.clock0; }
                else if (!paused && p.frozen >= 0) { p.clock0 = now_ns() - p.frozen; p.frozen = -1; }
                pthread_mutex_unlock(&p.mx);
                if (seek >= 0) {
                    const int64_t ts = (int64_t)(seek * 1e6) + t0;
                    avformat_seek_file(p.fmt, -1, INT64_MIN, ts, ts, 0);
                    atomic_fetch_add(&p.serial, 1);
                    q_flush(&p.vq);
                    q_flush(&p.aq);
                    snd_flush();
                    atomic_store(&p.vend, false);
                    atomic_store(&p.aend, false);
                    pthread_mutex_lock(&p.mx);
                    if (p.frozen >= 0) p.frozen = ts * 1000; else p.clock0 = 0;
                    pthread_mutex_unlock(&p.mx);
                    eof = false;
                }
                if (eof) {
                    if ((!p.vs || atomic_load(&p.vend)) && (!p.as || atomic_load(&p.aend)) && snd_delay() < 50 * MS) { ended = true; break; }
                    nap(50 * MS);
                    continue;
                }
                if (p.vq.bytes + p.aq.bytes > (12 << 20) || (p.vq.n > 400 && (!p.as || p.aq.n > 400))) { nap(20 * MS); continue; }
                const int r = av_read_frame(p.fmt, k);
                if (r == AVERROR(EAGAIN)) { nap(10 * MS); continue; }
                if (r < 0) {
                    if (atomic_load(&pl.stop)) break;
                    eof = true;
                    q_set(&p.vq, false, true);
                    q_set(&p.aq, false, true);
                    continue;
                }
                queue_t *q = p.vs && k->stream_index == p.vs->index ? &p.vq : p.as && k->stream_index == p.as->index ? &p.aq : NULL;
                if (q) {
                    pkt_t *n = calloc(1, sizeof *n);
                    n->av = av_packet_alloc();
                    av_packet_move_ref(n->av, k);
                    n->ct = atomic_load(&p.serial);
                    q_push(q, n, n->av->size);
                } else av_packet_unref(k);
            }
            av_packet_free(&k);
        } else if (!atomic_load(&pl.stop)) say("error %s", why);
        const bool asked = atomic_exchange(&pl.stop, true);      /* (its threads end) */
        q_set(&p.vq, true, false);
        q_set(&p.aq, true, false);
        if (vt) pthread_join(vt, NULL);
        if (at) pthread_join(at, NULL);
        q_flush(&p.vq);
        q_flush(&p.aq);
        avcodec_free_context(&p.vx);
        avcodec_free_context(&p.ax);
        avformat_close_input(&p.fmt);
        free(url);
        snd_down();
        mg_close();
        pthread_mutex_lock(&pl.mx);
        pl.on = false;
        if (!asked && (ended || why)) atomic_store(&pl.finished, true);
        const bool more = pl.url != NULL;
        pthread_mutex_unlock(&pl.mx);
        if (!more) set_mode(0);
    }
    return NULL;
}
static void url_play(const char *u, double start)
{
    pthread_mutex_lock(&pl.mx);
    free(pl.url);
    pl.url = strdup(u);
    pl.start = start;
    atomic_store(&pl.finished, false);
    if (pl.on) atomic_store(&pl.stop, true);
    pthread_cond_signal(&pl_cv);
    pthread_mutex_unlock(&pl.mx);
}
static void url_stop(void)
{
    pthread_mutex_lock(&pl.mx);
    free(pl.url);
    pl.url = NULL;
    if (pl.on) atomic_store(&pl.stop, true);
    pthread_mutex_unlock(&pl.mx);
}

/* ---------------- what the library calls ---------------- */
static raop_t *raop;
static dnssd_t *dnssd;
static char password[64];
static atomic_int conns, missed;
static atomic_bool do_reset, keep_conns, reset_http, drop_conns;

static void flush_streams(void)
{
    q_flush(&vq);
    q_flush(&aq);
    atomic_store(&vreset, true);
    atomic_store(&areset, true);
    atomic_store(&offset, 0);
}
static void cb_conn_init(void *c) { (void)c; if (atomic_fetch_add(&conns, 1) == 0) say("connected 1"); }
static void cb_conn_destroy(void *c)
{
    (void)c;
    if (atomic_fetch_sub(&conns, 1) == 1) {
        flush_streams();
        if (atomic_load(&mode) == 1 || atomic_load(&mode) == 3) { set_mode(0); mg_close(); }
        say("connected 0");
    }
}
static void cb_feedback(void *c) { (void)c; atomic_store(&missed, 0); }
static void cb_conn_reset(void *c, int reason)
{
    (void)c;
    if (reason == 2) say("error this app's video cannot be played here");
    atomic_store(&reset_http, true);
    atomic_store(&do_reset, true);
}
static void cb_video_reset(void *c, reset_type_t t)
{
    (void)c;
    switch (t) {
    case RESET_TYPE_NOHOLD:
        raop_destroy_airplay_video(raop, -1);
        /* fall through */
    case RESET_TYPE_HLS_EOS:
        url_stop();
        break;
    case RESET_TYPE_RTP_TO_HLS_TEARDOWN:
        atomic_store(&keep_conns, true);
        /* fall through */
    case RESET_TYPE_RTP_SHUTDOWN:
        q_flush(&vq);
        atomic_store(&vreset, true);
        atomic_store(&offset, 0);
        if (atomic_load(&mode) == 1) { set_mode(0); mg_close(); }
        if (t == RESET_TYPE_RTP_SHUTDOWN) atomic_store(&drop_conns, true);
        break;
    case RESET_TYPE_HLS_SHUTDOWN:
        url_stop();
        raop_destroy_airplay_video(raop, -1);
        raop_remove_hls_connections(raop);
        atomic_store(&keep_conns, true);
        break;
    case RESET_TYPE_ON_VIDEO_PLAY:
        atomic_store(&keep_conns, true);
        break;
    }
    atomic_store(&do_reset, true);
}
static int64_t local_pts(uint64_t remote, uint64_t local)
{
    int64_t o = atomic_load(&offset);
    if (!o) {
        o = (int64_t)(local ? local : (uint64_t)now_ns()) - (int64_t)remote;
        atomic_store(&offset, o);
    }
    return (int64_t)remote + o;
}
static void cb_video(void *c, raop_ntp_t *n, video_decode_struct *d)
{
    (void)c; (void)n;
    if (atomic_load(&mode) == 2) return;
    if (d->is_h265) return;
    set_mode(1);
    bool key = false;
    for (int i = 0; i + 4 < d->data_len && i < 4096 && !key; i++)
        if (!d->data[i] && !d->data[i + 1] && d->data[i + 2] == 1) key = (d->data[i + 3] & 31) == 5 || (d->data[i + 3] & 31) == 7;
    /* the decoder far behind: on at the next key frame */
    if (vq.n > 90) { q_flush(&vq); atomic_store(&want_key, true); }
    if (atomic_load(&want_key)) { if (!key) return; atomic_store(&want_key, false); atomic_store(&vreset, true); }
    pkt_t *p = calloc(1, sizeof *p);
    p->data = malloc(d->data_len + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(p->data, d->data, d->data_len);
    memset(p->data + d->data_len, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    p->pts = local_pts(d->ntp_time_remote, d->ntp_time_local);
    q_push(&vq, p, d->data_len);
}
static void cb_audio(void *c, raop_ntp_t *n, audio_decode_struct *d)
{
    (void)c; (void)n;
    const int m = atomic_load(&mode);
    if (m == 2 || d->data_len <= 0) return;
    if (m == 0) set_mode(3);
    if (aq.n > 400) q_flush(&aq);
    pkt_t *p = calloc(1, sizeof *p);
    p->data = malloc(d->data_len + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(p->data, d->data, d->data_len);
    memset(p->data + d->data_len, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    p->pts = local_pts(d->ntp_time_remote, d->ntp_time_local);
    p->ct = d->ct;
    q_push(&aq, p, d->data_len);
}
static void cb_vpause(void *c) { (void)c; }
static void cb_vresume(void *c) { (void)c; }
static void cb_aflush(void *c) { (void)c; q_flush(&aq); atomic_store(&areset, true); }
static void cb_vflush(void *c) { (void)c; q_flush(&vq); }
static double cb_volume0(void *c) { (void)c; return 0.0; }
static void cb_volume(void *c, float v)
{
    (void)c;
    atomic_store(&gain, v <= -30.0f ? 0.0f : v >= 0.0f ? 1.0f : powf(10.0f, v / 20.0f));
}
static void cb_aformat(void *c, unsigned char *ct, unsigned short *spf, bool *screen, bool *media, uint64_t *fmt)
{
    (void)c; (void)spf; (void)media; (void)fmt;
    atomic_store(&aformat, *ct);
    q_flush(&aq);
    atomic_store(&areset, true);
    if (!*screen && atomic_load(&mode) == 0) set_mode(3);
}
static void cb_size(void *c, float *a, float *b, float *w, float *h) { (void)c; (void)a; (void)b; (void)w; (void)h; }
static void cb_bytes(void *c, const void *b, int n) { (void)c; (void)b; (void)n; }
static void cb_nothing(void *c) { (void)c; }
static void cb_progress(void *c, uint32_t *a, uint32_t *b, uint32_t *d) { (void)c; (void)a; (void)b; (void)d; }
static void cb_request(void *c, char *id, char *model, char *name, bool *ok) { (void)c; (void)id; (void)model; (void)name; *ok = true; }
static void cb_pin(void *c, char *pin) { (void)c; (void)pin; }
static void cb_register(void *c, const char *a, const char *b, const char *d) { (void)c; (void)a; (void)b; (void)d; }
static bool cb_registered(void *c, const char *pk) { (void)c; (void)pk; return true; }
static const char *cb_passwd(void *c, int *len) { (void)c; *len = (int)strlen(password); return password; }
static void cb_dacp(void *c, const char *a, const char *b) { (void)c; (void)a; (void)b; }
static int cb_codec(void *c, video_codec_t v) { (void)c; atomic_store(&vreset, true); return v == VIDEO_CODEC_H265 ? -1 : 0; }
static void cb_play(void *c, const char *url, const float start)
{
    url_play(url, start);
    cb_video_reset(c, RESET_TYPE_ON_VIDEO_PLAY);
}
static void cb_scrub(void *c, const float pos) { (void)c; pthread_mutex_lock(&pl.mx); pl.seek = pos; pthread_mutex_unlock(&pl.mx); }
static void cb_rate(void *c, const float r) { (void)c; pthread_mutex_lock(&pl.mx); pl.paused = r == 0.0f; pthread_mutex_unlock(&pl.mx); }
static void cb_stop(void *c) { (void)c; url_stop(); }
static float cb_remove(void *c)
{
    (void)c;
    pthread_mutex_lock(&pl.mx);
    pl.paused = true;
    const float p = (float)pl.pos;
    pthread_mutex_unlock(&pl.mx);
    return p;
}
static void cb_info(void *c, playback_info_t *i)
{
    (void)c;
    pthread_mutex_lock(&pl.mx);
    i->duration = pl.dur;
    i->position = pl.pos > 0 ? pl.pos : 0;
    i->seek_start = 0;
    i->seek_duration = pl.dur;
    i->rate = pl.paused ? 0.0f : 1.0f;
    i->playback_buffer_empty = false;
    i->playback_buffer_full = false;
    i->ready_to_play = true;
    i->playback_likely_to_keep_up = true;
    if (atomic_load(&pl.finished)) { i->duration = -1.0; i->position = -1.0; }
    pthread_mutex_unlock(&pl.mx);
}
/* the library's log for the AirPlay page, what one line says; not what comes many times a second */
static void cb_log(void *c, int level, const char *msg)
{
    (void)c;
    if (level <= LOGGER_INFO && !strstr(msg, "raop_rtp_mirror") && !strstr(msg, "nonce mismatch") && msg[0]) say("log %.100s", msg);
    if (strstr(msg, "nonce mismatch")) say("log the sign-in is an old one");
    if (level <= LOGGER_ERR || getenv("MGU_AIRPLAY_LOG")) fprintf(stderr, "%d %s\n", level, msg);
}

/* ---------------- name lookup: the uplink's name servers (the unit's resolv.conf is BMW's) ---------------- */
static char lease_file[128];
static int lease_dns(struct in_addr *out, int max)
{
    char b[4096];
    const int fd = lease_file[0] ? open(lease_file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) : -1;
    if (fd < 0) return 0;
    struct stat st;
    const ssize_t n = !fstat(fd, &st) && S_ISREG(st.st_mode) && !(st.st_mode & 022) ? read(fd, b, sizeof b - 1) : -1;
    close(fd);
    if (n <= 0) return 0;
    b[n] = 0;
    char *s = strstr(b, "\"dns\""), *e = s ? strchr(s, ']') : NULL;
    int k = 0;
    while (s && e && (s = strchr(s + 1, '"')) && s < e && k < max) {
        char ip[16];
        size_t i = 0;
        for (const char *p = s + 1; i < 15 && (isdigit((unsigned char)*p) || *p == '.'); p++) ip[i++] = *p;
        ip[i] = 0;
        if (i && inet_pton(AF_INET, ip, &out[k]) == 1 && (ntohl(out[k].s_addr) >> 24) != 127 && out[k].s_addr) k++;
    }
    return k;
}
static int ask(struct in_addr server, const char *name, struct in_addr *out, int max)
{
    uint8_t m[1500] = { (uint8_t)rand(), (uint8_t)rand(), 1, 0, 0, 1 };
    size_t n = 12;
    for (const char *p = name; *p;) {
        const char *dot = strchrnul(p, '.');
        const size_t l = dot - p;
        if (!l || l > 63 || n + l > 300) return 0;
        m[n++] = (uint8_t)l;
        memcpy(m + n, p, l);
        n += l;
        p = *dot ? dot + 1 : dot;
    }
    m[n++] = 0; m[n++] = 0; m[n++] = 1; m[n++] = 0; m[n++] = 1;
    const size_t qlen = n;
    const int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0) return 0;
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(53), .sin_addr = server };
    uint8_t r[1500];
    ssize_t k = -1;
    if (!connect(s, (struct sockaddr *)&a, sizeof a))
        for (int t = 0; t < 2 && k < 0; t++) {
            struct pollfd f = { s, POLLIN, 0 };
            if (send(s, m, qlen, 0) < 0 || poll(&f, 1, 2500) <= 0) continue;
            k = recv(s, r, sizeof r, 0);
            if (k < 12 || r[0] != m[0] || r[1] != m[1]) k = -1;
        }
    close(s);
    if (k < (ssize_t)qlen) return 0;
    int an = r[6] << 8 | r[7], got = 0;
    size_t o = qlen;
    while (an-- > 0 && o + 12 <= (size_t)k && got < max) {
        while (o < (size_t)k && r[o] && (r[o] & 0xc0) != 0xc0) o += r[o] + 1;
        o += o < (size_t)k && r[o] ? 2 : 1;
        if (o + 10 > (size_t)k) break;
        const int type = r[o] << 8 | r[o + 1], len = r[o + 8] << 8 | r[o + 9];
        o += 10;
        if (o + len > (size_t)k) break;
        if (type == 1 && len == 4) memcpy(&out[got++], r + o, 4);
        o += len;
    }
    return got;
}
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res)
{
    static int (*real)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
    if (!real) real = dlsym(RTLD_NEXT, "getaddrinfo");
    struct in6_addr t;
    struct in_addr dns[3], ip[4];
    int n;
    if (!node || !strcmp(node, "localhost") || inet_pton(AF_INET, node, &t) == 1 || strchr(node, ':') || !(n = lease_dns(dns, 3)))
        return real(node, service, hints, res);
    for (int i = 0; i < n; i++) {
        if (ask(dns[i], node, ip, 4) <= 0) continue;
        char s[INET_ADDRSTRLEN];
        struct addrinfo h = hints ? *hints : (struct addrinfo){ 0 };
        inet_ntop(AF_INET, &ip[0], s, sizeof s);
        h.ai_family = AF_INET;
        h.ai_flags = (h.ai_flags & ~AI_CANONNAME) | AI_NUMERICHOST;
        return real(s, service, &h, res);
    }
    return EAI_AGAIN;
}

/* ---------------- a crash: where (the module and the offset in it) ---------------- */
static void on_crash(int sig, siginfo_t *si, void *uc)
{
    (void)si;
    unsigned long ip = (unsigned long)((ucontext_t *)uc)->uc_mcontext.gregs[16 /* RIP */];
    char l[512], out[200];
    const char *name = "?";
    unsigned long off = ip;
    FILE *m = fopen("/proc/self/maps", "r");
    while (m && fgets(l, sizeof l, m)) {
        unsigned long a, b, o;
        if (sscanf(l, "%lx-%lx %*s %lx", &a, &b, &o) != 3 || ip < a || ip >= b) continue;
        l[strcspn(l, "\n")] = 0;
        name = strrchr(l, '/') ? strrchr(l, '/') + 1 : "?";
        off = ip - a + o;
        break;
    }
    const int n = snprintf(out, sizeof out, "log crash: signal %d in %.60s +0x%lx\n", sig, name, off);
    if (write(1, out, n) < 0) { /* gone */ }
    signal(sig, SIG_DFL);
    raise(sig);
}

/* ---------------- main ---------------- */
static atomic_bool quit;
static void on_signal(int s) { (void)s; atomic_store(&quit, true); }

static int features(bool hls)
{
    /* as UxPlay: mirroring, sound, legacy pairing; video by URL with hls */
    static const int on[] = { 1, 2, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 27, 28, 30 };
    for (int i = 0; i < 32; i++) dnssd_set_airplay_features(dnssd, i, 0);
    for (size_t i = 0; i < sizeof on / sizeof *on; i++) dnssd_set_airplay_features(dnssd, on[i], 1);
    dnssd_set_airplay_features(dnssd, 0, hls);
    dnssd_set_airplay_features(dnssd, 4, hls);
    return 0;
}

/* ---------------- `mgu-airplay sound`: a film's sound ----------------
 * stdin: add FILE (AAC in ADTS, the next piece; removed once read), pause, play; its end: quit.
 * stdout: playing (the sink took it), time MS (heard so far), error TEXT. */
static struct { pthread_mutex_t mx; char *f[4096]; unsigned in, out; bool paused, quit; } so = { .mx = PTHREAD_MUTEX_INITIALIZER };
static void *sound_in(void *arg)
{
    (void)arg;
    char l[512];
    while (fgets(l, sizeof l, stdin)) {
        l[strcspn(l, "\r\n")] = 0;
        pthread_mutex_lock(&so.mx);
        if (!strncmp(l, "add ", 4)) { if (so.in - so.out < 4096) so.f[so.in++ % 4096] = strdup(l + 4); }
        else if (!strcmp(l, "pause")) so.paused = true;
        else if (!strcmp(l, "play")) so.paused = false;
        pthread_mutex_unlock(&so.mx);
    }
    pthread_mutex_lock(&so.mx);
    so.quit = true;
    pthread_mutex_unlock(&so.mx);
    return NULL;
}
static int64_t so_sent, so_said;            /* samples written; when the time was told */
static bool so_on;
static void sound_time(void)
{
    if (!so_on || now_ns() - so_said < 250 * MS) return;
    so_said = now_ns();
    const int64_t t = so_sent * 1000 / RATE - snd_delay() / MS;
    say("time %lld", (long long)(t > 0 ? t : 0));
}
/* waits while paused; false: quit */
static bool sound_go(void)
{
    for (bool held = false;;) {
        pthread_mutex_lock(&so.mx);
        const bool p = so.paused, q = so.quit;
        pthread_mutex_unlock(&so.mx);
        if (q) return false;
        if (!p) return true;
        if (!held) { held = true; so_sent -= snd_delay() * RATE / 1000000000LL; snd_down(); }
        nap(20 * MS);
    }
}
static int sound_main(void)
{
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    signal(SIGPIPE, SIG_IGN);
    av_log_set_level(AV_LOG_QUIET);
    pthread_t t;
    pthread_create(&t, NULL, sound_in, NULL);
    const AVCodec *c = avcodec_find_decoder(AV_CODEC_ID_AAC);
    AVCodecContext *x = avcodec_alloc_context3(c);
    AVCodecParserContext *ps = av_parser_init(AV_CODEC_ID_AAC);
    AVPacket *k = av_packet_alloc();
    AVFrame *f = av_frame_alloc();
    SwrContext *swr = NULL;
    int16_t *buf = NULL;
    int cap = 0;
    if (!ps || avcodec_open2(x, c, NULL) < 0) { say("error no AAC decoder"); return 1; }
    while (sound_go()) {
        pthread_mutex_lock(&so.mx);
        char *name = so.out != so.in ? so.f[so.out++ % 4096] : NULL;
        pthread_mutex_unlock(&so.mx);
        if (!name) { sound_time(); nap(20 * MS); continue; }
        uint8_t *d = NULL;
        long n = 0;
        FILE *in = fopen(name, "rb");
        if (in) {
            fseek(in, 0, SEEK_END);
            n = ftell(in);
            rewind(in);
            if (n > 0 && n < (64 << 20) && (d = calloc(1, (size_t)n + AV_INPUT_BUFFER_PADDING_SIZE))) n = (long)fread(d, 1, (size_t)n, in);
            fclose(in);
        }
        if (!d) say("error a piece of the sound is not readable (%d)", errno);
        unlink(name);
        free(name);
        for (long at = 0; d && at < n;) {
            uint8_t *o = NULL;
            int ol = 0;
            const int used = av_parser_parse2(ps, x, &o, &ol, d + at, (int)(n - at), AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
            if (used < 0) break;
            at += used;
            if (!ol) { if (!used) break; continue; }
            k->data = o; k->size = ol;
            if (avcodec_send_packet(x, k) < 0) continue;
            while (avcodec_receive_frame(x, f) >= 0) {
                const int m = to_s16(&swr, f, &buf, &cap);
                if (m <= 0) continue;
                for (;;) {
                    if (!sound_go()) _exit(0);
                    if (snd_write(buf, m)) break;
                    nap(200 * MS);
                }
                if (!so_on) { so_on = true; say("playing"); }
                so_sent += m;
                sound_time();
            }
        }
        free(d);
    }
    snd_down();
    _exit(0);
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "sound")) return sound_main();
    char name[64] = "BMW MGU", mac[18] = "", key[160] = "";
    const char *test_url = NULL;
    int o, port = 7110;
    bool hls = false;
    while ((o = getopt(argc, argv, "n:m:w:f:p:ul:t:k:x:")) != -1) switch (o) {
        case 'n': snprintf(name, sizeof name, "%s", optarg); break;
        case 'm': snprintf(mac, sizeof mac, "%s", optarg); break;
        case 'w': snprintf(password, sizeof password, "%s", optarg); break;
        case 'f': snprintf(frame_path, sizeof frame_path, "%s", optarg); break;
        case 'p': port = atoi(optarg); break;
        case 'u': hls = true; break;
        case 'l': snprintf(lease_file, sizeof lease_file, "%s", optarg); break;
        case 't': snprintf(tmp_dir, sizeof tmp_dir, "%s", optarg); break;
        case 'k': snprintf(key, sizeof key, "%s", optarg); break;
        case 'x': test_url = optarg; break;             /* (tests: plays this URL at once) */
        default: return 64;
    }
    unsigned hw[6];
    char hwb[6];
    if (sscanf(mac, "%x:%x:%x:%x:%x:%x", &hw[0], &hw[1], &hw[2], &hw[3], &hw[4], &hw[5]) != 6 || !password[0] || !frame_path[0] || port < 1024 || port > 65000) return 64;
    for (int i = 0; i < 6; i++) hwb[i] = (char)hw[i];
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    struct sigaction ca = { .sa_sigaction = on_crash, .sa_flags = SA_SIGINFO | SA_RESETHAND };
    sigaction(SIGSEGV, &ca, NULL);
    sigaction(SIGABRT, &ca, NULL);
    sigaction(SIGFPE, &ca, NULL);
    sigaction(SIGILL, &ca, NULL);
    sigaction(SIGBUS, &ca, NULL);
    srand((unsigned)now_ns());
    av_log_set_level(getenv("MGU_AIRPLAY_LOG") ? AV_LOG_INFO : AV_LOG_QUIET);
    avformat_network_init();
    q_init(&vq);
    q_init(&aq);

    int err = 0;
    dnssd = dnssd_init(name, (int)strlen(name), hwb, 6, &err, 2 /* a password */);
    if (!dnssd || err) { say("error mDNS does not start (%d)", err); return 1; }
    features(hls);
    raop_callbacks_t cb = {
        .conn_init = cb_conn_init, .conn_destroy = cb_conn_destroy, .conn_reset = cb_conn_reset, .conn_feedback = cb_feedback,
        .audio_process = cb_audio, .video_process = cb_video, .audio_flush = cb_aflush, .video_flush = cb_vflush,
        .video_pause = cb_vpause, .video_resume = cb_vresume, .audio_set_client_volume = cb_volume0, .audio_set_volume = cb_volume,
        .audio_get_format = cb_aformat, .video_report_size = cb_size, .audio_set_metadata = cb_bytes, .audio_set_coverart = cb_bytes,
        .audio_stop_coverart_rendering = cb_nothing, .audio_set_progress = cb_progress, .report_client_request = cb_request,
        .display_pin = cb_pin, .register_client = cb_register, .check_register = cb_registered, .passwd = cb_passwd, .export_dacp = cb_dacp,
        .video_reset = cb_video_reset, .video_set_codec = cb_codec, .on_video_play = cb_play, .on_video_scrub = cb_scrub, .on_video_rate = cb_rate,
        .on_video_stop = cb_stop, .on_video_playlist_remove = cb_remove, .on_video_acquire_playback_info = cb_info,
    };
    raop = raop_init(&cb);
    if (!raop) return 1;
    raop_set_log_callback(raop, cb_log, NULL);
    raop_set_log_level(raop, getenv("MGU_AIRPLAY_LOG") ? LOGGER_DEBUG : LOGGER_INFO);
    if (raop_init2(raop, 1 /* a new phone takes over */, mac, key)) { say("error the receiver does not start"); return 1; }
    raop_set_plist(raop, "width", 1280);
    raop_set_plist(raop, "height", 720);
    raop_set_plist(raop, "refreshRate", 30);
    raop_set_plist(raop, "maxFPS", 30);
    if (hls) raop_set_plist(raop, "hls", 1);
    unsigned short tcp[2] = { port + 1, port }, udp[3] = { port, port + 1, port + 2 };
    raop_set_tcp_ports(raop, tcp);
    raop_set_udp_ports(raop, udp);
    unsigned short rp = raop_get_port(raop);
    if (!rp) rp = port;
    if (raop_start_httpd(raop, &rp) < 0) { say("error port %d is in use", port); return 1; }
    raop_set_port(raop, rp);
    raop_set_dnssd(raop, dnssd);
    if ((err = dnssd_register_raop(dnssd, rp)) || (err = dnssd_register_airplay(dnssd, rp))) say("error the phone cannot find the car (mDNS %d)", err);

    pthread_t t;
    pthread_create(&t, NULL, mirror_video, NULL);
    pthread_create(&t, NULL, mirror_audio, NULL);
    pthread_create(&t, NULL, player, NULL);
    say("ready %d", rp);
    if (test_url) url_play(test_url, 0);
    char in[256];
    size_t have = 0;
    int64_t tick = now_ns();
    while (!atomic_load(&quit)) {
        struct pollfd f = { 0, POLLIN, 0 };
        if (poll(&f, 1, 100) > 0) {
            const ssize_t k = read(0, in + have, sizeof in - 1 - have);
            if (k <= 0) break;                                                /* (whoever started this is gone) */
            in[have += k] = 0;
            char *nl;
            while ((nl = strchr(in, '\n'))) {
                int w, h;
                *nl = 0;
                if (sscanf(in, "size %d %d", &w, &h) == 2 && w >= 16 && h >= 16 && w <= 2048 && h <= 2048) { atomic_store(&view_w, w); atomic_store(&view_h, h); }
                else if (!strcmp(in, "end") && atomic_load(&mode) == 2) { url_stop(); atomic_store(&pl.finished, true); }
                have -= nl + 1 - in;
                memmove(in, nl + 1, have + 1);
            }
            if (have >= sizeof in - 1) have = 0;
        }
        /* the library asks for a reset from its own threads: done here */
        if (atomic_exchange(&do_reset, false)) {
            const bool keep = atomic_exchange(&keep_conns, false), drop = atomic_exchange(&drop_conns, false);
            if (atomic_exchange(&reset_http, false)) {
                raop_stop_httpd(raop);
                flush_streams();
                if (atomic_load(&mode) == 1 || atomic_load(&mode) == 3) { set_mode(0); mg_close(); }
                unsigned short p2 = raop_get_port(raop);
                raop_start_httpd(raop, &p2);
                raop_set_port(raop, p2);
            } else if (drop && !keep) raop_remove_known_connections(raop);
        }
        /* a phone that went without a word (its WLAN): 15 s without its heartbeat (it beats while it plays, not
         * while somebody types the code: that took longer, and the code was asked for again) */
        if (now_ns() - tick > 1000 * MS) {
            tick = now_ns();
            if (!atomic_load(&conns) || atomic_load(&mode) == 2 || atomic_load(&mode) == 0) atomic_store(&missed, 0);
            else if (atomic_fetch_add(&missed, 1) > 15) { atomic_store(&missed, 0); atomic_store(&reset_http, true); atomic_store(&do_reset, true); }
        }
    }
    dnssd_unregister_raop(dnssd);
    dnssd_unregister_airplay(dnssd);
    if (mg.fd >= 0) unlink(frame_path);
    _exit(0);                                     /* (the library's threads: the system closes their sockets) */
}
