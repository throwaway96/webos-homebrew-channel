#!/usr/bin/env bash

# Builds a dropbear sshd/scp binary and rsync to be bundled in homebrew channel package.
#
# Usage, from repository root directory:
#
#   docker run --rm -ti -v /tmp/opt:/opt -v $PWD:/app ubuntu:20.04 /app/tools/build-binaries.sh
#

set -ex

NDK_PATH="${NDK_PATH:-/opt/ndk}"
TARGET_DIR="${TARGET_DIR:-$(dirname $0)/../services/bin}"

apt-get update && apt-get install -y --no-install-recommends wget ca-certificates file make perl

function install_ndk() {
    # Install NDK
    [[ -f "${NDK_PATH}/environment-setup" ]] && return
    wget https://github.com/openlgtv/buildroot-nc4/releases/download/webos-2974f83/arm-webos-linux-gnueabi_sdk-buildroot.tar.gz -O /tmp/webos-sdk.tgz
    sha256sum -c <<< '94a2eb89750299be7d380df37cd74e37c76233934a9980722ec20065943ebd2d /tmp/webos-sdk.tgz'
    mkdir -p "$NDK_PATH"
    tar xvf /tmp/webos-sdk.tgz -C "${NDK_PATH}" --strip-components=1
    ${NDK_PATH}/relocate-sdk.sh
    rm /tmp/webos-sdk.tgz
}

function download() {
    # Download and checksum a tarball
    local src="/tmp/$1.tar.gz"
    local srcdir="/opt/$1-src"
    rm -rf "$srcdir"
    mkdir -p "$srcdir"
    wget "$2" -O "$src"
    printf "$3 $src" | sha256sum -c
    tar xvf "$src" -C "$srcdir" --strip-components=1
}

function build_dropbear() {
   . "${NDK_PATH}/environment-setup"
    cd /opt/dropbear-src
    cat <<EOF >localoptions.h
#define DSS_PRIV_FILENAME "/var/lib/webosbrew/sshd/dropbear_dss_host_key"
#define RSA_PRIV_FILENAME "/var/lib/webosbrew/sshd/dropbear_rsa_host_key"
#define ECDSA_PRIV_FILENAME "/var/lib/webosbrew/sshd/dropbear_ecdsa_host_key"
#define ED25519_PRIV_FILENAME "/var/lib/webosbrew/sshd/dropbear_ed25519_host_key"
#define DEFAULT_PATH "/home/root/.local/bin:/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/bin:/usr/bin:/bin"
#define DROPBEAR_SFTPSERVER 1
#define SFTPSERVER_PATH "/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/bin/sftp-server"
EOF
    autoconf
    autoheader
    ./configure --host arm-webos-linux-gnueabi --disable-lastlog
    PROGRAMS="dropbear scp"
    make PROGRAMS="${PROGRAMS}" -j$(nproc --all)
    arm-webos-linux-gnueabi-strip ${PROGRAMS}
    cp ${PROGRAMS} "${TARGET_DIR}"
}

function build_rsync() {
    . "${NDK_PATH}/environment-setup"
    cd /opt/rsync-src
    ./configure --host arm-webos-linux-gnueabi \
        --disable-simd --disable-debug --with-included-popt=yes --with-included-zlib=yes \
        --disable-lz4 --disable-zstd --disable-xxhash --disable-md2man --disable-acl-support
    make -j$(nproc --all)
    arm-webos-linux-gnueabi-strip rsync
    cp rsync "${TARGET_DIR}"
}

function build_sftp() {
	. "${NDK_PATH}/environment-setup"
	cd /opt/openssh-src
	./configure --host=arm-webos-linux-gnueabi --without-openssl
	make sftp-server -j$(nproc --all)
	arm-webos-linux-gnueabi-strip sftp-server
	cp sftp-server "${TARGET_DIR}"
}

install_ndk &
download 'dropbear' 'https://github.com/mkj/dropbear/archive/refs/tags/DROPBEAR_2022.83.tar.gz' 'e02c5c36eb53bfcd3f417c6e40703a50ec790a1a772269ea156a2ccef14998d2' &
download 'rsync'    'https://github.com/WayneD/rsync/archive/refs/tags/v3.2.7.tar.gz'           '4f2a350baa93dc666078b84bc300767a77789ca12f0dec3cb4b3024971f8ef47' &
download 'openssh'  'https://ftp.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-9.1p1.tar.gz' '19f85009c7e3e23787f0236fbb1578392ab4d4bf9f8ec5fe6bc1cd7e8bfdd288' &
wait

build_dropbear &
build_rsync &
build_sftp &
wait
