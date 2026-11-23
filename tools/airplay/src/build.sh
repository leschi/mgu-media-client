#!/bin/bash
# build.sh - builds ../prebuilt/mgu-airplay and mdns-route on any x86-64 Linux (bash, curl, git, make, perl, python3, strip):
#   ./build.sh [work folder]
# The compiler is zig, for the unit's glibc (2.27). Everything is fetched at the version named here.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); A=${1:-$HOME/mgu-airplay-build}; mkdir -p "$A/src" "$A/bin" "$A/out" "$HERE/../prebuilt"; cd "$A"; A=$PWD
get() { [ -f "src/$2" ] || curl -fsSL -o "src/$2" "$1"; echo "$3  src/$2" | sha256sum -c --quiet; }
get https://github.com/openssl/openssl/releases/download/openssl-3.0.15/openssl-3.0.15.tar.gz openssl.tgz 23c666d0edf20f14249b3d8f0368acaee9ab585b09e1de82107c66e1f3ec9533
get https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n7.1.1.tar.gz ffmpeg.tgz f117507dc501f2a6c11f9241d8d0c3213846cfad91764361af37befd6b6c523d
get https://github.com/libimobiledevice/libplist/releases/download/2.6.0/libplist-2.6.0.tar.bz2 plist.tbz 67be9ee3169366589c92dc7c22809b90f51911dd9de22520c39c9a64fb047c9c
get https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/nasm-2.16.03.tar.gz nasm.tgz 5bc940dd8a4245686976a8f7e96ba9340a0915f2d5b88356874890e207bdb581
[ -d zig ] || { python3 -m pip download -q ziglang==0.13.0 --no-deps -d . && python3 -m zipfile -e ziglang-*.whl zt && mv zt/ziglang zig && chmod +x zig/zig; }
[ -d src/UxPlay ] || git clone -q https://github.com/FDH2/UxPlay src/UxPlay; git -C src/UxPlay checkout -q df67c212a433cf6dda3676dd40c097900d24e645
for f in openssl.tgz ffmpeg.tgz nasm.tgz; do tar xzf src/$f -C src --skip-old-files; done; python3 -c "import tarfile;tarfile.open('src/plist.tbz').extractall('src')"
mkdir -p src/mdns; for f in dnssd_clientstub.c dnssd_clientlib.c dnssd_ipc.c dnssd_ipc.h dns_sd.h; do [ -f src/mdns/$f ] || curl -fsSL -o src/mdns/$f https://raw.githubusercontent.com/apple-oss-distributions/mDNSResponder/67390998bac34f1e203b0ad7fea72f7e2063066e/mDNSShared/$f; done
for t in cc c++; do printf '#!/bin/sh\nexec %s/zig/zig %s -target x86_64-linux-gnu.2.27 "$@"\n' "$A" $t > bin/z$t; done
for t in ar ranlib; do printf '#!/bin/sh\nexec %s/zig/zig %s "$@"\n' "$A" $t > bin/z$t; done
chmod +x bin/*; export PATH=$A/bin:$PATH
[ -x bin/nasm ] || (cd src/nasm-2.16.03 && ./configure -q && make -j8 nasm && cp nasm "$A/bin/")
[ -f out/lib/libssl.a ] || (cd src/openssl-3.0.15 && CC=zcc AR=zar RANLIB=zranlib ./Configure linux-x86_64 no-shared no-tests no-module no-engine no-dso no-legacy no-comp no-afalgeng no-ui-console --prefix="$A/out" --libdir=lib --openssldir=/etc/ssl -fPIC -O2 && make -j8 build_libs && make install_dev)
[ -f out/lib/libplist-2.0.a ] || (cd src/libplist-2.6.0 && CC=zcc CXX=zc++ AR=zar RANLIB=zranlib ./configure -q --host=x86_64-linux-gnu --prefix="$A/out" --enable-static --disable-shared --without-cython --without-tools && make -C libcnary && make -C src && make -C src install && make -C include install)
[ -f out/lib/libavformat.a ] || (cd src/FFmpeg-n7.1.1 && PKG_CONFIG_PATH=$A/out/lib/pkgconfig ./configure --prefix="$A/out" --cc=zcc --cxx=zc++ --ar=zar --ranlib=zranlib --nm=nm --enable-cross-compile --target-os=linux --arch=x86_64 --x86asmexe=nasm --pkg-config=pkg-config --pkg-config-flags=--static \
  --disable-everything --disable-programs --disable-doc --disable-autodetect --disable-avdevice --disable-avfilter --disable-postproc --enable-pic --enable-static --disable-shared --disable-debug --enable-version3 --enable-openssl --enable-network \
  --enable-decoder=h264,hevc,aac,alac,mp3 --enable-parser=h264,hevc,aac,mpegaudio --enable-demuxer=hls,mpegts,mov,aac,mp3,h264 --enable-protocol=http,https,tcp,tls,crypto,file,data --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb \
  --extra-cflags="-I$A/out/include -O2" --extra-ldflags="-L$A/out/lib" --extra-libs="-lpthread -ldl -lm" && sed -i 's/#define HAVE_SYSCTL 1/#define HAVE_SYSCTL 0/' config.h && make -j8 && make install)
O=$(mktemp -d "$A/obj.XXXX"); cp -r src/UxPlay/lib "$O/ux"; cp src/mdns/* "$O/ux/"
F="-O2 -fPIC -ffunction-sections -fdata-sections -DSTANDALONE -D__STDC_CONSTANT_MACROS -D__STDC_LIMIT_MACROS -DTARGET_POSIX -D_LINUX -D_GNU_SOURCE -D_REENTRANT -DNOHOLD -DNOT_HAVE_SA_LEN -DHAVE_LINUX -DUSES_NETLINK -DPLIST_210 -DOPENSSL_API_COMPAT=0x10101000L -I$O/ux -I$O/ux/playfair -I$O/ux/llhttp -Iout/include -fno-sanitize=all -w"
for c in "$O"/ux/*.c "$O"/ux/playfair/*.c "$O"/ux/llhttp/*.c; do zcc $F -c "$c" -o "$O/$(echo "${c#$O/}" | tr / _).o"; done
zcc -O2 -fno-sanitize=all -Wall -Wextra -Wno-implicit-fallthrough -I"$O/ux" -Iout/include -c "$HERE/receiver.c" -o "$O/receiver.o"
# (the unit has its loader in /lib, no /lib64: with the default one the program "is not there", ENOENT)
zcc -O2 -s -Wl,--gc-sections -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -o "$HERE/../prebuilt/mgu-airplay" "$O"/*.o -Lout/lib -lavformat -lavcodec -lswresample -lswscale -lavutil -lssl -lcrypto -lplist-2.0 -lpthread -ldl -lm
zig/zig cc -target x86_64-linux-musl -static -O2 -s -fno-sanitize=all -o "$HERE/../prebuilt/mdns-route" "$HERE/mdns_route.c"
ls -la "$HERE/../prebuilt"
