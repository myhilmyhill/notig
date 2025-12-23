#!/bin/sh

raw_path=${PATH_INFO:-}
# Percent-decode without external deps beyond POSIX sh + sed + printf.
decoded_path=$(printf '%b' "$(printf '%s' "$raw_path" | sed 's/+/ /g;s/%/\\x/g')")
path=$(printf '%s' "$decoded_path" | sed 's|^/||')
path=${path#blobs/}
path=$(printf '%s' "$path" | sed 's|\.\.||g;s|\\||g')

if [ -z "$path" ]; then
  echo "Status: 400 Bad Request"
  echo "Content-Type: text/plain"
  echo
  echo "missing path"
  exit 0
fi

file="/data/blobs/$path"
dir=$(dirname "$file")

guess_mime() {
  case "$1" in
    *.png) echo "image/png" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.gif) echo "image/gif" ;;
    *.webp) echo "image/webp" ;;
    *.svg) echo "image/svg+xml" ;;
    *.txt|*.md) echo "text/plain; charset=utf-8" ;;
    *.json) echo "application/json" ;;
    *) echo "application/octet-stream" ;;
  esac
}

case "${REQUEST_METHOD:-}" in
  POST)
    mkdir -p "$dir"
    tmp="${file}.tmp.$$"
    cat > "$tmp"
    mv "$tmp" "$file"
    echo "Status: 201 Created"
    echo "Content-Type: text/plain"
    echo "Location: /blobs/$path"
    echo
    echo "/blobs/$path"
    ;;

  *)
    echo "Status: 405 Method Not Allowed"
    echo "Content-Type: text/plain"
    echo
    echo "method not allowed"
    ;;
esac
