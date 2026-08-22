#!/bin/sh
set -eu

exec env LD_PRELOAD=/usr/local/lib/rtk-compat.so /usr/local/libexec/rtk "$@"
