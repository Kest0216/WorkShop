#!/bin/sh
# A "login shell" whose rc files are noisy: banners, binary bytes, fake markers, 200 KB of text and a
# background program that keeps the output pipe open. Then the real zsh does the lookup.
printf 'Welcome to a very chatty shell\n__WS_PATH__/evil/bin\n__WS_EXEC__/evil/node\n__WS_END__ (a fake end, before the real start)\n'
printf '\001\002\377\376 binary junk \033[31mred\033[0m\n'
i=0; while [ $i -lt 2000 ]; do printf 'banner line %s ........................................................................................\n' "$i"; i=$((i+1)); done
( sleep 30.4242 ) &
exec /bin/zsh "$@"
