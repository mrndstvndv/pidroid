# Vendors Lucide icons into www/icons.js (run from the app root).
# .icons/*.svg come from https://unpkg.com/lucide-static@0.544.0/icons/<name>.svg
# .icons/tail.js holds the helper API that follows the generated map.
{
  echo '// Lucide icons (https://lucide.dev) — ISC License, (c) Lucide Contributors.'
  echo '// Artwork vendored from lucide-static v0.544.0 so the UI needs no network.'
  echo '// Usage: icon("send", 20) → inline <svg>; in HTML: <span data-icon="send"></span>'
  echo 'const LUCIDE = {'
  first=1
  for f in .icons/*.svg; do
    n=$(basename "$f" .svg)
    inner=$(awk 'BEGIN{s=0} /<!-- @license/{next} /^\>/{s=1;next} /<\/svg>/{s=0} s{printf "%s", $0}' "$f" | tr -s ' \t\n' ' ' | sed 's/^ //; s/ $//')
    if [ -z "$inner" ]; then echo "EMPTY $n" >&2; continue; fi
    if [ $first -eq 0 ]; then echo ','; fi
    first=0
    printf '  "%s": `%s`' "$n" "$inner"
  done
  echo ''
  echo '};'
  echo ''
  cat .icons/tail.js
} > www/icons.js
