#!/bin/bash
# FAKE limactl used only by protocol tests. It is NOT a VM: "instances" are plain directories under $LIMA_HOME and
# guest commands run on the host. Receipts produced with it are protocol evidence, never live VM evidence.
# Faults are selected by lines in $LIMA_HOME/fault: version create start egress user sudo copy list leak
# Protocol: limactl 2.x as driven by src/runner/lima.ts (start --plain, ip-route egress cut, unprivileged workload user via
# `sudo -n -u hcrun` (dropped here), copy, shell, list, delete).
set -u
H="${LIMA_HOME:-$HOME/.lima}"
mkdir -p "$H/instances"
printf '%s\n' "$*" >> "$H/calls.log"
fault() { [ -f "$H/fault" ] && grep -qx "$1" "$H/fault"; }
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  --version)
    fault version && exit 3
    echo "limactl version 0.0.0-fake-protocol-test"
    exit 0
    ;;
  create)
    fault create && { echo "fake create failure" >&2; exit 1; }
    name=""
    for a in "$@"; do case "$a" in --name=*) name="${a#--name=}" ;; esac; done
    [ -n "$name" ] || exit 2
    mkdir -p "$H/instances/$name/root"
    exit 0
    ;;
  start)
    fault start && { echo "fake start failure" >&2; exit 1; }
    name=""
    for a in "$@"; do case "$a" in --name=*) name="${a#--name=}" ;; esac; done
    [ -n "$name" ] || exit 2
    mkdir -p "$H/instances/$name/root"
    exit 0
    ;;
  copy)
    fault copy && exit 1
    src=""; dst=""
    for a in "$@"; do case "$a" in -r) ;; *:*) dst="$a" ;; *) src="$a" ;; esac; done
    name="${dst%%:*}"
    mkdir -p "$H/instances/$name/root"
    cp -R "$src" "$H/instances/$name/root/"
    exit 0
    ;;
  shell)
    workdir=""
    if [ "${1:-}" = "--workdir" ]; then workdir="$2"; shift 2; fi
    name="$1"; shift
    [ "${1:-}" = "--" ] && shift
    # the provider reads guest files with `sudo -n`; the fake has no privilege model, so it simply drops the prefix
    [ "${1:-}" = "sudo" ] && shift 2
    root="$H/instances/$name/root"
    [ -d "$root" ] || { echo "no such instance" >&2; exit 5; }
    # $1=sh $2=-c $3=script ...
    script="$3"
    case "$script" in
      # unprivileged workload user setup: faults "user" (cannot create it) and "sudo" (the workload user could still use sudo)
      *adduser*) fault user && exit 51; fault sudo && exit 52; fault route_unsupported && exit 54; exit 0 ;;
      *"ip route"*)
        fault ip_missing && exit 40
        # Execute the actual provider cut in a subshell with inert protocol ip/sudo functions.
        # No host route commands execute. Default models observed Alpine iproute2; never live evidence.
        ip() {
          case "$*" in
            "route del default"|"-6 route del default") return 0 ;;
            "route show default"|"-6 route show default")
              fault route_query && return 1
              fault egress && echo "default via synthetic"
              return 0 ;;
            "route get 192.0.2.1")
              fault route_get_success && { echo "synthetic route exists"; return 0; }
              fault route_get && { echo "unsupported query" >&2; return 2; }
              fault route_get_extra && { printf '%s\n' "RTNETLINK answers: Network unreachable" "extra error" >&2; return 2; }
              if fault route_get_busybox || fault route_get_busybox_wrong_status; then
                echo "ip: RTNETLINK answers: Network unreachable" >&2
              else echo "RTNETLINK answers: Network unreachable" >&2; fi
              if fault route_get_wrong_status || fault route_get_busybox_wrong_status; then return 1; fi
              return 2 ;;
            *) echo "unsupported protocol ip command" >&2; return 64 ;;
          esac
        }
        sudo() { [ "${1:-}" = "-n" ] && shift; "$@"; }
        (eval "$script")
        exit $? ;;

    esac
    if [ "${4:-}" = "hc-read" ]; then
      p="${5/\/tmp\/hcsbx/$root}"
      exec sh -c "$script" hc-read "$p" "${6:-0}"
    fi
    mapped="$(printf '%s' "$script" | sed -e "s#/tmp/hcsbx#$root#g" -e "s#'timeout' '-k' '2' '[0-9]*' ##" -e "s#'sudo' '-n' '-u' 'hcrun' ##" -e "s#PATH=/usr/local/bin:/usr/bin:/bin:/sbin#PATH=$H/bin:/usr/bin:/bin#")"
    wd="${workdir/\/tmp\/hcsbx/$root}"
    [ -n "$wd" ] && cd "$wd"
    exec sh -c "$mapped"
    ;;
  delete)
    fault leak && exit 0
    for a in "$@"; do case "$a" in --force) ;; *) rm -rf "$H/instances/$a" ;; esac; done
    exit 0
    ;;
  list)
    fault list && exit 1
    ls "$H/instances"
    exit 0
    ;;
  *)
    echo "fake limactl: unsupported command $cmd" >&2
    exit 64
    ;;
esac
